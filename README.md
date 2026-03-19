# Atlassian Rovo MCP OAuth 2.1 (3LO) Scaffold

This repository is a clean scaffold to connect a custom app to the **Atlassian Rovo MCP Server** using **OAuth 2.1 / 3LO** and execute MCP tools directly.

## What this scaffold includes

- A fresh Node/Express backend (`server`) for:
  - OAuth 2.1 authorization code flow with PKCE and state
  - token exchange and rotating refresh-token support
  - MCP calls to `https://mcp.atlassian.com/v1/mcp`
  - helper APIs for status, resources, tools, and tool execution
- A minimal React frontend (`client`) for:
  - connect/disconnect
  - cloud/site selection
  - manual tool execution with JSON args
  - run log output
- A task tracker at [`TASKS.md`](./TASKS.md) (includes refresh-token scope/flow work).

## Project flow

1. User clicks **Connect Atlassian** in the client.
2. Backend builds authorize URL with PKCE (`code_challenge_method=S256`) + `state`.
3. User consents on Atlassian OAuth screen.
4. Callback exchanges `code` for `access_token` (and `refresh_token` when `offline_access` is present).
5. Client can load:
   - accessible resources (`cloudId`)
   - available MCP tools
6. User runs a tool via `/api/mcp/call`.
7. If access token is near expiry, backend refreshes it using refresh token.

## Prerequisites

- Node.js 20+
- Atlassian developer app (3LO) with callback URL configured
- Atlassian Cloud access to Jira and/or Confluence
- Organization/site settings that allow your client domain and network path (domain/IP policies)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template and set values:

```bash
cp .env.example .env
```

3. Start both apps:

```bash
npm run dev
```

4. Open client:

`http://localhost:5274`

Backend:

`http://localhost:3100`

## Important env values

- `ATLASSIAN_AUTHORIZE_URL=https://auth.atlassian.com/authorize`
- `ATLASSIAN_TOKEN_URL=https://auth.atlassian.com/oauth/token`
- `ATLASSIAN_MCP_URL=https://mcp.atlassian.com/v1/mcp`
- `ATLASSIAN_SCOPES` should include:
  - Jira/Confluence scopes you need
  - `read:me` and `read:account` for shared Rovo tools
  - `offline_access` for refresh-token issuance

## API endpoints

- `GET /api/health`
- `GET /api/auth/status`
- `GET /api/auth/atlassian/start`
- `GET /api/auth/atlassian/callback`
- `POST /api/auth/logout`
- `GET /api/atlassian/resources`
- `GET /api/mcp/tools`
- `POST /api/mcp/call`

## Notes

- Use `/v1/mcp` endpoint (not `/v1/sse`).
- OAuth success does not guarantee tool success if org/site policies block tool execution.
- First-time app install/consent may require admin action depending on site/org configuration.

## References

- Atlassian Rovo MCP:  
  - https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/  
  - https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/  
  - https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/
- OAuth:
  - https://support.atlassian.com/atlassian-rovo-mcp-server/docs/authentication-and-authorization/  
  - https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-oauth-2-1/  
  - https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
