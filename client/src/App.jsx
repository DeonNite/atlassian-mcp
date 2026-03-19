import { useEffect, useMemo, useState } from "react";

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const payload = await response
    .json()
    .catch(() => ({ error: `Non-JSON response received for ${path}` }));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function formatDate(value) {
  if (!value) {
    return "N/A";
  }

  return new Date(value).toLocaleString();
}

function normalizeCloudTarget(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
}

function resolveCloudId(value, resources) {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    return "";
  }

  const normalizedTarget = normalizeCloudTarget(normalizedValue);
  const matched = resources.find((resource) => {
    const id = String(resource.id ?? "").trim().toLowerCase();
    const url = normalizeCloudTarget(resource.url);
    return id === normalizedTarget || url === normalizedTarget;
  });

  return matched?.id ?? normalizedValue;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function App() {
  const [status, setStatus] = useState({
    connected: false,
    expiresAt: null,
    hasRefreshToken: false,
    activeCloudId: null,
    lastOauthCallback: null,
  });
  const [resources, setResources] = useState([]);
  const [tools, setTools] = useState([]);
  const [cloudId, setCloudId] = useState(() => localStorage.getItem("cloudId") ?? "");
  const [toolName, setToolName] = useState("");
  const [toolArgsText, setToolArgsText] = useState("{\n  \n}");
  const [runLog, setRunLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const resolvedCloudId = useMemo(
    () => resolveCloudId(cloudId || status.activeCloudId, resources),
    [cloudId, status.activeCloudId, resources],
  );

  const sortedTools = useMemo(
    () =>
      [...tools].sort((left, right) =>
        String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
      ),
    [tools],
  );

  useEffect(() => {
    localStorage.setItem("cloudId", cloudId);
  }, [cloudId]);

  async function loadStatus() {
    const payload = await apiFetch("/api/auth/status", { method: "GET" });
    setStatus(payload);
    return payload;
  }

  async function loadResources() {
    const payload = await apiFetch("/api/atlassian/resources", { method: "GET" });
    setResources(Array.isArray(payload.resources) ? payload.resources : []);
  }

  async function loadTools() {
    const payload = await apiFetch("/api/mcp/tools", { method: "GET" });
    const list = Array.isArray(payload.tools) ? payload.tools : [];
    setTools(list);

    if (!toolName && list.length > 0) {
      setToolName(list[0].name);
    }
  }

  async function refreshWorkspace() {
    setLoading(true);
    setError("");

    try {
      const authStatus = await loadStatus();

      if (authStatus.connected) {
        await Promise.all([loadResources(), loadTools()]);
      } else {
        setResources([]);
        setTools([]);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    const authError = url.searchParams.get("authError");
    const authErrorDescription = url.searchParams.get("authErrorDescription");

    if (connected) {
      url.searchParams.delete("connected");
      window.history.replaceState({}, "", url);
    }

    if (authError) {
      setError(
        authErrorDescription
          ? `${authError}: ${authErrorDescription}`
          : authError,
      );
      url.searchParams.delete("authError");
      url.searchParams.delete("authErrorDescription");
      window.history.replaceState({}, "", url);
    }

    refreshWorkspace();
  }, []);

  function handleConnect() {
    window.location.href = "/api/auth/atlassian/start";
  }

  async function handleDisconnect() {
    setBusy(true);
    setError("");

    try {
      await apiFetch("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatus({
        connected: false,
        expiresAt: null,
        hasRefreshToken: false,
        activeCloudId: null,
        lastOauthCallback: null,
      });
      setResources([]);
      setTools([]);
      setRunLog([]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleInvokeTool() {
    if (!toolName.trim()) {
      setError("Enter or select a tool name.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      let parsedArgs = {};

      if (toolArgsText.trim()) {
        parsedArgs = JSON.parse(toolArgsText);
      }

      if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
        throw new Error("Tool args must be a JSON object.");
      }

      if (resolvedCloudId && !parsedArgs.cloudId) {
        parsedArgs.cloudId = resolvedCloudId;
      }

      const payload = await apiFetch("/api/mcp/call", {
        method: "POST",
        body: JSON.stringify({
          name: toolName.trim(),
          args: parsedArgs,
        }),
      });

      setRunLog((current) => [
        {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ok: true,
          tool: payload.toolName ?? toolName,
          input: payload.input ?? parsedArgs,
          output: payload.result ?? payload,
        },
        ...current,
      ]);

      if (typeof payload?.input?.cloudId === "string" && payload.input.cloudId) {
        setCloudId(payload.input.cloudId);
      }
    } catch (requestError) {
      const message = requestError.message || "Tool call failed.";
      setError(message);
      setRunLog((current) => [
        {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ok: false,
          tool: toolName,
          input: toolArgsText,
          output: { error: message },
        },
        ...current,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <section className="panel">
        <h1>Atlassian Rovo MCP OAuth 2.1 Scaffold</h1>
        <p>
          Fresh scaffold focused on OAuth 2.1 (3LO), refresh token support, and
          direct MCP tool execution.
        </p>

        <div className="row">
          <button onClick={handleConnect} disabled={busy || loading}>
            Connect Atlassian
          </button>
          <button onClick={handleDisconnect} disabled={busy || loading}>
            Disconnect
          </button>
          <button onClick={refreshWorkspace} disabled={busy || loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="grid two">
          <div className="card">
            <h2>Auth status</h2>
            <p>Connected: {status.connected ? "Yes" : "No"}</p>
            <p>Token expiry: {formatDate(status.expiresAt)}</p>
            <p>Has refresh token: {status.hasRefreshToken ? "Yes" : "No"}</p>
            <p>Active cloudId: {status.activeCloudId || "N/A"}</p>
          </div>

          <div className="card">
            <h2>OAuth callback snapshot</h2>
            <pre>{prettyJson(status.lastOauthCallback ?? { message: "No callback yet." })}</pre>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Scope target</h2>
        <div className="grid two">
          <div className="card">
            <label htmlFor="resource-select">Discovered site</label>
            <select
              id="resource-select"
              value={cloudId}
              onChange={(event) => setCloudId(event.target.value)}
            >
              <option value="">Select a site</option>
              {resources.map((resource) => (
                <option key={`${resource.id}-${resource.url}`} value={resource.id}>
                  {resource.name} ({resource.id})
                </option>
              ))}
            </select>
          </div>

          <div className="card">
            <label htmlFor="cloudid-input">Manual cloudId or domain</label>
            <input
              id="cloudid-input"
              value={cloudId}
              onChange={(event) => setCloudId(event.target.value)}
              placeholder="e.g. 12345678-abcd-1234-abcd-1234567890ab"
            />
            <p>Resolved cloudId: {resolvedCloudId || "N/A"}</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Tool execution</h2>
        <div className="grid two">
          <div className="card">
            <label htmlFor="tool-select">Tool</label>
            <select
              id="tool-select"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
            >
              <option value="">Select tool</option>
              {sortedTools.map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
            </select>

            <label htmlFor="tool-name-manual">Or type tool name manually</label>
            <input
              id="tool-name-manual"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              placeholder="searchJiraIssuesUsingJql"
            />

            <label htmlFor="args">Args JSON</label>
            <textarea
              id="args"
              rows={12}
              value={toolArgsText}
              onChange={(event) => setToolArgsText(event.target.value)}
            />

            <button onClick={handleInvokeTool} disabled={busy || loading || !status.connected}>
              {busy ? "Running..." : "Run tool"}
            </button>
          </div>

          <div className="card">
            <h3>Loaded tools ({tools.length})</h3>
            <pre>{prettyJson(sortedTools.map((tool) => tool.name))}</pre>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Run log</h2>
        {runLog.length === 0 ? (
          <p>No runs yet.</p>
        ) : (
          <div className="stack">
            {runLog.map((entry) => (
              <article key={entry.id} className="card">
                <p>
                  <strong>{entry.ok ? "SUCCESS" : "FAILURE"}</strong> {entry.tool}
                </p>
                <p>{formatDate(entry.createdAt)}</p>
                <pre>{prettyJson({ input: entry.input, output: entry.output })}</pre>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
