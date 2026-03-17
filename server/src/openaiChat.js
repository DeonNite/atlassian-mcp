import OpenAI from "openai";

import { config } from "./config.js";
import { callAtlassianTool } from "./atlassianMcpClient.js";
import { buildError } from "./http.js";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "searchJira",
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
  {
    type: "function",
    name: "getIssue",
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
  {
    type: "function",
    name: "searchConfluence",
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
  {
    type: "function",
    name: "createIssue",
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
];

function buildInstructions(defaultCloudId) {
  const cloudIdLine = defaultCloudId
    ? `Use Atlassian cloud ID "${defaultCloudId}" unless the user explicitly gives a different one.`
    : "If the user asks for Jira or Confluence data and no cloud ID is available, ask them to select a site first.";

  return [
    "You are an Atlassian assistant connected to Jira and Confluence through backend app tools.",
    "Use the available tools whenever the user asks for Jira or Confluence data.",
    cloudIdLine,
    "For Jira searches, generate valid JQL from the user's request.",
    "For Confluence searches, generate valid CQL from the user's request.",
    "Only call createIssue when the user explicitly wants to create an issue and the required fields are known.",
    "When a tool returns structured data, summarize the most important details instead of dumping raw JSON unless the user asks for raw output.",
  ].join(" ");
}

function normalizeFields(fields) {
  if (Array.isArray(fields)) {
    return fields.filter(Boolean);
  }

  if (typeof fields === "string") {
    return fields
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  return undefined;
}

function normalizeToolArgs(name, args, defaultCloudId) {
  const cloudId = args.cloudId ?? defaultCloudId ?? null;

  if (!cloudId) {
    throw buildError(
      `The ${name} tool needs a cloudId. Select a site first or pass cloudId explicitly.`,
      400,
    );
  }

  const baseArgs = {
    ...args,
    cloudId,
  };

  if ("fields" in baseArgs) {
    baseArgs.fields = normalizeFields(baseArgs.fields);
  }

  return baseArgs;
}

function extractResultPreview(result) {
  const content = result?.result?.content ?? [];
  const textParts = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean);

  if (textParts.length > 0) {
    return textParts.join("\n").slice(0, 600);
  }

  if (result?.result?.structuredContent) {
    return JSON.stringify(result.result.structuredContent).slice(0, 600);
  }

  return "Tool executed without a text preview.";
}

async function executeTool(name, rawArgs, accessToken, defaultCloudId) {
  const normalizedArgs = normalizeToolArgs(name, rawArgs, defaultCloudId);
  const mcpResult = await callAtlassianTool(accessToken, name, normalizedArgs);

  return {
    name,
    args: normalizedArgs,
    mcpResult,
  };
}

function parseFunctionArguments(input) {
  if (!input) {
    return {};
  }

  if (typeof input === "object") {
    return input;
  }

  return JSON.parse(input);
}

function extractText(response) {
  if (response.output_text) {
    return response.output_text;
  }

  const textParts = [];

  for (const item of response.output ?? []) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (contentItem.type === "output_text" && contentItem.text) {
        textParts.push(contentItem.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

export async function generateChatResponse({
  session,
  userMessage,
  accessToken,
  defaultCloudId,
}) {
  const toolCalls = [];

  let response = await openai.responses.create({
    model: config.openai.model,
    instructions: buildInstructions(defaultCloudId),
    previous_response_id: session.chat.previousResponseId ?? undefined,
    input: userMessage,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  });

  while (true) {
    const functionCalls = (response.output ?? []).filter(
      (item) => item.type === "function_call",
    );

    if (functionCalls.length === 0) {
      break;
    }

    const functionOutputs = [];

    for (const functionCall of functionCalls) {
      try {
        const parsedArgs = parseFunctionArguments(functionCall.arguments);
        const toolExecution = await executeTool(
          functionCall.name,
          parsedArgs,
          accessToken,
          defaultCloudId,
        );

        toolCalls.push({
          name: functionCall.name,
          toolName: toolExecution.mcpResult.toolName,
          args: toolExecution.args,
          preview: extractResultPreview(toolExecution.mcpResult),
        });

        functionOutputs.push({
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: JSON.stringify(toolExecution.mcpResult),
        });
      } catch (error) {
        toolCalls.push({
          name: functionCall.name,
          error: error.message,
        });

        functionOutputs.push({
          type: "function_call_output",
          call_id: functionCall.call_id,
          output: JSON.stringify({
            error: true,
            message: error.message,
            details: error.details ?? null,
          }),
        });
      }
    }

    response = await openai.responses.create({
      model: config.openai.model,
      previous_response_id: response.id,
      input: functionOutputs,
      tools: TOOL_DEFINITIONS,
    });
  }

  session.chat.previousResponseId = response.id;
  session.chat.activeCloudId = defaultCloudId ?? session.chat.activeCloudId ?? null;

  return {
    responseId: response.id,
    text: extractText(response),
    toolCalls,
  };
}
