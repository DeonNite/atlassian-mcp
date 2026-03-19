# Atlassian Rovo MCP Scaffold Tasks

- [x] Re-scaffold repository with a clean `server` + `client` architecture.
- [x] Implement OAuth 2.1 (3LO) authorization code flow with PKCE (`S256`) and state validation.
- [x] Add `offline_access` to requested scopes so refresh tokens can be issued.
- [x] Implement refresh-token rotation handling on access-token expiry.
- [x] Implement MCP integration endpoints: health, auth status, resources, tools list, and generic tool call.
- [x] Build a minimal UI run log for direct MCP tool execution.
- [ ] Run full end-to-end validation against a freshly authorized Atlassian session and capture known upstream limitations.
