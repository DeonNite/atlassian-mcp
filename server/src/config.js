import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const rootEnvPath = resolve(currentDir, "../../.env");

dotenv.config({ path: rootEnvPath, quiet: true });
dotenv.config({ quiet: true });

const DEFAULT_ATLASSIAN_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "search:confluence",
  "read:confluence-content.all",
];

function readEnv(name, { required = false, defaultValue = "" } = {}) {
  const rawValue = process.env[name];
  const normalizedValue = rawValue === undefined ? "" : String(rawValue).trim();

  if (required && !normalizedValue) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  if (!normalizedValue) {
    return String(defaultValue).trim();
  }

  return normalizedValue;
}

function readNumber(name, defaultValue) {
  const rawValue = process.env[name];
  const parsed = Number.parseInt(rawValue ?? `${defaultValue}`, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

function readBoolean(name, defaultValue = false) {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(String(rawValue).trim());
}
function readScopes() {
  const configuredScopes = readEnv("ATLASSIAN_SCOPES");

  if (!configuredScopes) {
    return DEFAULT_ATLASSIAN_SCOPES;
  }

  return configuredScopes
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

const serverPort = readNumber("SERVER_PORT", 3001);

export const config = {
  isProduction: process.env.NODE_ENV === "production",
  serverPort,
  clientOrigin: readEnv("CLIENT_ORIGIN", {
    defaultValue: "http://localhost:5173",
  }),
  sessionCookieName: "atlassian_mcp_demo_sid",
  openai: {
    apiKey: readEnv("OPENAI_API_KEY", { required: true }),
    model: readEnv("OPENAI_MODEL", { defaultValue: "gpt-5.4" }),
  },
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
    mcpToolMaxAttempts: Math.max(
      1,
      readNumber("ATLASSIAN_MCP_TOOL_MAX_ATTEMPTS", 2),
    ),
    mcpToolRetryDelayMs: Math.max(
      0,
      readNumber("ATLASSIAN_MCP_TOOL_RETRY_DELAY_MS", 400),
    ),
    debugAuth: readBoolean("ATLASSIAN_DEBUG_AUTH", false),
    scopes: readScopes(),
  },
};





