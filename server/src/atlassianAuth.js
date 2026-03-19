import { createHash, randomBytes } from "node:crypto";

import { config } from "./config.js";
import { buildError } from "./http.js";

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  return { codeVerifier, codeChallenge };
}

function logAuthDebug(event, details = {}) {
  if (!config.atlassian.debugAuth) {
    return;
  }

  console.log(`[atlassian-oauth] ${event}`, details);
}

function normalizeTokenPayload(payload) {
  if (!payload.access_token) {
    throw buildError("OAuth token response did not include access_token.");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    tokenType: payload.token_type ?? "Bearer",
    scope: payload.scope ?? null,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

async function requestToken(body) {
  logAuthDebug("token_request", {
    tokenUrl: config.atlassian.tokenUrl,
    grantType: body.grant_type ?? null,
    hasCode: Boolean(body.code),
    hasCodeVerifier: Boolean(body.code_verifier),
    hasRefreshToken: Boolean(body.refresh_token),
    hasClientSecret: Boolean(body.client_secret),
  });

  const response = await fetch(config.atlassian.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries(body).filter(
          ([, value]) => value !== undefined && value !== null && value !== "",
        ),
      ),
    ),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    logAuthDebug("token_request_failed", {
      status: response.status,
      payload,
    });

    throw buildError("OAuth token request failed.", response.status, payload);
  }

  logAuthDebug("token_request_succeeded", {
    status: response.status,
    hasAccessToken: Boolean(payload?.access_token),
    hasRefreshToken: Boolean(payload?.refresh_token),
    expiresIn: payload?.expires_in ?? null,
    scope: payload?.scope ?? null,
  });

  return normalizeTokenPayload(payload);
}

export async function buildAtlassianAuthorizeUrl(session) {
  const state = base64Url(randomBytes(24));
  const { codeVerifier, codeChallenge } = createPkcePair();

  session.oauth = {
    state,
    codeVerifier,
    createdAt: Date.now(),
  };

  const query = new URLSearchParams({
    audience: config.atlassian.oauthAudience,
    client_id: config.atlassian.clientId,
    scope: config.atlassian.scopes.join(" "),
    redirect_uri: config.atlassian.redirectUri,
    state,
    response_type: "code",
    prompt: config.atlassian.scopes.includes("offline_access")
      ? "consent"
      : "login",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (!config.atlassian.oauthAudience) {
    query.delete("audience");
  }

  logAuthDebug("authorize_url_created", {
    authorizeUrl: config.atlassian.authorizeUrl,
    redirectUri: config.atlassian.redirectUri,
    scopeCount: config.atlassian.scopes.length,
    includesOfflineAccess: config.atlassian.scopes.includes("offline_access"),
  });

  return `${config.atlassian.authorizeUrl}?${query.toString()}`;
}

export async function exchangeAuthorizationCode(session, code, returnedState) {
  if (!session.oauth?.state || !session.oauth?.codeVerifier) {
    throw buildError("Missing OAuth session state.", 400);
  }

  if (returnedState !== session.oauth.state) {
    throw buildError("OAuth state validation failed.", 400);
  }

  const token = await requestToken({
    grant_type: "authorization_code",
    client_id: config.atlassian.clientId,
    client_secret: config.atlassian.clientSecret,
    code,
    redirect_uri: config.atlassian.redirectUri,
    code_verifier: session.oauth.codeVerifier,
  });

  session.oauth = null;
  session.atlassian = token;

  return token;
}

export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw buildError("Missing refresh token.", 401);
  }

  return requestToken({
    grant_type: "refresh_token",
    client_id: config.atlassian.clientId,
    client_secret: config.atlassian.clientSecret,
    refresh_token: refreshToken,
  });
}

export async function ensureValidAccessToken(session) {
  if (!session.atlassian?.accessToken) {
    throw buildError("Connect Atlassian before using MCP.", 401);
  }

  const expiresSoon = Date.now() >= session.atlassian.expiresAt - 60_000;

  if (!expiresSoon) {
    return session.atlassian.accessToken;
  }

  if (!session.atlassian.refreshToken) {
    session.atlassian = null;
    throw buildError(
      "Access token expired and no refresh_token is available. Reconnect Atlassian.",
      401,
    );
  }

  try {
    const refreshed = await refreshAccessToken(session.atlassian.refreshToken);
    session.atlassian = refreshed;
    return refreshed.accessToken;
  } catch (error) {
    session.atlassian = null;
    throw buildError(
      "Refresh token exchange failed. Reconnect Atlassian.",
      401,
      {
        cause: error?.details ?? error?.message ?? "Unknown refresh error",
      },
    );
  }
}
