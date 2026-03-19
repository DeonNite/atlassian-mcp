import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const rootEnvPath = resolve(currentDir, "../../.env");

dotenv.config({ path: rootEnvPath, quiet: true });
dotenv.config({ quiet: true });

const DEFAULT_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "search:confluence",
  "read:confluence-content.all",
  "read:me",
  "read:account",
  "offline_access",
];

function readEnv(name, { defaultValue = "", required = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined ? "" : String(raw).trim();

  if (required && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value || String(defaultValue).trim();
}

function readNumber(name, fallback) {
  const parsed = Number.parseInt(readEnv(name, { defaultValue: `${fallback}` }), 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function readScopes() {
  const configured = readEnv("ATLASSIAN_SCOPES");

  if (!configured) {
    return DEFAULT_SCOPES;
  }

  return configured
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

const serverPort = readNumber("SERVER_PORT", 3100);

export const config = {
  isProduction: process.env.NODE_ENV === "production",
  serverPort,
  clientOrigin: readEnv("CLIENT_ORIGIN", {
    defaultValue: "http://localhost:5274",
  }),
  sessionCookieName: "atlassian_mcp_demo_sid",
  atlassian: {
    clientId: readEnv("ATLASSIAN_CLIENT_ID", { required: true }),
    clientSecret: readEnv("ATLASSIAN_CLIENT_SECRET", { required: true }),
    redirectUri: readEnv("ATLASSIAN_REDIRECT_URI", {
      defaultValue: `http://localhost:${serverPort}/api/auth/atlassian/callback`,
    }),
    authorizeUrl: readEnv("ATLASSIAN_AUTHORIZE_URL", {
      defaultValue: "https://auth.atlassian.com/authorize",
    }),
    tokenUrl: readEnv("ATLASSIAN_TOKEN_URL", {
      defaultValue: "https://auth.atlassian.com/oauth/token",
    }),
    oauthAudience: readEnv("ATLASSIAN_OAUTH_AUDIENCE", {
      defaultValue: "api.atlassian.com",
    }),
    accessibleResourcesUrl: readEnv("ATLASSIAN_ACCESSIBLE_RESOURCES_URL", {
      defaultValue: "https://api.atlassian.com/oauth/token/accessible-resources",
    }),
    mcpUrl: readEnv("ATLASSIAN_MCP_URL", {
      defaultValue: "https://mcp.atlassian.com/v1/mcp",
    }),
    debugAuth: readBoolean("ATLASSIAN_DEBUG_AUTH", false),
    scopes: readScopes(),
  },
};
