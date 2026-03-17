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
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    accessibleResourcesUrl:
      "https://api.atlassian.com/oauth/token/accessible-resources",
    mcpUrl: readEnv("ATLASSIAN_MCP_URL", {
      defaultValue: "https://mcp.atlassian.com/v1/mcp",
    }),
    scopes: readScopes(),
  },
};
