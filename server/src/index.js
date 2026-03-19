import express from "express";

import { fetchAccessibleResources } from "./atlassianApi.js";
import {
  buildAtlassianAuthorizeUrl,
  ensureValidAccessToken,
  exchangeAuthorizationCode,
} from "./atlassianAuth.js";
import { callAtlassianTool, listAvailableTools } from "./atlassianMcpClient.js";
import { config } from "./config.js";
import { buildError, clearSessionCookie, parseCookies, setSessionCookie } from "./http.js";
import { clearAtlassianSession, createSession, getSession } from "./sessionStore.js";

const app = express();

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function previewSecret(value) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 12)}...${normalized.slice(-8)}`;
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.clientOrigin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionIdFromCookie = cookies[config.sessionCookieName];
  const existingSession = getSession(sessionIdFromCookie);

  if (existingSession) {
    req.sessionId = sessionIdFromCookie;
    req.session = existingSession;
    next();
    return;
  }

  const { sessionId, session } = createSession();
  setSessionCookie(res, sessionId);
  req.sessionId = sessionId;
  req.session = session;
  next();
});

app.get(
  "/api/health",
  asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      atlassianMcpUrl: config.atlassian.mcpUrl,
      authorizeUrl: config.atlassian.authorizeUrl,
      tokenUrl: config.atlassian.tokenUrl,
      redirectUri: config.atlassian.redirectUri,
      scopeCount: config.atlassian.scopes.length,
      includesOfflineAccess: config.atlassian.scopes.includes("offline_access"),
    });
  }),
);

app.get(
  "/api/auth/status",
  asyncRoute(async (req, res) => {
    let connected = false;
    let expiresAt = null;
    let hasRefreshToken = false;

    if (req.session.atlassian) {
      try {
        await ensureValidAccessToken(req.session);
        connected = true;
        expiresAt = req.session.atlassian.expiresAt;
        hasRefreshToken = Boolean(req.session.atlassian.refreshToken);
      } catch {
        clearAtlassianSession(req.session);
      }
    }

    res.json({
      connected,
      expiresAt,
      hasRefreshToken,
      activeCloudId: req.session.activeCloudId ?? null,
      lastOauthCallback: req.session.lastOauthCallback ?? null,
    });
  }),
);

app.get(
  "/api/auth/atlassian/start",
  asyncRoute(async (req, res) => {
    const authorizeUrl = await buildAtlassianAuthorizeUrl(req.session);
    res.redirect(authorizeUrl);
  }),
);

app.get(
  "/api/auth/atlassian/callback",
  asyncRoute(async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      req.session.lastOauthCallback = {
        receivedAt: new Date().toISOString(),
        result: "authorization_error",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        error: {
          code: String(error),
          description: errorDescription ? String(errorDescription) : null,
        },
      };

      const redirectUrl = new URL(config.clientOrigin);
      redirectUrl.searchParams.set("authError", String(error));

      if (errorDescription) {
        redirectUrl.searchParams.set("authErrorDescription", String(errorDescription));
      }

      res.redirect(redirectUrl.toString());
      return;
    }

    if (!code || !state) {
      req.session.lastOauthCallback = {
        receivedAt: new Date().toISOString(),
        result: "invalid_callback",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        error: {
          code: "missing_callback_parameters",
          description: "The callback did not include both code and state.",
        },
      };

      throw buildError("Missing callback parameters (code/state).", 400);
    }

    try {
      await exchangeAuthorizationCode(req.session, String(code), String(state));
      req.session.lastOauthCallback = {
        receivedAt: new Date().toISOString(),
        result: "authorized",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        token: {
          expiresAt: req.session.atlassian?.expiresAt ?? null,
          hasRefreshToken: Boolean(req.session.atlassian?.refreshToken),
          scope: req.session.atlassian?.scope ?? null,
        },
      };
    } catch (exchangeError) {
      req.session.lastOauthCallback = {
        receivedAt: new Date().toISOString(),
        result: "token_exchange_failed",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        error: {
          code: exchangeError?.message ?? "Token exchange failed",
          description: exchangeError?.details ?? null,
        },
      };

      const redirectUrl = new URL(config.clientOrigin);
      redirectUrl.searchParams.set("authError", "token_exchange_failed");
      redirectUrl.searchParams.set(
        "authErrorDescription",
        String(exchangeError?.message ?? "Token exchange failed."),
      );
      res.redirect(redirectUrl.toString());
      return;
    }

    const redirectUrl = new URL(config.clientOrigin);
    redirectUrl.searchParams.set("connected", "1");
    res.redirect(redirectUrl.toString());
  }),
);

app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    clearAtlassianSession(req.session);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

app.get(
  "/api/atlassian/resources",
  asyncRoute(async (req, res) => {
    const accessToken = await ensureValidAccessToken(req.session);
    const resources = await fetchAccessibleResources(accessToken);
    res.json({ resources });
  }),
);

app.get(
  "/api/mcp/tools",
  asyncRoute(async (req, res) => {
    const accessToken = await ensureValidAccessToken(req.session);
    const tools = await listAvailableTools(accessToken);
    res.json({ tools });
  }),
);

app.post(
  "/api/mcp/call",
  asyncRoute(async (req, res) => {
    const { name, toolName, args, arguments: toolArguments } = req.body ?? {};
    const requestedTool = name ?? toolName;

    if (!requestedTool || !String(requestedTool).trim()) {
      throw buildError("Tool name is required.", 400);
    }

    const accessToken = await ensureValidAccessToken(req.session);
    const callArgs = args ?? toolArguments ?? {};
    const result = await callAtlassianTool(
      accessToken,
      String(requestedTool).trim(),
      callArgs,
    );

    if (
      typeof result?.input?.cloudId === "string" &&
      result.input.cloudId.trim()
    ) {
      req.session.activeCloudId = result.input.cloudId.trim();
    }

    res.json(result);
  }),
);

app.use((error, req, res, next) => {
  const statusCode = error.statusCode ?? 500;

  if (statusCode >= 500) {
    console.error(error);
  }

  res.status(statusCode).json({
    error: error.message ?? "Unexpected server error.",
    details: error.details ?? null,
  });
});

app.listen(config.serverPort, () => {
  console.log(`Server listening on http://localhost:${config.serverPort}`);
});
