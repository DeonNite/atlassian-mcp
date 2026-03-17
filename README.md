# Atlassian MCP + OpenAI Demo

This repository implements a React + Node.js chatbot that:

- authenticates a user against Atlassian on the backend,
- connects to Atlassian's remote MCP server,
- exposes stable app-level tools named `searchJira`, `getIssue`, `searchConfluence`, and `createIssue`,
- lets OpenAI call those tools through the Responses API,
- includes direct debug endpoints so you can verify real MCP calls outside the chat loop.

## Architecture

- `client/`: React + Vite chat UI
- `server/`: Express API, Atlassian OAuth flow, MCP client, OpenAI orchestration
- Atlassian tool execution path:
  - Chat request reaches Node
  - OpenAI chooses one of the four function tools
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
- Token refresh in long-lived sessions: `offline_access`

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

## Direct MCP debug endpoints

These endpoints perform real MCP tool calls on the backend after Atlassian authentication:

- `GET /api/mcp/tools`
- `POST /api/mcp/search-jira`
- `POST /api/mcp/get-issue`
- `POST /api/mcp/search-confluence`
- `POST /api/mcp/create-issue`

Example request body for Jira search:

```json
{
  "cloudId": "your-cloud-id",
  "jql": "project = DEMO ORDER BY created DESC",
  "fields": ["summary", "status", "assignee"]
}
```

## Notes

- The session store is in-memory. This is fine for a local demo and should be replaced for production.
- The backend resets chat state when you switch Atlassian cloud IDs.
- If the Atlassian access token expires and a refresh token is available, the server refreshes it automatically.
