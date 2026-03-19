import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { fetchAccessibleResources } from "./atlassianApi.js";
import { config } from "./config.js";
import { buildError } from "./http.js";

const TOOL_NAME_CANDIDATES = {
  searchJira: ["searchJiraIssuesUsingJql", "searchJiraIssues"],
  getIssue: ["getJiraIssue", "getIssue"],
  searchConfluence: ["searchConfluenceUsingCql", "searchConfluence"],
  createIssue: ["createJiraIssue", "createIssue"],
};

const STABLE_ALIAS_TOOLS = {
  searchJira: {
    description:
      "Search Jira issues in the selected Atlassian cloud site using JQL.",
    parameters: {
      type: "object",
      properties: {
        cloudId: {
          type: "string",
          description:
            "Atlassian cloud ID. If omitted, the server uses the selected site.",
        },
        jql: {
          type: "string",
          description: "A Jira Query Language string.",
        },
        fields: {
          type: "array",
          description: "Optional Jira fields to request.",
          items: {
            type: "string",
          },
        },
      },
      required: ["jql"],
      additionalProperties: false,
    },
  },
  getIssue: {
    description: "Get a Jira issue by issue key or issue ID.",
    parameters: {
      type: "object",
      properties: {
        cloudId: {
          type: "string",
          description:
            "Atlassian cloud ID. If omitted, the server uses the selected site.",
        },
        issueIdOrKey: {
          type: "string",
          description: "Issue key like DEMO-123 or a Jira issue ID.",
        },
        fields: {
          type: "array",
          description: "Optional Jira fields to request.",
          items: {
            type: "string",
          },
        },
      },
      required: ["issueIdOrKey"],
      additionalProperties: false,
    },
  },
  searchConfluence: {
    description:
      "Search Confluence content in the selected Atlassian cloud site using CQL.",
    parameters: {
      type: "object",
      properties: {
        cloudId: {
          type: "string",
          description:
            "Atlassian cloud ID. If omitted, the server uses the selected site.",
        },
        cql: {
          type: "string",
          description: "A Confluence Query Language string.",
        },
        limit: {
          type: "integer",
          description: "Optional result limit.",
        },
      },
      required: ["cql"],
      additionalProperties: false,
    },
  },
  createIssue: {
    description: "Create a Jira issue in the selected Atlassian cloud site.",
    parameters: {
      type: "object",
      properties: {
        cloudId: {
          type: "string",
          description:
            "Atlassian cloud ID. If omitted, the server uses the selected site.",
        },
        projectKey: {
          type: "string",
          description: "Jira project key, for example DEMO.",
        },
        issueTypeName: {
          type: "string",
          description: "Jira issue type name, for example Task or Bug.",
        },
        summary: {
          type: "string",
          description: "Issue summary.",
        },
        description: {
          type: "string",
          description: "Optional issue description.",
        },
        assigneeAccountId: {
          type: "string",
          description: "Optional Jira account ID for the assignee.",
        },
        parentIdOrKey: {
          type: "string",
          description: "Optional parent issue key or ID.",
        },
      },
      required: ["projectKey", "issueTypeName", "summary"],
      additionalProperties: false,
    },
  },
};

const MUTATING_TOOL_PATTERN =
  /\b(create|update|delete|remove|archive|move|assign|transition|comment|link|unlink|upload|attach|publish)\b/i;

const EXCLUDED_DYNAMIC_TOOL_NAMES = new Set([
  "searchAtlassian",
  "getAccessibleAtlassianResources",
]);
const TRANSIENT_MCP_FAILURE_PATTERN =
  /(trouble completing this action|upstream connect error|connection termination|temporar(?:y|ily)|timed?\s*out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|503|429)/i;
function normalizeToolsResponse(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.tools)) {
    return response.tools;
  }

  return [];
}

function resolveAliasTool(alias, tools) {
  const candidates = TOOL_NAME_CANDIDATES[alias] ?? [alias];
  const lowerCandidates = candidates.map((candidate) => candidate.toLowerCase());

  const exactMatch = tools.find((tool) =>
    lowerCandidates.includes(String(tool.name).toLowerCase()),
  );

  if (exactMatch) {
    return exactMatch;
  }

  const partialMatch = tools.find((tool) =>
    lowerCandidates.some((candidate) =>
      String(tool.name).toLowerCase().includes(candidate),
    ),
  );

  if (partialMatch) {
    return partialMatch;
  }

  throw buildError(
    `Unable to find an Atlassian MCP tool for alias "${alias}".`,
    500,
    {
      availableTools: tools.map((tool) => tool.name),
    },
  );
}

