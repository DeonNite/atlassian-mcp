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

function normalizeTokenPayload(payload) {
  if (!payload.access_token) {
    throw buildError("Atlassian token response did not include an access token.");
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

async function requestToken(body) {
  const response = await fetch(config.atlassian.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw buildError("Atlassian token exchange failed.", response.status, payload);
  }

  return normalizeTokenPayload(payload);
}

export function buildAtlassianAuthorizeUrl(session) {
  const state = base64Url(randomBytes(24));
  const { codeVerifier, codeChallenge } = createPkcePair();

  session.oauth = {
    state,
    codeVerifier,
    createdAt: Date.now(),
  };

  const query = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.atlassian.clientId,
    scope: config.atlassian.scopes.join(" "),
    redirect_uri: config.atlassian.redirectUri,
    response_type: "code",
    state,
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${config.atlassian.authorizeUrl}?${query.toString()}`;
}

export async function exchangeAuthorizationCode(session, code, returnedState) {
  if (!session.oauth?.state || !session.oauth?.codeVerifier) {
    throw buildError("Missing Atlassian OAuth session state.", 400);
  }

  if (returnedState !== session.oauth.state) {
    throw buildError("Atlassian OAuth state validation failed.", 400);
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
    throw buildError("Connect Atlassian before using MCP tools.", 401);
  }

  const expiresSoon = Date.now() >= session.atlassian.expiresAt - 60_000;

  if (!expiresSoon) {
    return session.atlassian.accessToken;
  }

  if (!session.atlassian.refreshToken) {
    session.atlassian = null;
    throw buildError("Atlassian session expired. Reconnect Atlassian.", 401);
  }

  try {
    session.atlassian = await refreshAccessToken(session.atlassian.refreshToken);
    return session.atlassian.accessToken;
  } catch (error) {
    session.atlassian = null;
    throw buildError("Atlassian session refresh failed. Reconnect Atlassian.", 401, {
      cause: error.details ?? error.message,
    });
  }
}
