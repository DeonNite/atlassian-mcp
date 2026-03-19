import { useEffect, useMemo, useState } from "react";

const INITIAL_MESSAGES = [
  {
    role: "assistant",
    content:
      "Connect Atlassian Rovo MCP, lock onto a cloud site, then ask me to read or act across Jira and Confluence. I will use the stable helper tools first and fall back to any additional MCP tools your Atlassian session exposes.",
  },
];

const QUICK_PROMPTS = [
  "Search Jira for open bugs assigned to me and group them by priority.",
  "Update DEMO-42 to In Progress and add a short implementation note.",
  "Find the latest Confluence page about onboarding and summarize it.",
  "Create a Jira task for documenting the Atlassian MCP integration rollout.",
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
    .catch(() => ({
      error: `The server returned a non-JSON response for ${path}.`,
    }));

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

function normalizeCloudTarget(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
}

function findResourceForCloudTarget(value, resources) {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    return null;
  }

  const loweredValue = normalizedValue.toLowerCase();
  const normalizedTarget = normalizeCloudTarget(normalizedValue);

  return (
    resources.find((resource) => {
      const resourceId = String(resource.id ?? "").trim().toLowerCase();
      const resourceUrl = String(resource.url ?? "").trim().toLowerCase();

      return (
        resourceId === loweredValue ||
        resourceUrl === loweredValue ||
        normalizeCloudTarget(resource.url) === normalizedTarget
      );
    }) ?? null
  );
}

function resolveCloudId(value, resources) {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    return "";
  }

  return findResourceForCloudTarget(normalizedValue, resources)?.id ?? normalizedValue;
}

function looksLikeSiteDomain(value) {
  return normalizeCloudTarget(value).includes(".");
}

function buildWorkflowSteps({ connected, activeCloudId, hasConversation, busy }) {
  return [
    {
      label: "Authorize",
      title: connected ? "Rovo MCP connected" : "Connect Atlassian",
      detail: connected
        ? "OAuth 2.1 session is active and the backend can call Atlassian Rovo MCP."
        : "Start the Atlassian Rovo MCP OAuth 2.1 flow from the setup rail.",
      state: connected ? "done" : "active",
    },
    {
      label: "Scope",
      title: activeCloudId ? "Site selected" : "Pick a cloud site",
      detail: activeCloudId
        ? `Current target: ${activeCloudId}`
        : "Choose a discovered site or paste a cloud ID manually.",
      state: activeCloudId ? "done" : connected ? "active" : "pending",
    },
    {
      label: "Operate",
      title: hasConversation ? "Conversation active" : "Run Jira and Confluence tasks",
      detail: busy
        ? "The model is executing a request now."
        : "Use chat to search, create, update, and inspect Atlassian data.",
      state: hasConversation ? "done" : activeCloudId ? "active" : "pending",
    },
  ];
}

