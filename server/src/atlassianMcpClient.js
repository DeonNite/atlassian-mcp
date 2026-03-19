import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { fetchAccessibleResources } from "./atlassianApi.js";
import { config } from "./config.js";
import { buildError } from "./http.js";

function normalizeToolsResponse(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.tools)) {
    return response.tools;
  }

  return [];
}

function shouldKeepValue(value) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function filterArgsForSchema(args, inputSchema) {
  const properties = inputSchema?.properties ?? null;

  if (!properties) {
    return Object.fromEntries(
      Object.entries(args).filter(([, value]) => shouldKeepValue(value)),
    );
  }

  const allowedKeys = new Set(Object.keys(properties));

  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => allowedKeys.has(key) && shouldKeepValue(value),
    ),
  );
}

function normalizeCloudTarget(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
}

function looksLikeCloudDomain(value) {
  return normalizeCloudTarget(value).includes(".");
}

async function resolveCloudIdArg(accessToken, args) {
  const requestedCloudId =
    typeof args?.cloudId === "string" ? args.cloudId.trim() : "";

  if (!requestedCloudId || !looksLikeCloudDomain(requestedCloudId)) {
    return args;
  }

  const normalizedTarget = normalizeCloudTarget(requestedCloudId);
  const resources = await fetchAccessibleResources(accessToken);
  const matchingResource = resources.find((resource) => {
    const resourceId = String(resource.id ?? "").trim().toLowerCase();
    const resourceUrl = normalizeCloudTarget(resource.url);

    return resourceId === normalizedTarget || resourceUrl === normalizedTarget;
  });

  if (!matchingResource?.id) {
    return args;
  }

  return {
    ...args,
    cloudId: matchingResource.id,
  };
}

function buildTokenFingerprint(accessToken) {
  const token = String(accessToken ?? "");

  if (!token) {
    return null;
  }

  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function logMcpDebug(event, details = {}) {
  if (!config.atlassian.debugAuth) {
    return;
  }

  console.log(`[atlassian-mcp] ${event}`, details);
}

function findToolByName(name, tools) {
  const normalizedName = String(name ?? "").trim().toLowerCase();
  const exact = tools.find(
    (tool) => String(tool?.name ?? "").trim().toLowerCase() === normalizedName,
  );

  if (exact) {
    return exact;
  }

  return tools.find((tool) =>
    String(tool?.name ?? "").trim().toLowerCase().includes(normalizedName),
  );
}

function parseJsonObject(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractToolError(result) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const contentText = Array.isArray(result.content)
    ? result.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join("\n")
    : "";
  const parsedContentError = parseJsonObject(contentText);
  const message =
    result.structuredContent?.message ??
    parsedContentError?.message ??
    contentText ??
    "";
  const hasError =
    result.isError === true ||
    result.error === true ||
    result.structuredContent?.error === true ||
    parsedContentError?.error === true;

  if (!hasError) {
    return null;
  }

  return {
    message: message || "Atlassian MCP tool returned an error.",
    details: {
      structuredContent: result.structuredContent ?? null,
      content: Array.isArray(result.content) ? result.content : null,
      parsedContentError,
      isError: result.isError ?? null,
    },
  };
}

async function withMcpClient(accessToken, work) {
  const client = new Client({
    name: "atlassian-rovo-mcp-oauth21-demo",
    version: "1.0.0",
  });
  const token = String(accessToken ?? "").trim();

  if (!token) {
    throw buildError("Missing access token for MCP transport.", 401);
  }

  const authorizationHeader = `Bearer ${token}`;

  logMcpDebug("connect_attempt", {
    mcpUrl: config.atlassian.mcpUrl,
    accessTokenFingerprint: buildTokenFingerprint(token),
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(config.atlassian.mcpUrl),
    {
      requestInit: {
        headers: {
          Authorization: authorizationHeader,
        },
      },
    },
  );

  try {
    await client.connect(transport);
    return await work(client);
  } catch (error) {
    throw buildError(
      error?.message ?? "Failed to communicate with Atlassian MCP.",
      error?.statusCode ?? 500,
      error?.details ?? null,
    );
  } finally {
    if (typeof transport.close === "function") {
      await transport.close();
    }
  }
}

export async function listAvailableTools(accessToken) {
  return withMcpClient(accessToken, async (client) =>
    normalizeToolsResponse(await client.listTools()),
  );
}

export async function callAtlassianTool(accessToken, name, args = {}) {
  return withMcpClient(accessToken, async (client) => {
    const tools = normalizeToolsResponse(await client.listTools());
    const tool = findToolByName(name, tools);

    if (!tool) {
      throw buildError(`Tool "${name}" is not available for this session.`, 400, {
        availableTools: tools.map((entry) => entry.name),
      });
    }

    const resolvedArgs = await resolveCloudIdArg(accessToken, args);
    const filteredArgs = filterArgsForSchema(
      resolvedArgs && typeof resolvedArgs === "object" ? resolvedArgs : {},
      tool.inputSchema,
    );
    const result = await client.callTool({
      name: tool.name,
      arguments: filteredArgs,
    });
    const toolError = extractToolError(result);

    if (toolError) {
      throw buildError(toolError.message, 502, {
        toolName: tool.name,
        input: filteredArgs,
        ...toolError.details,
      });
    }

    return {
      toolName: tool.name,
      input: filteredArgs,
      result,
    };
  });
}
