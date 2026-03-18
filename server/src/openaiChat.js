import OpenAI from "openai";

import { config } from "./config.js";
import {
  buildOpenAiToolRegistry,
  callAtlassianTool,
  listAvailableTools,
} from "./atlassianMcpClient.js";
import { buildError } from "./http.js";

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

function buildInstructions(defaultCloudId, toolRegistry) {
  const cloudIdLine = defaultCloudId
    ? `Use Atlassian cloud ID "${defaultCloudId}" unless the user explicitly gives a different one.`
    : "If the user asks for Jira or Confluence data and no cloud ID is available, ask them to select a site first.";
  const preferredToolsLine =
    toolRegistry.preferredToolNames.length > 0
      ? `Preferred helper tools for common tasks: ${toolRegistry.preferredToolNames.join(", ")}. Use them when they fit the request.`
      : "Use the available Atlassian tools that best match the user's request.";
  const mutatingToolsLine = toolRegistry.hasMutatingTools
    ? "For tools that create, update, delete, transition, or otherwise change Atlassian data, confirm the user's intent and required fields before calling them."
    : "Only call tools when the user clearly wants Atlassian data or an Atlassian action.";

  return [
    "You are an Atlassian assistant connected to Jira and Confluence through backend app tools.",
    "Use the available tools whenever the user asks for Jira or Confluence data or actions.",
    cloudIdLine,
    preferredToolsLine,
    "For Jira searches, generate valid JQL from the user's request.",
    "For Confluence searches, generate valid CQL from the user's request.",
    mutatingToolsLine,
    "When a tool returns structured data, summarize the most important details instead of dumping raw JSON unless the user asks for raw output.",
    "If a tool call fails and a cloudId was already provided, do not ask for the Jira site URL again. Explain the tool error and suggest retrying or reconnecting Atlassian.",
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

function normalizeToolArgs(name, args, defaultCloudId, toolMetadata) {
  const normalizedArgs =
    args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};

  if (toolMetadata?.injectDefaultCloudId && !normalizedArgs.cloudId && defaultCloudId) {
    normalizedArgs.cloudId = defaultCloudId;
  }

  if (toolMetadata?.requireCloudId && !normalizedArgs.cloudId) {
    throw buildError(
      `The ${name} tool needs a cloudId. Select a site first or pass cloudId explicitly.`,
      400,
    );
  }

  if ("fields" in normalizedArgs) {
    normalizedArgs.fields = normalizeFields(normalizedArgs.fields);
  }

  return normalizedArgs;
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

async function executeTool(
  name,
  rawArgs,
  accessToken,
  defaultCloudId,
  toolRegistry,
) {
  const toolMetadata = toolRegistry.registry.get(name);

  if (!toolMetadata) {
    throw buildError(
      `The tool "${name}" is not available for this Atlassian session.`,
      400,
    );
  }

  const normalizedArgs = normalizeToolArgs(
    name,
    rawArgs,
    defaultCloudId,
    toolMetadata,
  );
  const mcpResult = await callAtlassianTool(
    accessToken,
    toolMetadata.target,
    normalizedArgs,
    {
      resolveMode: toolMetadata.resolveMode,
      availableTools: toolRegistry.availableTools,
    },
  );

  return {
    name,
    args:
      mcpResult.input && typeof mcpResult.input === "object"
        ? mcpResult.input
        : normalizedArgs,
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
  const availableTools = await listAvailableTools(accessToken);
  const toolRegistry = buildOpenAiToolRegistry(availableTools);
  const toolCalls = [];
  let resolvedCloudId = defaultCloudId ?? null;

  let response = await openai.responses.create({
    model: config.openai.model,
    instructions: buildInstructions(defaultCloudId, toolRegistry),
    previous_response_id: session.chat.previousResponseId ?? undefined,
    input: userMessage,
    tools: toolRegistry.tools,
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
          toolRegistry,
        );

        toolCalls.push({
          name: functionCall.name,
          toolName: toolExecution.mcpResult.toolName,
          args: toolExecution.args,
          preview: extractResultPreview(toolExecution.mcpResult),
        });

        if (typeof toolExecution.args.cloudId === "string" && toolExecution.args.cloudId) {
          resolvedCloudId = toolExecution.args.cloudId;
        }

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
      tools: toolRegistry.tools,
    });
  }

  session.chat.previousResponseId = response.id;
  session.chat.activeCloudId = resolvedCloudId ?? session.chat.activeCloudId ?? null;

  return {
    responseId: response.id,
    text: extractText(response),
    toolCalls,
  };
}





