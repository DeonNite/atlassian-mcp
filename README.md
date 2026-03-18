# Atlassian MCP + OpenAI Demo

This repository is a two-workspace app that lets a user authenticate with Atlassian Rovo MCP through OAuth 2.1, select an Atlassian cloud site, and operate on Jira and Confluence through an OpenAI-powered chat UI.

The project has two parts:

- `client/`: React + Vite frontend
- `server/`: Express backend for Atlassian Rovo MCP OAuth 2.1, MCP access, session state, and OpenAI Responses API orchestration

## Current Project Flow

1. The browser loads the React app from `client/`.
2. The frontend calls the backend through `/api/*`; Vite proxies those requests to the Express server in development.
3. The backend creates or resumes a 12-hour HTTP-only session cookie.
4. The user starts the Atlassian Rovo MCP OAuth 2.1 flow from `/api/auth/atlassian/start`.
5. The server redirects the user to Atlassian's OAuth authorization endpoint at `https://auth.atlassian.com/authorize` using the Rovo MCP scopes, PKCE, and a session-backed `state` value.
6. Atlassian redirects back to `/api/auth/atlassian/callback`, where the server validates `state`, exchanges the authorization code at `https://auth.atlassian.com/oauth/token`, stores tokens in the session, and clears any prior conversation state.
7. The frontend loads accessible Atlassian resources from `/api/atlassian/resources`.
8. The user selects a cloud site, or manually enters a `cloudId`.
9. The user sends a prompt to `/api/chat`.
10. The backend refreshes the Atlassian Rovo MCP token if needed through Atlassian's OAuth token endpoint, then lists the live MCP tools for the current session and converts them into OpenAI-callable function tools.
11. The server always prefers stable helper tools when available:
12. Any additional Atlassian MCP tools returned by `listTools()` are also exposed to OpenAI as dynamic function tools.
    - `searchJira`
    - `getIssue`
    - `searchConfluence`
    - `createIssue`
13. OpenAI decides whether to answer directly or call one or more tools.
14. For each tool call, the backend executes the matching Atlassian MCP tool through the official MCP SDK, returns the result to OpenAI, and continues until no more tool calls are requested.
15. The final assistant response and the executed tool log are returned to the frontend.
16. The UI shows the conversation in the center panel and the MCP execution log in the right rail.


## Request Lifecycle

For a normal chat request, the flow is:

1. `POST /api/chat`
2. `generateChatResponse()` loads the live Atlassian MCP tool list
3. `buildOpenAiToolRegistry()` maps stable aliases first, then adds dynamic tools
4. `openai.responses.create()` runs with the current session's `previous_response_id`
5. Function calls are executed through `callAtlassianTool()`
6. MCP results are sent back as `function_call_output`
7. The loop continues until OpenAI returns plain assistant text
8. The server stores:
   - `previousResponseId`
   - `activeCloudId`

Conversation state is cleared when:

- Atlassian Rovo MCP is reconnected
- the user explicitly resets chat
- the requested `cloudId` changes from the previously active one
- the user logs out

## Architecture

### Frontend

The React app in `client/src/App.jsx` is organized around three operator steps:

- `Authorize`: connect Atlassian Rovo MCP
- `Scope`: choose a cloud site
- `Operate`: chat and inspect executed MCP tools

The frontend also:

- persists the selected `cloudId` in `localStorage`
- renders quick prompts for common Jira and Confluence actions
- shows the tool execution log returned by the backend
- uses `credentials: "include"` for cookie-backed session requests

### Backend

The Express server in `server/src/index.js` handles:

- CORS for the configured client origin
- JSON API routes
- cookie-backed in-memory session lookup and creation
- Atlassian Rovo MCP OAuth 2.1 start, callback, state validation, and token refresh
- accessible resource discovery
- direct MCP tool execution endpoints
- OpenAI Responses API chat orchestration

The auth integration in `server/src/atlassianAuth.js` now uses Atlassian's OAuth 2.1 authorization-code flow directly for browser auth:

- authorization endpoint: `https://auth.atlassian.com/authorize`
- token endpoint: `https://auth.atlassian.com/oauth/token`
- PKCE verifier and `state` are stored in the existing session
- refresh tokens are exchanged through Atlassian's token endpoint

The MCP integration in `server/src/atlassianMcpClient.js`:

- connects to Atlassian's remote MCP server over `StreamableHTTPClientTransport`
- resolves stable aliases to the closest real Atlassian tool names
- sanitizes tool schemas before exposing them to OpenAI
- filters outgoing tool arguments against the target schema

## Requirements

- Node.js `>= 20`
- an OpenAI API key
- an Atlassian OAuth app configured for Atlassian Rovo MCP access

## Environment Variables

The server reads the root `.env`. Use `.env.example` as the starting point.

Required:

- `OPENAI_API_KEY`
- `ATLASSIAN_CLIENT_ID`
- `ATLASSIAN_CLIENT_SECRET`

Commonly configured:

- `OPENAI_MODEL` default: `gpt-5.4`
- `SERVER_PORT` default: `3001`
- `CLIENT_ORIGIN` default: `http://localhost:5173`
- `ATLASSIAN_REDIRECT_URI` default: `http://localhost:3001/api/auth/atlassian/callback`
- `ATLASSIAN_SCOPES` default: `read:jira-work write:jira-work search:confluence read:confluence-content.all`
- `ATLASSIAN_MCP_URL` default: `https://mcp.atlassian.com/v1/mcp`

## Atlassian App Setup

This project uses the Atlassian Rovo MCP OAuth 2.1 flow with Atlassian's standard browser authorization and token endpoints:



- `https://auth.atlassian.com/authorize`
- `https://auth.atlassian.com/oauth/token`

The MCP server endpoint remains:

- `https://mcp.atlassian.com/v1/mcp`

The browser flow uses:

- authorization code grant
- PKCE
- a session-backed `state` check on callback

At minimum, your Atlassian app should allow:

- `read:jira-work`
- `write:jira-work`
- `search:confluence`
- `read:confluence-content.all`

Optional:

- `offline_access` if your Atlassian OAuth client is allowed to issue refresh tokens for longer-lived sessions

Your Atlassian app redirect URI must match `ATLASSIAN_REDIRECT_URI`.

## Install

Install dependencies from the repository root:

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

Open the client origin, which is `http://localhost:5173` by default.

Useful extra commands:

```bash
npm --workspace server run dev:watch
npm run build
npm run check:server
```

## API Endpoints

### Health and session

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/logout`
- `POST /api/chat/reset`

### Atlassian auth and resource discovery

- `GET /api/auth/atlassian/start`
- `GET /api/auth/atlassian/callback`
- `GET /api/atlassian/resources`

### MCP inspection and direct execution

- `GET /api/mcp/tools`
- `POST /api/mcp/search-jira`
- `POST /api/mcp/get-issue`
- `POST /api/mcp/search-confluence`
- `POST /api/mcp/create-issue`
- `POST /api/mcp/call`

### Chat

- `POST /api/chat`

Example chat request:

```json
{
  "message": "Search Jira for open bugs assigned to me and group them by priority.",
  "cloudId": "your-cloud-id"
}
```

Example generic MCP call:

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

- Session storage is in-memory and intended for local development only.
- Session TTL is 12 hours.
- The backend stores Atlassian auth state, OAuth discovery state, and chat state in the same session.
- The frontend can keep a selected `cloudId` in `localStorage`, but the backend still resets chat state when the active site changes.
- Mutating tools are exposed, but the OpenAI instructions explicitly tell the model to confirm intent before create, update, delete, transition, comment, or similar write actions.




