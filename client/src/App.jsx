import { useEffect, useMemo, useState } from "react";

const INITIAL_MESSAGES = [
  {
    role: "assistant",
    content:
      "Connect Atlassian, choose a cloud site, then ask me to search Jira, fetch an issue, search Confluence, or create a Jira issue.",
  },
];

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
    .catch(() => ({ error: "The server returned a non-JSON response." }));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function formatExpiry(value) {
  if (!value) {
    return "Not connected";
  }

  return new Date(value).toLocaleString();
}

function usePersistedCloudId() {
  const [cloudId, setCloudId] = useState(() => localStorage.getItem("cloudId") ?? "");

  useEffect(() => {
    localStorage.setItem("cloudId", cloudId);
  }, [cloudId]);

  return [cloudId, setCloudId];
}

export default function App() {
  const [status, setStatus] = useState({
    connected: false,
    expiresAt: null,
    model: "",
    hasConversation: false,
    activeCloudId: null,
  });
  const [resources, setResources] = useState([]);
  const [cloudId, setCloudId] = usePersistedCloudId();
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");
  const [toolCalls, setToolCalls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loadingResources, setLoadingResources] = useState(false);
  const [error, setError] = useState("");

  const resourceOptions = useMemo(
    () =>
      resources.map((resource) => ({
        label: `${resource.name} (${resource.id})`,
        value: resource.id,
      })),
    [resources],
  );

  async function loadStatus() {
    const payload = await apiFetch("/api/auth/status", { method: "GET" });
    setStatus(payload);
    return payload;
  }

  async function loadResources() {
    setLoadingResources(true);

    try {
      const payload = await apiFetch("/api/atlassian/resources", {
        method: "GET",
      });
      setResources(payload.resources ?? []);
    } finally {
      setLoadingResources(false);
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

    loadStatus()
      .then((payload) => {
        if (payload.connected) {
          return loadResources();
        }

        return undefined;
      })
      .catch((loadError) => {
        setError(loadError.message);
      });
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
      setStatus((current) => ({
        ...current,
        connected: false,
        expiresAt: null,
        hasConversation: false,
      }));
      setResources([]);
      setToolCalls([]);
      setMessages(INITIAL_MESSAGES);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshResources() {
    setError("");

    try {
      await loadResources();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function handleResetConversation() {
    setBusy(true);
    setError("");

    try {
      await apiFetch("/api/chat/reset", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessages(INITIAL_MESSAGES);
      setToolCalls([]);
      await loadStatus();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!draft.trim()) {
      return;
    }

    setBusy(true);
    setError("");

    const userMessage = {
      role: "user",
      content: draft.trim(),
    };

    setMessages((current) => [...current, userMessage]);
    setDraft("");

    try {
      const payload = await apiFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: userMessage.content,
          cloudId: cloudId || undefined,
        }),
      });

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            payload.text ||
            "The model returned no text. Check the tool call panel for details.",
        },
      ]);
      setToolCalls(payload.toolCalls ?? []);
      setStatus((current) => ({
        ...current,
        hasConversation: true,
        activeCloudId: cloudId || current.activeCloudId,
      }));
    } catch (requestError) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `Request failed: ${requestError.message}`,
        },
      ]);
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <main className="layout">
        <section className="hero">
          <p className="eyebrow">Atlassian MCP + OpenAI</p>
          <h1>React frontend, Node backend, real MCP tool execution.</h1>
          <p className="hero-copy">
            This demo passes user prompts to OpenAI, exposes app-level tools, and
            resolves those tools by calling Atlassian&apos;s remote MCP server from
            the backend.
          </p>
        </section>

        <section className="control-grid">
          <article className="panel status-panel">
            <div className="panel-heading">
              <h2>Session</h2>
              <span className={status.connected ? "status-pill ok" : "status-pill"}>
                {status.connected ? "Connected" : "Disconnected"}
              </span>
            </div>

            <div className="kv">
              <span>Model</span>
              <strong>{status.model || "Unavailable"}</strong>
            </div>
            <div className="kv">
              <span>Token expiry</span>
              <strong>{formatExpiry(status.expiresAt)}</strong>
            </div>
            <div className="kv">
              <span>Active cloud</span>
              <strong>{status.activeCloudId || cloudId || "Not selected"}</strong>
            </div>

            <div className="button-row">
              <button className="primary-button" onClick={handleConnect} disabled={busy}>
                Connect Atlassian
              </button>
              <button className="ghost-button" onClick={handleDisconnect} disabled={busy}>
                Disconnect
              </button>
            </div>
          </article>

          <article className="panel resource-panel">
            <div className="panel-heading">
              <h2>Cloud Site</h2>
              <button
                className="ghost-button slim"
                onClick={handleRefreshResources}
                disabled={!status.connected || loadingResources}
              >
                {loadingResources ? "Loading..." : "Refresh"}
              </button>
            </div>

            <label className="field">
              <span>Select a discovered site</span>
              <select
                value={cloudId}
                onChange={(event) => setCloudId(event.target.value)}
                disabled={!status.connected || resourceOptions.length === 0}
              >
                <option value="">
                  {resourceOptions.length > 0
                    ? "Choose a cloud site"
                    : "No sites loaded yet"}
                </option>
                {resourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Or enter cloudId manually</span>
              <input
                value={cloudId}
                onChange={(event) => setCloudId(event.target.value)}
                placeholder="e.g. 12345678-abcd-1234-abcd-1234567890ab"
              />
            </label>

            <p className="panel-note">
              The backend resets the OpenAI conversation when the cloud ID changes.
            </p>
          </article>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="chat-grid">
          <article className="panel chat-panel">
            <div className="panel-heading">
              <h2>Chat</h2>
              <button
                className="ghost-button slim"
                onClick={handleResetConversation}
                disabled={busy}
              >
                Reset chat
              </button>
            </div>

            <div className="messages">
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`message ${message.role}`}
                >
                  <span className="message-role">{message.role}</span>
                  <p>{message.content}</p>
                </div>
              ))}
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Example: Search Jira for open bugs assigned to me."
                rows={4}
                disabled={busy}
              />
              <div className="button-row">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || !status.connected}
                >
                  {busy ? "Working..." : "Send"}
                </button>
              </div>
            </form>
          </article>

          <article className="panel tool-panel">
            <div className="panel-heading">
              <h2>Tool Calls</h2>
              <span className="status-pill">{toolCalls.length} entries</span>
            </div>

            <div className="tool-list">
              {toolCalls.length === 0 ? (
                <p className="panel-note">
                  Tool execution previews appear here after each chat request.
                </p>
              ) : (
                toolCalls.map((toolCall, index) => (
                  <div className="tool-card" key={`${toolCall.name}-${index}`}>
                    <div className="tool-head">
                      <strong>{toolCall.name}</strong>
                      <span>{toolCall.toolName || "No MCP tool resolved"}</span>
                    </div>
                    {toolCall.error ? (
                      <p className="tool-error">{toolCall.error}</p>
                    ) : (
                      <>
                        <pre>{JSON.stringify(toolCall.args, null, 2)}</pre>
                        <p>{toolCall.preview}</p>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