export default function App() {
  const [status, setStatus] = useState({
    connected: false,
    expiresAt: null,
    model: "",
    hasConversation: false,
    activeCloudId: null,
    lastOauthCallback: null,
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

  const resolvedCloudId = useMemo(() => resolveCloudId(cloudId, resources), [
    cloudId,
    resources,
  ]);
  const resolvedStatusCloudId = useMemo(
    () => resolveCloudId(status.activeCloudId, resources),
    [status.activeCloudId, resources],
  );
  const activeCloudId = resolvedStatusCloudId || resolvedCloudId || "";
  const chatReadiness = !status.connected
    ? "Connect Atlassian Rovo MCP to unlock the workspace."
    : activeCloudId
      ? `Requests will target ${activeCloudId}.`
      : "Choose a cloud site so the assistant can scope Jira and Confluence calls.";
  const readinessPill = !status.connected
    ? "Disconnected"
    : activeCloudId
      ? "Ready"
      : "Select site";
  const workflowSteps = buildWorkflowSteps({
    connected: status.connected,
    activeCloudId,
    hasConversation: status.hasConversation,
    busy,
  });
  const heroStats = [
    {
      label: "Model",
      value: status.model || "Unavailable",
    },
    {
      label: "Sites",
      value: `${resourceOptions.length}`,
    },
    {
      label: "Messages",
      value: `${messages.length}`,
    },
    {
      label: "Tool calls",
      value: `${toolCalls.length}`,
    },
  ];
  const oauthCallbackEntry = status.lastOauthCallback
    ? {
        name: "oauth2_callback",
        toolName: "Atlassian OAuth 2.1 callback",
        args: status.lastOauthCallback,
        preview:
          "Captured from /api/auth/atlassian/callback after the latest authorization attempt.",
        error:
          status.lastOauthCallback.result === "authorized"
            ? null
            : status.lastOauthCallback.error?.code ||
              "OAuth callback reported a failure.",
        isOauthCallback: true,
      }
    : null;
  const runLogEntries = oauthCallbackEntry
    ? [oauthCallbackEntry, ...toolCalls]
    : toolCalls;

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

  useEffect(() => {
    if (cloudId && resolvedCloudId && resolvedCloudId !== cloudId) {
      setCloudId(resolvedCloudId);
    }
  }, [cloudId, resolvedCloudId, setCloudId]);
  useEffect(() => {
    if (!status.lastOauthCallback) {
      return;
    }

    console.log(
      "Atlassian OAuth 2.1 callback response:",
      status.lastOauthCallback,
    );
  }, [status.lastOauthCallback]);

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
        activeCloudId: null,
        lastOauthCallback: null,
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

  function handleQuickPrompt(prompt) {
    setDraft(prompt);
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
      const requestCloudId = resolveCloudId(cloudId, resources);

      if (requestCloudId && looksLikeSiteDomain(requestCloudId)) {
        throw new Error(
          "Select a discovered site or enter the Atlassian cloud ID instead of the site domain.",
        );
      }

      const payload = await apiFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: userMessage.content,
          cloudId: requestCloudId || undefined,
        }),
      });

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            payload.text ||
            "The model returned no text. Check the execution log for details.",
        },
      ]);
      setToolCalls(payload.toolCalls ?? []);
      setStatus((current) => ({
        ...current,
        hasConversation: true,
        activeCloudId: requestCloudId || current.activeCloudId,
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
          <div className="hero-copy-block">
            <p className="eyebrow">Atlassian MCP + OpenAI</p>
            <h1>Operate Jira and Confluence from one workspace.</h1>
            <p className="hero-copy">
              This UI is structured around the real workflow in this project:
              authenticate against Atlassian Rovo MCP, scope the session to a cloud site,
              chat with the OpenAI-backed assistant, and inspect every MCP tool
              call the backend executes.
            </p>
          </div>

          <div className="hero-sidecard">
            <p className="panel-kicker">Run status</p>
            <h2>{readinessPill === "Ready" ? "Workspace armed" : "Setup in progress"}</h2>
            <p className="panel-note">{chatReadiness}</p>

            <div className="hero-stat-grid">
              {heroStats.map((stat) => (
                <div className="hero-stat" key={stat.label}>
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="workflow-strip">
          {workflowSteps.map((step, index) => (
            <article className="workflow-step" data-state={step.state} key={step.label}>
              <span className="workflow-index">0{index + 1}</span>
              <div>
                <p>{step.label}</p>
                <h2>{step.title}</h2>
                <span>{step.detail}</span>
              </div>
            </article>
          ))}
        </section>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="workspace-grid">
          <aside className="rail setup-rail">
            <article className="panel panel-emphasis">
              <p className="panel-kicker">Mission control</p>
              <h2>Prepare the session</h2>
              <p className="panel-note">
                Keep setup on the left so the center workspace stays focused on
                conversations and outputs.
              </p>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Connection</p>
                  <h2>Rovo MCP auth</h2>
                </div>
                <span className={status.connected ? "status-pill ok" : "status-pill"}>
                  {status.connected ? "Connected" : "Disconnected"}
                </span>
              </div>

              <div className="metric-stack">
                <div className="metric-card">
                  <span>Token expiry</span>
                  <strong>{formatExpiry(status.expiresAt)}</strong>
                </div>
                <div className="metric-card">
                  <span>Conversation</span>
                  <strong>{status.hasConversation ? "Active" : "Not started"}</strong>
                </div>
              </div>

              <div className="button-row">
                <button className="primary-button" onClick={handleConnect} disabled={busy}>
                  Connect Atlassian Rovo MCP
                </button>
                <button className="ghost-button" onClick={handleDisconnect} disabled={busy}>
                  Disconnect
                </button>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Scope</p>
                  <h2>Cloud site</h2>
                </div>
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

              <div className="metric-card metric-inline">
                <span>Active target</span>
                <strong>{activeCloudId || "Not selected"}</strong>
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Jump start</p>
                  <h2>Quick asks</h2>
                </div>
              </div>

              <div className="prompt-list">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    className="prompt-chip"
                    key={prompt}
                    onClick={() => handleQuickPrompt(prompt)}
                    disabled={busy}
                    type="button"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </article>
          </aside>

          <section className="conversation-column">
            <article className="panel chat-panel">
              <div className="panel-heading panel-heading-spread">
                <div>
                  <p className="panel-kicker">Conversation</p>
                  <h2>Atlassian operator</h2>
                  <p className="panel-note">{chatReadiness}</p>
                </div>

                <div className="button-row compact-row">
                  <span className={activeCloudId ? "status-pill ok" : "status-pill"}>
                    {readinessPill}
                  </span>
                  <button
                    className="ghost-button slim"
                    onClick={handleResetConversation}
                    disabled={busy}
                  >
                    Reset chat
                  </button>
                </div>
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
                <div className="composer-meta">
                  <span>Selected site</span>
                  <strong>{activeCloudId || "Choose one before issuing scoped work"}</strong>
                </div>

                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Ask for Jira search, issue creation, issue updates, Confluence lookup, or any other Atlassian action your MCP session exposes."
                  rows={5}
                  disabled={busy}
                />

                <div className="button-row composer-actions">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={busy || !status.connected}
                  >
                    {busy ? "Working..." : "Send request"}
                  </button>
                  <span className="composer-note">
                    Every tool invocation is logged in the execution rail.
                  </span>
                </div>
              </form>
            </article>
          </section>

          <aside className="rail activity-rail">
            <article className="panel tool-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Execution</p>
                  <h2>Run log</h2>
                </div>
                <span className="status-pill">{runLogEntries.length} entries</span>
              </div>

              <div className="tool-list">
                {runLogEntries.length === 0 ? (
                  <div className="empty-state">
                    <strong>No tool activity yet</strong>
                    <p>
                      Once you send a request, the resolved MCP tool names,
                      arguments, previews, and any failures will appear here.
                    </p>
                  </div>
                ) : (
                  runLogEntries.map((toolCall, index) => (
                    <div className="tool-card" key={`${toolCall.name}-${index}`}>
                      <div className="tool-head">
                        <strong>{toolCall.name}</strong>
                        <span>{toolCall.toolName || "No MCP tool resolved"}</span>
                      </div>
                      {toolCall.isOauthCallback ? (
                        <>
                          <pre>{JSON.stringify(toolCall.args, null, 2)}</pre>
                          {toolCall.error ? (
                            <p className="tool-error">{toolCall.error}</p>
                          ) : null}
                          <p>{toolCall.preview}</p>
                        </>
                      ) : toolCall.error ? (
                        <>
                          <p className="tool-error">{toolCall.error}</p>
                          {toolCall.details ? (
                            <pre>{JSON.stringify(toolCall.details, null, 2)}</pre>
                          ) : null}
                        </>
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

            <article className="panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">Snapshot</p>
                  <h2>Session facts</h2>
                </div>
              </div>

              <div className="metric-stack">
                <div className="metric-card">
                  <span>Model</span>
                  <strong>{status.model || "Unavailable"}</strong>
                </div>
                <div className="metric-card">
                  <span>Loaded sites</span>
                  <strong>{resourceOptions.length}</strong>
                </div>
                <div className="metric-card">
                  <span>Messages</span>
                  <strong>{messages.length}</strong>
                </div>
                <div className="metric-card">
                  <span>Last known cloud</span>
                  <strong>{activeCloudId || "None"}</strong>
                </div>
              </div>
            </article>
          </aside>
        </section>
      </main>
    </div>
  );
}





