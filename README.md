# Atlassian MCP + OpenAI Demo

This repository implements a React + Node.js chatbot that:

- authenticates a user against Atlassian on the backend,
- connects to Atlassian's remote MCP server,
- exposes stable app-level tools named `searchJira`, `getIssue`, `searchConfluence`, and `createIssue`,
- dynamically surfaces additional Atlassian MCP tools from the live `listTools()` response,
- lets OpenAI call those tools through the Responses API,
- includes direct debug endpoints so you can verify real MCP calls outside the chat loop.

## Architecture

- `client/`: React + Vite chat UI
- `server/`: Express API, Atlassian OAuth flow, MCP client, OpenAI orchestration
- Atlassian tool execution path:
  - Chat request reaches Node
  - Node lists the live Atlassian MCP tools and converts them into OpenAI-callable function tools
  - OpenAI chooses the best matching tool for the user request
  - Node executes the matching Atlassian MCP tool via the official MCP SDK
  - The MCP result is returned to OpenAI as function output
  - OpenAI generates the assistant reply

## Required environment variables

The app reads these variables from the root `.env`:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `SERVER_PORT`
- `CLIENT_ORIGIN`
- `ATLASSIAN_CLIENT_ID`
- `ATLASSIAN_CLIENT_SECRET`
- `ATLASSIAN_REDIRECT_URI`

Optional:

- `ATLASSIAN_SCOPES`
- `ATLASSIAN_MCP_URL`

You can use `.env.example` as a reference.

## Atlassian app setup

This project uses an interactive Atlassian OAuth authorization-code flow for MCP access.
Your Atlassian OAuth app should include at least the scopes needed by the four tools:

- Jira search and issue lookup: `read:jira-work`
- Jira issue creation: `write:jira-work`
- Confluence search: `search:confluence` and `read:confluence-content.all`
- Optional token refresh in long-lived sessions: `offline_access` if your Atlassian OAuth client is allowed to request it

Your redirect URI must match `ATLASSIAN_REDIRECT_URI`.

## Install

```bash
npm install
```

## Run

Start the backend:

```bash
npm run dev:server
```

Start the frontend in a second terminal:

```bash
npm run dev:client
```

Open `http://localhost:5173`.

## Flow

1. Click `Connect Atlassian`.
2. Complete the Atlassian login and consent flow.
3. Choose a cloud site from the dropdown populated by Atlassian accessible resources.
4. Ask the assistant to search Jira, retrieve an issue, search Confluence, or create an issue.

The backend also exposes any additional Atlassian MCP tools returned by Atlassian for the authenticated session, so the assistant can perform broader read/write actions when those tools are available.

## Direct MCP debug endpoints

These endpoints perform real MCP tool calls on the backend after Atlassian authentication:

- `GET /api/mcp/tools`
- `POST /api/mcp/search-jira`
- `POST /api/mcp/get-issue`
- `POST /api/mcp/search-confluence`
- `POST /api/mcp/create-issue`
- `POST /api/mcp/call`

Example request body for Jira search:

```json
{
  "cloudId": "your-cloud-id",
  "jql": "project = DEMO ORDER BY created DESC",
  "fields": ["summary", "status", "assignee"]
}
```

Example request body for the generic MCP call endpoint:

```json
{
  "name": "updateJiraIssue",
  "args": {
    "cloudId": "your-cloud-id",
    "issueIdOrKey": "DEMO-42",
    "fields": {
      "summary": "Updated from the generic MCP endpoint"
    }
  }
}
```

## Notes

- The session store is in-memory. This is fine for a local demo and should be replaced for production.
- The backend resets chat state when you switch Atlassian cloud IDs.
- If `offline_access` is enabled for your Atlassian OAuth client and a refresh token is available, the server refreshes it automatically. Otherwise users will need to reconnect after the access token expires.
