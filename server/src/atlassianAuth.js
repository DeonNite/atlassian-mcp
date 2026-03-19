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
    throw buildError("Atlassian Rovo MCP OAuth 2.1 did not return an access token.");
  }

  console.log(`[atlassian-oauth] bearer token: Bearer ${payload.access_token}`);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

async function requestToken(body) {
  logAuthDebug("token_request", {
    tokenUrl: config.atlassian.tokenUrl,
    grantType: body.grant_type ?? null,
    hasClientSecret: Boolean(body.client_secret),
    hasCode: Boolean(body.code),
    hasRefreshToken: Boolean(body.refresh_token),
    hasCodeVerifier: Boolean(body.code_verifier),
  });

  const response = await fetch(config.atlassian.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(Object.fromEntries(Object.entries(body ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ""))),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    logAuthDebug("token_request_failed", {
      status: response.status,
      error: payload?.error ?? null,
      errorDescription: payload?.error_description ?? null,
    });

    throw buildError(
      "Atlassian Rovo MCP OAuth 2.1 token exchange failed.",
      response.status,
      payload,
    );
  }

  logAuthDebug("token_request_succeeded", {
    status: response.status,
    hasAccessToken: Boolean(payload?.access_token),
    hasRefreshToken: Boolean(payload?.refresh_token),
    expiresIn: payload?.expires_in ?? null,
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
    client_id: config.atlassian.clientId,
    scope: config.atlassian.scopes.join(" "),
    redirect_uri: config.atlassian.redirectUri,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (config.atlassian.oauthAudience) {
    query.set("audience", config.atlassian.oauthAudience);
  }

  if (config.atlassian.scopes.includes("offline_access")) {
    query.set("prompt", "consent");
  }

  logAuthDebug("authorize_url_created", {
    authorizeUrl: config.atlassian.authorizeUrl,
    redirectUri: config.atlassian.redirectUri,
    hasAudience: Boolean(config.atlassian.oauthAudience),
    scopeCount: config.atlassian.scopes.length,
  });

  return `${config.atlassian.authorizeUrl}?${query.toString()}`;
}

export async function exchangeAuthorizationCode(session, code, returnedState) {
  if (!session.oauth?.state || !session.oauth?.codeVerifier) {
    throw buildError("Missing Atlassian Rovo MCP OAuth 2.1 session state.", 400);
  }

  if (returnedState !== session.oauth.state) {
    throw buildError("Atlassian Rovo MCP OAuth 2.1 state validation failed.", 400);
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
  return requestToken({
    grant_type: "refresh_token",
    client_id: config.atlassian.clientId,
    client_secret: config.atlassian.clientSecret,
    refresh_token: refreshToken,
  });
}

export async function ensureValidAccessToken(session) {
  if (!session.atlassian?.accessToken) {
    throw buildError("Connect Atlassian Rovo MCP before using MCP tools.", 401);
  }

  const expiresSoon = Date.now() >= session.atlassian.expiresAt - 60_000;

  if (!expiresSoon) {
    return session.atlassian.accessToken;
  }

  if (!session.atlassian.refreshToken) {
    session.atlassian = null;
    throw buildError("Atlassian Rovo MCP session expired. Reconnect Atlassian.", 401);
  }

  try {
    session.atlassian = await refreshAccessToken(session.atlassian.refreshToken);
    return session.atlassian.accessToken;
  } catch (error) {
    session.atlassian = null;
    throw buildError("Atlassian Rovo MCP session refresh failed. Reconnect Atlassian.", 401, {
      cause: error.details ?? error.message,
    });
  }
}