function resolveToolByName(name, tools) {
  const normalizedName = String(name).trim().toLowerCase();

  const exactMatch = tools.find(
    (tool) => String(tool.name).trim().toLowerCase() === normalizedName,
  );

  if (exactMatch) {
    return exactMatch;
  }

  const partialMatch = tools.find((tool) =>
    String(tool.name).trim().toLowerCase().includes(normalizedName),
  );

  if (partialMatch) {
    return partialMatch;
  }

  throw buildError(`Unable to find Atlassian MCP tool "${name}".`, 500, {
    availableTools: tools.map((tool) => tool.name),
  });
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

function normalizeStableAliasArgs(identifier, args) {
  const normalizedIdentifier = String(identifier ?? "").trim();
  const normalizedArgs =
    args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};

  if (normalizedIdentifier !== "createIssue") {
    return normalizedArgs;
  }

  if (shouldKeepValue(normalizedArgs.assigneeAccountId) && !shouldKeepValue(normalizedArgs.assignee_account_id)) {
    normalizedArgs.assignee_account_id = normalizedArgs.assigneeAccountId;
  }

  if (shouldKeepValue(normalizedArgs.parentIdOrKey) && !shouldKeepValue(normalizedArgs.parent)) {
    normalizedArgs.parent = normalizedArgs.parentIdOrKey;
  }

  return normalizedArgs;
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

function scalarTypeForEnum(enumValues) {
  const firstValue = enumValues.find(
    (value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  );

  if (firstValue === null) {
    return "string";
  }

  return typeof firstValue === "string" ||
    typeof firstValue === "number" ||
    typeof firstValue === "boolean"
    ? typeof firstValue
    : "string";
}

function sanitizeSchemaNode(schema) {
  if (schema === true) {
    return {};
  }

  if (!schema || schema === false || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }

  const unionBranches = schema.oneOf ?? schema.anyOf ?? schema.allOf ?? null;

  if (Array.isArray(unionBranches) && unionBranches.length > 0) {
    for (const branch of unionBranches) {
      const sanitizedBranch = sanitizeSchemaNode(branch);

      if (
        sanitizedBranch.type ||
        sanitizedBranch.properties ||
        sanitizedBranch.items ||
        sanitizedBranch.enum
      ) {
        return sanitizedBranch;
      }
    }
  }

  const sanitized = {};
  const rawType = schema.type;

  if (typeof schema.description === "string" && schema.description.trim()) {
    sanitized.description = schema.description.trim();
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const enumValues = schema.enum.filter(
      (value) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    );

    if (enumValues.length > 0) {
      sanitized.enum = enumValues;
    }
  }

  if (typeof rawType === "string") {
    sanitized.type = rawType === "null" ? "string" : rawType;
  } else if (Array.isArray(rawType)) {
    const nonNullTypes = rawType.filter(
      (item) => typeof item === "string" && item !== "null",
    );

    if (nonNullTypes.length > 0) {
      sanitized.type = nonNullTypes[0];
    }
  }

  if (
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
  ) {
    sanitized.type = "object";
    sanitized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        sanitizeSchemaNode(value),
      ]),
    );

    if (Array.isArray(schema.required)) {
      sanitized.required = schema.required.filter((key) =>
        Object.hasOwn(sanitized.properties, key),
      );
    }

    if (typeof schema.additionalProperties === "boolean") {
      sanitized.additionalProperties = schema.additionalProperties;
    }
  }

  if (schema.items !== undefined) {
    sanitized.type = "array";
    sanitized.items = sanitizeSchemaNode(schema.items);
  }

  if (!sanitized.type) {
    if (sanitized.enum?.length) {
      sanitized.type = scalarTypeForEnum(sanitized.enum);
    } else if (sanitized.properties) {
      sanitized.type = "object";
    } else if (sanitized.items) {
      sanitized.type = "array";
    }
  }

  return sanitized;
}

