import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { config } from "./config.js";
import { buildError } from "./http.js";

const TOOL_NAME_CANDIDATES = {
  searchJira: ["searchJiraIssuesUsingJql", "searchJiraIssues"],
  getIssue: ["getJiraIssue", "getIssue"],
  searchConfluence: ["searchConfluenceUsingCql", "searchConfluence"],
  createIssue: ["createJiraIssue", "createIssue"],
};

function normalizeToolsResponse(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.tools)) {
    return response.tools;
  }

  return [];
}

function resolveTool(alias, tools) {
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

async function withMcpClient(accessToken, work) {
  const client = new Client({
    name: "atlassian-mcp-openai-demo",
    version: "0.1.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(config.atlassian.mcpUrl),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  );

  await client.connect(transport);

  try {
    return await work(client);
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

export async function callAtlassianTool(accessToken, alias, args = {}) {
  return withMcpClient(accessToken, async (client) => {
    const tools = normalizeToolsResponse(await client.listTools());
    const tool = resolveTool(alias, tools);
    const filteredArgs = filterArgsForSchema(args, tool.inputSchema);

    const result = await client.callTool({
      name: tool.name,
      arguments: filteredArgs,
    });

    return {
      alias,
      toolName: tool.name,
      input: filteredArgs,
      result,
    };
  });
}
