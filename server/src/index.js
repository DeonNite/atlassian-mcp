import express from "express";

import { fetchAccessibleResources } from "./atlassianApi.js";
import {
  buildAtlassianAuthorizeUrl,
  ensureValidAccessToken,
  exchangeAuthorizationCode,
} from "./atlassianAuth.js";
import {
  callAtlassianTool,
  listAvailableTools,
} from "./atlassianMcpClient.js";
import { config } from "./config.js";
import { generateChatResponse } from "./openaiChat.js";
import { buildError, clearSessionCookie, parseCookies, setSessionCookie } from "./http.js";
import {
  clearAtlassianSession,
  clearConversation,
  createSession,
  getSession,
} from "./sessionStore.js";

const app = express();

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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
  const existingSessionId = cookies[config.sessionCookieName];
  const existingSession = getSession(existingSessionId);

  if (existingSession) {
    req.sessionId = existingSessionId;
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
      model: config.openai.model,
      atlassianMcpUrl: config.atlassian.mcpUrl,
      clientOrigin: config.clientOrigin,
    });
  }),
);

app.get(
  "/api/auth/status",
  asyncRoute(async (req, res) => {
    let connected = false;
    let expiresAt = null;

    if (req.session.atlassian) {
      try {
        await ensureValidAccessToken(req.session);
        connected = true;
        expiresAt = req.session.atlassian.expiresAt;
      } catch {
        clearAtlassianSession(req.session);
      }
    }

    res.json({
      connected,
      expiresAt,
      model: config.openai.model,
      hasConversation: Boolean(req.session.chat.previousResponseId),
      activeCloudId: req.session.chat.activeCloudId,
      lastOauthCallback: req.session.lastOauthCallback ?? null,
    });
  }),
);

app.get(
  "/api/auth/atlassian/start",
  asyncRoute(async (req, res) => {
    const authorizeUrl = await buildAtlassianAuthorizeUrl(req.session);

    if (authorizeUrl) {
      res.redirect(authorizeUrl);
      return;
    }

    const redirectUrl = new URL(config.clientOrigin);
    redirectUrl.searchParams.set("connected", "1");
    res.redirect(redirectUrl.toString());
  }),
);

app.get(
  "/api/auth/atlassian/callback",
  asyncRoute(async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    const previewSecret = (value) => {
      const normalized = String(value ?? "").trim();

      if (!normalized) {
        return null;
      }

      if (normalized.length <= 24) {
        return normalized;
      }

      return `${normalized.slice(0, 12)}...${normalized.slice(-8)}`;
    };

    if (error) {
      req.session.lastOauthCallback = {
        provider: "atlassian-rovo-mcp",
        oauthVersion: "2.1",
        receivedAt: new Date().toISOString(),
        result: "authorization_error",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        error: {
          code: `${error}`,
          description: errorDescription ? `${errorDescription}` : null,
        },
      };

      const redirectUrl = new URL(config.clientOrigin);
      redirectUrl.searchParams.set("authError", `${error}`);

      if (errorDescription) {
        redirectUrl.searchParams.set("authErrorDescription", `${errorDescription}`);
      }

      res.redirect(redirectUrl.toString());
      return;
    }

    if (!code || !state) {
      req.session.lastOauthCallback = {
        provider: "atlassian-rovo-mcp",
        oauthVersion: "2.1",
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

      throw buildError("Missing Atlassian Rovo MCP OAuth 2.1 callback parameters.", 400);
    }

    try {
      await exchangeAuthorizationCode(req.session, `${code}`, `${state}`);
      req.session.lastOauthCallback = {
        provider: "atlassian-rovo-mcp",
        oauthVersion: "2.1",
        receivedAt: new Date().toISOString(),
        result: "authorized",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        token: {
          expiresAt: req.session.atlassian?.expiresAt ?? null,
          hasRefreshToken: Boolean(req.session.atlassian?.refreshToken),
        },
      };
    } catch (exchangeError) {
      const rawDescription =
        exchangeError?.details?.error_description ??
        exchangeError?.details?.error ??
        exchangeError?.message ??
        "Token exchange failed.";
      const description =
        typeof rawDescription === "string"
          ? rawDescription
          : JSON.stringify(rawDescription);

      req.session.lastOauthCallback = {
        provider: "atlassian-rovo-mcp",
        oauthVersion: "2.1",
        receivedAt: new Date().toISOString(),
        result: "token_exchange_failed",
        callback: {
          code: previewSecret(code),
          state: previewSecret(state),
        },
        error: {
          code: exchangeError?.message ?? "Token exchange failed.",
          description: exchangeError?.details ?? null,
        },
      };

      const redirectUrl = new URL(config.clientOrigin);
      redirectUrl.searchParams.set("authError", "token_exchange_failed");
      redirectUrl.searchParams.set(
        "authErrorDescription",
        String(description).slice(0, 500),
      );
      res.redirect(redirectUrl.toString());
      return;
    }

    clearConversation(req.session);

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

function directToolRoute(alias) {
  return asyncRoute(async (req, res) => {
    const accessToken = await ensureValidAccessToken(req.session);
    const result = await callAtlassianTool(accessToken, alias, req.body ?? {}, {
      resolveMode: "alias",
    });
    res.json(result);
  });
}

app.post("/api/mcp/search-jira", directToolRoute("searchJira"));
app.post("/api/mcp/get-issue", directToolRoute("getIssue"));
app.post("/api/mcp/search-confluence", directToolRoute("searchConfluence"));
app.post("/api/mcp/create-issue", directToolRoute("createIssue"));
app.post(
  "/api/mcp/call",
  asyncRoute(async (req, res) => {
    const { name, toolName, args, arguments: toolArguments } = req.body ?? {};
    const requestedTool = name ?? toolName;

    if (!requestedTool || !String(requestedTool).trim()) {
      throw buildError("The generic MCP call endpoint requires a tool name.", 400);
    }

    const accessToken = await ensureValidAccessToken(req.session);
    const result = await callAtlassianTool(
      accessToken,
      String(requestedTool).trim(),
      args ?? toolArguments ?? {},
    );

    res.json(result);
  }),
);

app.post(
  "/api/chat",
  asyncRoute(async (req, res) => {
    const { message, cloudId = null, resetConversation = false } = req.body ?? {};

    if (!message || !String(message).trim()) {
      throw buildError("The chat endpoint requires a non-empty message.", 400);
    }

    if (
      resetConversation ||
      (cloudId &&
        req.session.chat.activeCloudId &&
        cloudId !== req.session.chat.activeCloudId)
    ) {
      clearConversation(req.session);
    }

    const accessToken = await ensureValidAccessToken(req.session);
    const result = await generateChatResponse({
      session: req.session,
      userMessage: String(message).trim(),
      accessToken,
      defaultCloudId: cloudId || req.session.chat.activeCloudId || null,
    });

    res.json(result);
  }),
);

app.post(
  "/api/chat/reset",
  asyncRoute(async (req, res) => {
    clearConversation(req.session);
    res.json({ ok: true });
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
  console.log(
    `Atlassian MCP demo server listening on http://localhost:${config.serverPort}`,
  );
});