function buildOpenAiParameters(inputSchema) {
  const sanitizedSchema = sanitizeSchemaNode(inputSchema);

  if (sanitizedSchema.type === "object") {
    return {
      ...sanitizedSchema,
      properties: sanitizedSchema.properties ?? {},
    };
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

function buildToolDescription(tool) {
  const description =
    typeof tool?.description === "string" && tool.description.trim()
      ? tool.description.trim()
      : `Call Atlassian MCP tool "${tool?.name ?? "unknown"}".`;

  return description.slice(0, 1000);
}

function buildOpenAiToolName(actualToolName, usedNames) {
  const normalizedBase = String(actualToolName)
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixedBase = normalizedBase
    ? `atlassian_${normalizedBase}`
    : "atlassian_tool";
  const digest = createHash("sha256")
    .update(String(actualToolName))
    .digest("hex")
    .slice(0, 8);
  const maxLength = 64;
  const reserve = digest.length + 1;
  let candidate =
    prefixedBase.length <= maxLength
      ? prefixedBase
      : `${prefixedBase.slice(0, maxLength - reserve)}_${digest}`;
  let suffix = 2;

  if (/^\d/.test(candidate)) {
    candidate = `tool_${candidate}`.slice(0, maxLength);
  }

  while (usedNames.has(candidate.toLowerCase())) {
    const numericSuffix = `_${suffix}`;
    candidate = `${candidate.slice(0, maxLength - numericSuffix.length)}${numericSuffix}`;
    suffix += 1;
  }

  usedNames.add(candidate.toLowerCase());

  return candidate;
}

function schemaHasProperty(inputSchema, propertyName) {
  return Boolean(
    inputSchema?.properties &&
      typeof inputSchema.properties === "object" &&
      Object.hasOwn(inputSchema.properties, propertyName),
  );
}

function schemaRequiresProperty(inputSchema, propertyName) {
  return (
    Array.isArray(inputSchema?.required) && inputSchema.required.includes(propertyName)
  );
}

function isMutatingTool(toolName, description = "") {
  return MUTATING_TOOL_PATTERN.test(`${toolName} ${description}`);
}

function logMcpDebug(event, details = {}) {
  if (!config.atlassian.debugAuth) {
    return;
  }

  console.log(`[atlassian-mcp] ${event}`, details);
}

function buildTokenFingerprint(accessToken) {
  const normalizedToken = String(accessToken ?? "");

  if (!normalizedToken) {
    return null;
  }

  return createHash("sha256").update(normalizedToken).digest("hex").slice(0, 12);
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

function isTransientMcpFailure(error) {
  if (!error) {
    return false;
  }

  const statusCode = Number(error.statusCode ?? error.code ?? 0);
  const message = String(error.message ?? "");
  const detailsText = (() => {
    if (!error.details) {
      return "";
    }

    if (typeof error.details === "string") {
      return error.details;
    }

    try {
      return JSON.stringify(error.details);
    } catch {
      return "";
    }
  })();

  if (error.details?.transient === true) {
    return true;
  }

  if (statusCode === 429 || statusCode >= 500) {
    return true;
  }

  return TRANSIENT_MCP_FAILURE_PATTERN.test(`${message} ${detailsText}`);
}

function extractToolExecutionError(result) {
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
  const parsedErrorMessage =
    parsedContentError?.message ??
    parsedContentError?.error_description ??
    null;
  const hasGenericFailureMessage = /trouble completing this action/i.test(contentText);
  const hasStructuredError = result.structuredContent?.error === true;
  const hasTopLevelError = result.error === true || result.isError === true;
  const hasParsedJsonError = parsedContentError?.error === true;

  if (!hasGenericFailureMessage && !hasStructuredError && !hasTopLevelError && !hasParsedJsonError) {
    return null;
  }

  const message =
    result.structuredContent?.message ??
    result.structuredContent?.error_description ??
    parsedErrorMessage ??
    (contentText || "Atlassian MCP tool returned an error.");

  return {
    message,
    transient: TRANSIENT_MCP_FAILURE_PATTERN.test(message),
    details: {
      structuredContent: result.structuredContent ?? null,
      content: Array.isArray(result.content) ? result.content : null,
      parsedContentError,
      isError: result.isError ?? null,
    },
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithMcpRetry(operation, action) {
  const maxAttempts = Math.max(1, config.atlassian.mcpToolMaxAttempts);
  const retryDelayMs = Math.max(0, config.atlassian.mcpToolRetryDelayMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const shouldRetry = attempt < maxAttempts && isTransientMcpFailure(error);

      logMcpDebug("retry_decision", {
        operation,
        attempt,
        maxAttempts,
        shouldRetry,
        message: error?.message ?? "Unknown MCP error",
        statusCode: error?.statusCode ?? null,
      });

      if (!shouldRetry) {
        throw error;
      }

      const delayMs = retryDelayMs * attempt;

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw buildError("Atlassian MCP retry attempts exhausted.", 502);
}

async function withMcpClient(accessToken, work) {
  const client = new Client({
    name: "atlassian-mcp-openai-demo",
    version: "0.1.0",
  });
  const tokenString = String(accessToken ?? "").trim();

  if (!tokenString) {
    throw buildError("Missing Atlassian access token for MCP transport.", 401);
  }

  const authorizationHeader = `Bearer ${tokenString}`;

  logMcpDebug("connect_attempt", {
    mcpUrl: config.atlassian.mcpUrl,
    hasAccessToken: true,
    authorizationScheme: "Bearer",
    accessTokenLength: tokenString.length,
    accessTokenFingerprint: buildTokenFingerprint(tokenString),
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
    logMcpDebug("connect_succeeded", {
      mcpUrl: config.atlassian.mcpUrl,
    });

    return await work(client);
  } catch (error) {
    logMcpDebug("request_failed", {
      mcpUrl: config.atlassian.mcpUrl,
      message: error?.message ?? "Unknown MCP error",
      statusCode: error?.statusCode ?? null,
      code: error?.code ?? null,
      details: error?.details ?? null,
    });

    throw error;
  } finally {
    if (typeof transport.close === "function") {
      await transport.close();
    }
  }
}

export async function listAvailableTools(accessToken) {
  return runWithMcpRetry("list_tools", async () =>
    withMcpClient(accessToken, async (client) =>
      normalizeToolsResponse(await client.listTools()),
    ),
  );
}

export function buildOpenAiToolRegistry(availableTools = []) {
  const tools = normalizeToolsResponse(availableTools);
  const registry = new Map();
  const preferredToolNames = [];
  const usedNames = new Set();
  const mappedActualToolNames = new Set();
  const openAiTools = [];

  for (const [alias, definition] of Object.entries(STABLE_ALIAS_TOOLS)) {
    let resolvedTool = null;

    try {
      resolvedTool = resolveAliasTool(alias, tools);
    } catch {
      continue;
    }

    usedNames.add(alias.toLowerCase());
    mappedActualToolNames.add(String(resolvedTool.name).toLowerCase());
    preferredToolNames.push(alias);
    registry.set(alias, {
      target: alias,
      resolveMode: "alias",
      inputSchema: definition.parameters,
      injectDefaultCloudId: true,
      requireCloudId: true,
      isMutating: isMutatingTool(alias, definition.description),
      actualToolName: resolvedTool.name,
    });
    openAiTools.push({
      type: "function",
      name: alias,
      description: definition.description,
      parameters: definition.parameters,
    });
  }

  for (const tool of tools) {
    if (!tool?.name) {
      continue;
    }

    if (EXCLUDED_DYNAMIC_TOOL_NAMES.has(String(tool.name).trim())) {
      continue;
    }

    if (mappedActualToolNames.has(String(tool.name).toLowerCase())) {
      continue;
    }

    const openAiName = buildOpenAiToolName(tool.name, usedNames);

    registry.set(openAiName, {
      target: String(tool.name),
      resolveMode: "name",
      inputSchema: tool.inputSchema ?? null,
      injectDefaultCloudId: schemaHasProperty(tool.inputSchema, "cloudId"),
      requireCloudId: schemaRequiresProperty(tool.inputSchema, "cloudId"),
      isMutating: isMutatingTool(tool.name, tool.description),
      actualToolName: String(tool.name),
    });
    openAiTools.push({
      type: "function",
      name: openAiName,
      description: buildToolDescription(tool),
      parameters: buildOpenAiParameters(tool.inputSchema),
    });
  }

  return {
    tools: openAiTools,
    registry,
    availableTools: tools,
    preferredToolNames,
    hasMutatingTools: Array.from(registry.values()).some(
      (tool) => tool.isMutating,
    ),
  };
}

export async function callAtlassianTool(
  accessToken,
  identifier,
  args = {},
  options = {},
) {
  const { resolveMode = "auto", availableTools = null } = options;
  const normalizedArgs = normalizeStableAliasArgs(identifier, args);
  const operation = `call_tool:${String(identifier ?? "unknown")}`;

  return runWithMcpRetry(operation, async () =>
    withMcpClient(accessToken, async (client) => {
      const tools = normalizeToolsResponse(
        availableTools ?? (await client.listTools()),
      );
      const tool =
        resolveMode === "alias"
          ? resolveAliasTool(identifier, tools)
          : resolveMode === "name"
            ? resolveToolByName(identifier, tools)
            : (() => {
                try {
                  return resolveAliasTool(identifier, tools);
                } catch {
                  return resolveToolByName(identifier, tools);
                }
              })();
      const resolvedArgs = await resolveCloudIdArg(accessToken, normalizedArgs);
      const filteredArgs = filterArgsForSchema(resolvedArgs, tool.inputSchema);

      const result = await client.callTool({
        name: tool.name,
        arguments: filteredArgs,
      });
      const toolExecutionError = extractToolExecutionError(result);

      logMcpDebug("tool_result", {
        toolName: tool.name,
        hasStructuredContent: Boolean(result?.structuredContent),
        contentItems: Array.isArray(result?.content) ? result.content.length : 0,
        isError: Boolean(toolExecutionError),
      });

      if (toolExecutionError) {
        throw buildError(toolExecutionError.message, 502, {
          toolName: tool.name,
          input: filteredArgs,
          transient: toolExecutionError.transient,
          ...toolExecutionError.details,
        });
      }

      return {
        alias: resolveMode === "alias" ? identifier : null,
        toolName: tool.name,
        input: filteredArgs,
        result,
      };
    }),
  );
}

