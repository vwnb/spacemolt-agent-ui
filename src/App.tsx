import { useCallback, useEffect, useState } from "react";
import {
  SignInButton,
  Show,
  UserButton,
  useAuth,
} from "@clerk/react";

const BACKEND_URL = (
  import.meta.env.VITE_BACKEND_URL ||
  "https://spacemolt-agent-backend.vercel.app"
).replace(/\/+$/, "");

type Mode = "browser" | "register";
type Empire = "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";

type Proposal = {
  summary?: unknown;
  should_act?: unknown;
  proposed_action?: unknown;
  confidence?: unknown;
  risks?: unknown;
};

type Account = {
  username?: string;
  playerId?: string;
  password?: string;
};

type ConnectResult = {
  ok: boolean;
  mode: string;
  sessionId?: string;
  observed: { hasStatus: boolean; notificationCount: number };
  proposal?: Proposal | null;
  reasoning_error?: string;
  error?: string | null;
  account?: Account;
  auth?: { mode: "register" | "login_link"; message?: string };
};

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_CHAT_HISTORY = 20;

function trimChatHistory(history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-MAX_CHAT_HISTORY);
  return recent[0]?.role === "assistant" ? recent.slice(1) : recent;
}

type ModelChoice = { id: string; label: string };

type ProviderChoice = { key: string; label: string; envKey?: string; defaultModel?: string };

type GameActionRecord = {
  action: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: string;
  error?: string;
};

type PendingAction = {
  id?: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
  reason?: string;
  approval: true;
};

type ChatResult = {
  ok?: unknown;
  reply?: unknown;
  actions?: GameActionRecord[];
  pending_actions?: unknown;
  context?: { hasStatus?: unknown; pilot?: unknown };
  error?: unknown;
};

type LinkStart = {
  linkSessionId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  instructions: string;
  interval: number;
  expiresIn: number;
};

type PollResponse = (
  | { complete: false; status: string; interval?: number }
  | (ConnectResult & { complete: true })
) & { error?: string };

const EMPIRES: { value: Empire; label: string }[] = [
  { value: "solarian", label: "Solarian — balanced" },
  { value: "voidborn", label: "Voidborn — stealth/shields" },
  { value: "crimson", label: "Crimson — combat" },
  { value: "nebula", label: "Nebula — cargo" },
  { value: "outerrim", label: "Outer Rim — speed" },
];

function safeText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function safeList(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map(safeText).join(", ") : "none";
  return safeText(value);
}

function parseModelChoices(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ModelChoice[] => {
    if (!entry || typeof entry !== "object") return [];
    const choice = entry as Record<string, unknown>;
    return typeof choice.id === "string" && typeof choice.label === "string"
      ? [{ id: choice.id, label: choice.label }]
      : [];
  });
}

function parseProviderChoices(value: unknown): ProviderChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ProviderChoice[] => {
    if (!entry || typeof entry !== "object") return [];
    const provider = entry as Record<string, unknown>;
    return typeof provider.key === "string" && typeof provider.label === "string"
      ? [{
          key: provider.key,
          label: provider.label,
          envKey: typeof provider.envKey === "string" ? provider.envKey : undefined,
          defaultModel: typeof provider.defaultModel === "string" ? provider.defaultModel : undefined,
        }]
      : [];
  });
}

function parseModelOptionsByProvider(value: unknown): Record<string, ModelChoice[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, ModelChoice[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      result[key] = parseModelChoices((entry as Record<string, unknown>).choices);
    }
  }
  return result;
}

function shortModelLabel(id: string): string {
  return (id.split("/").pop() ?? id).replace(/:free$/, "");
}

function confidenceLabel(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value <= 1 ? `${Math.round(value * 100)}%` : `${value}`;
  }
  return safeText(value);
}

function actionLabel(action: GameActionRecord): string {
  const args = Object.entries(action.args ?? {})
    .map(([key, value]) => `${key}=${safeText(value)}`)
    .join(", ");
  return `${action.ok ? "ok" : "failed"} ${safeText(action.action)}${args ? ` (${args})` : ""}`;
}

function parsePendingActions(value: unknown): PendingAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index): PendingAction[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.action !== "string" || !item.action) return [];
    const args = item.args && typeof item.args === "object" && !Array.isArray(item.args)
      ? item.args as Record<string, unknown>
      : {};
    return [{
      id: typeof item.id === "string" && item.id ? item.id : `pending-${Date.now().toString(36)}-${index + 1}`,
      tool: typeof item.tool === "string" && item.tool ? item.tool : "spacemolt",
      action: item.action,
      args,
      reason: typeof item.reason === "string" ? item.reason : undefined,
      approval: true,
    }];
  });
}

const EDITABLE_TEXT_FIELDS = ["content", "message", "title", "description"] as const;
type EditableTextField = (typeof EDITABLE_TEXT_FIELDS)[number];

function draftKey(action: PendingAction, field: EditableTextField): string {
  return `${action.id ?? ""}:${field}`;
}

function editableTextFields(action: PendingAction): EditableTextField[] {
  return EDITABLE_TEXT_FIELDS.filter(
    (field) => typeof action.args[field] === "string",
  );
}

function applyDraftEdits(actions: PendingAction[], drafts: Record<string, string>): PendingAction[] {
  return actions.map((action) => {
    const args = { ...action.args };
    for (const field of editableTextFields(action)) {
      const draft = drafts[draftKey(action, field)];
      if (draft !== undefined) args[field] = draft;
    }
    return { ...action, args };
  });
}

function clearDraftEdits(drafts: Record<string, string>, actions: PendingAction[]): Record<string, string> {
  const removals = new Set(actions.flatMap((action) => editableTextFields(action).map((field) => draftKey(action, field))));
  return Object.fromEntries(Object.entries(drafts).filter(([key]) => !removals.has(key)));
}

function hasEmptyDraft(action: PendingAction, drafts: Record<string, string>): boolean {
  return editableTextFields(action).some((field) => {
    const draft = drafts[draftKey(action, field)];
    return draft !== undefined && draft.trim().length === 0;
  });
}

async function readJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`);
  }
  return data ?? {};
}

export default function App() {
  const { signOut } = useAuth();
  const [mode, setMode] = useState<Mode>("browser");
  const [username, setUsername] = useState("");
  const [empire, setEmpire] = useState<Empire>("solarian");
  const [registrationCode, setRegistrationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollStatus, setPollStatus] = useState("");
  const [link, setLink] = useState<LinkStart | null>(null);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [objective, setObjective] = useState("");
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [providerChoices, setProviderChoices] = useState<ProviderChoice[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [modelChoicesByProvider, setModelChoicesByProvider] = useState<Record<string, ModelChoice[]>>({});
  const [selectedModel, setSelectedModel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  useEffect(() => {
    let cancelled = false;
    readJson(`${BACKEND_URL}/api/health`)
      .then((data) => {
        if (cancelled) return;
        const providers = parseProviderChoices(data.llmProviders);
        const byProvider = parseModelOptionsByProvider(data.llmModelOptionsByProvider);
        const serverProvider = typeof data.llmProvider === "string" ? data.llmProvider : "";
        setProviderChoices(providers);
        setModelChoicesByProvider(byProvider);
        setDefaultProvider(serverProvider);
        setSelectedProvider(serverProvider);
        setModelChoices(byProvider[serverProvider] ?? parseModelChoices(data.llmModelOptions));
        if (typeof data.llmModel === "string") setDefaultModel(data.llmModel);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const startLink = useCallback(async () => {
    setBusy(true);
    setError("");
    setPollStatus("");
    setResult(null);
    try {
      const data = await readJson(`${BACKEND_URL}/api/login-link`, { method: "POST" });
      setLink(data as unknown as LinkStart);
      setPollStatus("Link ready — approve it in the SpaceMolt tab.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const data = await readJson(`${BACKEND_URL}/api/login-link-poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            linkSessionId: link.linkSessionId,
            deviceCode: link.deviceCode,
          }),
        }) as PollResponse;

        if (cancelled) return;
        if (data.complete) {
          setResult(data);
          if (typeof data.sessionId === "string") setSessionId(data.sessionId);
          setLink(null);
          setPollStatus("");
          return;
        }
        if (data.status === "access_denied" || data.status === "expired_token") {
          setError(`SpaceMolt sign-in ${data.status === "expired_token" ? "expired" : "was declined"}. Start a new link.`);
          setLink(null);
          setPollStatus("");
          return;
        }

        setPollStatus(`Waiting for approval… (${data.status})`);
        timer = window.setTimeout(() => void poll(), Math.max(2, data.interval ?? link.interval) * 1000);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLink(null);
          setPollStatus("");
        }
      }
    };

    timer = window.setTimeout(() => void poll(), Math.max(2, link.interval) * 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [link]);

  const register = useCallback(async () => {
    setBusy(true);
    setError("");
    setPollStatus("");
    setResult(null);

    try {
      const cleanUsername = username.trim();
      const cleanCode = registrationCode.trim();
      if (!cleanUsername) throw new Error("Enter a SpaceMolt username.");
      if (!cleanCode) throw new Error("Enter the registration code from your SpaceMolt dashboard.");

      const data = await readJson(`${BACKEND_URL}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: cleanUsername,
          empire,
          registrationCode: cleanCode,
        }),
      });
      const connected = data as unknown as ConnectResult;
      setResult(connected);
      if (typeof connected.sessionId === "string") setSessionId(connected.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [username, empire, registrationCode]);

  const submitChat = useCallback(async (message: string) => {
    const clean = message.trim();
    if (!clean) return;
    if (!sessionId) {
      setChatError("Connect a pilot first.");
      return;
    }

    const next = trimChatHistory([...chatHistory, { role: "user" as const, content: clean }]);
    setChatHistory(next);
    setChatInput("");
    setChatBusy(true);
    setChatError("");

    try {
      const data = await readJson(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: clean,
          objective: objective.trim() || undefined,
          provider: selectedProvider || defaultProvider || undefined,
          history: next.slice(0, -1),
          model: selectedModel || undefined,
        }),
      });
      const chat = data as unknown as ChatResult;
      const actions = Array.isArray(chat.actions) ? chat.actions : [];
      const pending = parsePendingActions(chat.pending_actions);
      const details = actions.length
        ? `\n\nActions:\n${actions.map(actionLabel).join("\n")}`
        : "";
      const approvalNote = pending.length
        ? `\n\n${pending.length} action(s) are waiting for your approval below.`
        : "";
      const reply = safeText(chat.reply);
      setPendingActions(pending);
      setChatHistory(trimChatHistory([...next, {
        role: "assistant",
        content: `${reply === "—" ? "No reply." : reply}${details}${approvalNote}`,
      }]));
      if (chat.error) setChatError(safeText(chat.error));
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      setChatHistory(trimChatHistory([...next, { role: "assistant", content: `Error: ${messageText}` }]));
      setChatError(messageText);
    } finally {
      setChatBusy(false);
    }
  }, [sessionId, chatHistory, objective, selectedProvider, defaultProvider, selectedModel]);

  const approveActions = useCallback(async (actions: PendingAction[]) => {
    if (!sessionId || actions.length === 0) return;
    const ids = new Set(actions.map((action) => action.id).filter((id): id is string => Boolean(id)));
    const preparedActions = applyDraftEdits(actions, draftEdits).map((action) => ({
      id: action.id,
      tool: action.tool,
      action: action.action,
      args: action.args,
      reason: action.reason,
    }));
    setApprovalBusy(true);
    setChatError("");

    try {
      const data = await readJson(`${BACKEND_URL}/api/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, actions: preparedActions }),
      });
      const results = Array.isArray(data.actions) ? data.actions as GameActionRecord[] : [];
      setPendingActions((current) => current.filter((action) => !action.id || !ids.has(action.id)));
      setDraftEdits((current) => clearDraftEdits(current, actions));
      setChatHistory((current) => [...current, {
        role: "assistant",
        content: `Approved ${actions.length} action(s).\n\nActions:\n${results.map(actionLabel).join("\n")}`,
      }]);
      if (data.error) setChatError(safeText(data.error));
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      setChatError(messageText);
      setChatHistory((current) => [...current, {
        role: "assistant",
        content: `Approval failed: ${messageText}`,
      }]);
    } finally {
      setApprovalBusy(false);
    }
  }, [sessionId, draftEdits]);

  const declineActions = useCallback((actions: PendingAction[]) => {
    const ids = new Set(actions.map((action) => action.id).filter((id): id is string => Boolean(id)));
    setPendingActions((current) => current.filter((action) => !action.id || !ids.has(action.id)));
    setDraftEdits((current) => clearDraftEdits(current, actions));
    setChatHistory((current) => [...current, {
      role: "assistant",
      content: `Declined ${actions.length} action(s). Nothing was sent to SpaceMolt.`,
    }]);
  }, []);

  return (
    <>
      <style>{styles}</style>
      <main>
        <header>
          <h1>SpaceMolt Observer</h1>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button type="button">Sign in</button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <div className="row">
              <UserButton />
              <button type="button" className="secondary" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </Show>
        </header>

        <Show when="signed-in">
          <section>
            <h2>Connect a SpaceMolt pilot</h2>
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                if (mode === "browser") void startLink();
                else void register();
              }}
            >
              <label>
                Connection
                <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                  <option value="browser">Use SpaceMolt browser sign-in</option>
                  <option value="register">Create pilot with registration code</option>
                </select>
              </label>

              {mode === "register" && (
                <>
                  <label>
                    Username
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      maxLength={24}
                      placeholder="New pilot name"
                    />
                  </label>
                  <label>
                    Empire
                    <select value={empire} onChange={(event) => setEmpire(event.target.value as Empire)}>
                      {EMPIRES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Registration code
                    <input
                      value={registrationCode}
                      onChange={(event) => setRegistrationCode(event.target.value)}
                      placeholder="From spacemolt.com/dashboard"
                    />
                  </label>
                </>
              )}

              <button type="submit" disabled={busy || link !== null}>
                {busy
                  ? "Connecting…"
                  : mode === "browser"
                    ? "Open SpaceMolt sign-in"
                    : "Create & observe"}
              </button>
            </form>

            {mode === "browser" && (
              <p className="meta">
                You sign in on SpaceMolt with Google, choose the pilot, and approve. No SpaceMolt password is needed here.
              </p>
            )}
            {mode === "register" && (
              <p className="meta">
                A random password is generated by SpaceMolt and shown once after registration.
              </p>
            )}
          </section>

          {link && (
            <section>
              <h2>Approve SpaceMolt sign-in</h2>
              <p className="code">{link.userCode}</p>
              <p>{link.instructions}</p>
              <p>
                <a href={link.verificationUriComplete} target="_blank" rel="noreferrer">
                  {link.verificationUriComplete}
                </a>
              </p>
              {pollStatus && <p className="meta">{pollStatus}</p>}
              <button type="button" className="secondary" onClick={() => void startLink()}>
                Start a new link
              </button>
            </section>
          )}

          {error && <p className="error">{error}</p>}

          {result && (
            <section>
              <h2>Result</h2>
              <p className="meta">
                ok: {String(result.ok)} · mode: {result.auth?.mode || result.mode || "—"}
              </p>
              <p className="meta">
                hasStatus: {String(result.observed?.hasStatus)} ·
                notifications: {result.observed?.notificationCount ?? 0}
              </p>
              {result.auth?.message && <p className="meta">{safeText(result.auth.message)}</p>}
              {result.account && (
                <p className="meta">
                  pilot: {safeText(result.account.username || result.account.playerId)}
                </p>
              )}
              {result.account?.password && (
                <p className="notice">
                  Save this generated password now: {safeText(result.account.password)}. SpaceMolt cannot recover it.
                </p>
              )}
              {result.error && <p className="error">{safeText(result.error)}</p>}
              {result.reasoning_error && <p className="meta">Proposal unavailable: {safeText(result.reasoning_error)}</p>}
              {result.proposal && (
                <dl>
                  <dt>Summary</dt>
                  <dd>{safeText(result.proposal.summary)}</dd>
                  <dt>Should act</dt>
                  <dd>{safeText(result.proposal.should_act)}</dd>
                  <dt>Proposed action</dt>
                  <dd>{safeText(result.proposal.proposed_action)}</dd>
                  <dt>Confidence</dt>
                  <dd>{confidenceLabel(result.proposal.confidence)}</dd>
                  <dt>Risks</dt>
                  <dd>{safeList(result.proposal.risks)}</dd>
                </dl>
              )}
            </section>
          )}

          {sessionId && (
            <section>
              <h2>Pilot chat</h2>
              <p className="meta">
                Connected as {result?.account?.username || result?.account?.playerId || "pilot"}. The agent can read state and run
                safe actions. Combat, player chat, gifts, trades and other write actions appear here for approval first.
              </p>

              <div className="model-row">
                <label htmlFor="provider-select">LLM provider</label>
                <select
                  id="provider-select"
                  value={selectedProvider}
                  onChange={(event) => {
                    const key = event.target.value;
                    setSelectedProvider(key);
                    setSelectedModel("");
                    setModelChoices(modelChoicesByProvider[key] ?? []);
                  }}
                  disabled={chatBusy}
                >
                  <option value="">
                    Server default{defaultProvider ? ` (${defaultProvider})` : ""}
                  </option>
                  {providerChoices.map((provider) => (
                    <option key={provider.key} value={provider.key}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="model-row">
                <label htmlFor="model-select">LLM model</label>
                <select
                  id="model-select"
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={chatBusy}
                >
                  <option value="">
                    Provider default{defaultModel && selectedProvider === defaultProvider ? ` (${shortModelLabel(defaultModel)})` : ""}
                  </option>
                  {modelChoices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="objective">
                <label htmlFor="agent-objective">Personal objective</label>
                <textarea
                  id="agent-objective"
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  rows={2}
                  placeholder="Example: finish the courier chain, then save credits for a hauler."
                  disabled={chatBusy}
                />
                <p className="meta">Sent with every message. Active missions still take priority.</p>
              </div>

              {chatHistory.length === 0 && (
                <div className="quick">
                  <button type="button" className="secondary" onClick={() => void submitChat("Where am I and what should I do next?")}>
                    Where am I?
                  </button>
                  <button type="button" className="secondary" onClick={() => void submitChat("Mine here, then tell me what is in cargo.")}>
                    Mine here
                  </button>
                  <button type="button" className="secondary" onClick={() => void submitChat("Dock, sell my ore, and refuel.")}>
                    Dock, sell & refuel
                  </button>
                </div>
              )}

              {chatHistory.length > 0 && (
                <div className="chat">
                  {chatHistory.map((message, index) => (
                    <div className={`chat-line ${message.role}`} key={index}>
                      <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                      <span>{message.content}</span>
                    </div>
                  ))}
                </div>
              )}

              {pendingActions.length > 0 && (
                <div className="pending">
                  <div className="pending-head">
                    <strong>Awaiting approval</strong>
                    <button
                      type="button"
                      className="secondary"
                      disabled={approvalBusy || chatBusy || pendingActions.some((action) => hasEmptyDraft(action, draftEdits))}
                      onClick={() => void approveActions(pendingActions)}
                    >
                      Approve all
                    </button>
                  </div>
                  {pendingActions.map((action) => (
                    <div className="pending-card" key={action.id}>
                      <div className="pending-title">{safeText(action.tool)}/{safeText(action.action)}</div>
                      <pre className="pending-args">{safeText(action.args)}</pre>
                      {editableTextFields(action).map((field) => {
                        const key = draftKey(action, field);
                        const value = draftEdits[key] ?? String(action.args[field] ?? "");
                        const label = field === "content" ? "Exact text to send" : field[0].toUpperCase() + field.slice(1);
                        return (
                          <label className="draft-label" key={key} htmlFor={`draft-${key}`}>
                            {label}
                            <textarea
                              id={`draft-${key}`}
                              value={value}
                              onChange={(event) => setDraftEdits((current) => ({ ...current, [key]: event.target.value }))}
                              rows={Math.min(10, Math.max(2, value.split("\n").length + 1))}
                              disabled={approvalBusy || chatBusy}
                            />
                          </label>
                        );
                      })}
                      {action.reason && <p className="meta">Reason: {safeText(action.reason)}</p>}
                      <div className="pending-buttons">
                        <button
                          type="button"
                          disabled={approvalBusy || chatBusy || hasEmptyDraft(action, draftEdits)}
                          onClick={() => void approveActions([action])}
                        >
                          {editableTextFields(action).length ? "Approve & send" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={approvalBusy || chatBusy}
                          onClick={() => declineActions([action])}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form
                className="chat-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitChat(chatInput);
                }}
              >
                <label className="ask-label" htmlFor="agent-message">Ask the agent</label>
                <textarea
                  id="agent-message"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  rows={3}
                  placeholder="Check status, travel, mine, dock, sell, refuel…"
                />
                <div className="chat-actions">
                  <button type="submit" disabled={chatBusy || !chatInput.trim()}>
                    {chatBusy ? "Thinking…" : "Send"}
                  </button>
                </div>
              </form>
              {chatError && <p className="error">{chatError}</p>}
            </section>
          )}
        </Show>
      </main>
    </>
  );
}

const styles = `
  :root {
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    color: #e6e8eb;
    background: #101216;
    font-feature-settings: "kern" 1, "liga" 1;
  }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { max-width: 46rem; margin: 3rem auto; padding: 0 1rem; min-width: 0; }
  header, .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.015em; }
  h2 { font-size: 1.1rem; font-weight: 600; letter-spacing: 0.015em; }
  section { margin-top: 1.5rem; padding: 1rem; border: 1px solid #2a2f38; border-radius: 3px; min-width: 0; }
  button, input, select, textarea { font: inherit; padding: 0.5rem 0.75rem; border-radius: 2px; border: 1px solid #3a4150; background: #1d222b; color: inherit; }
  button { cursor: pointer; background: #2563eb; border-color: #2563eb; }
  button.secondary { background: #1d222b; border-color: #3a4150; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  section > button { margin-left: 0.5rem; }
  .form { display: grid; gap: 0.75rem; }
  .form label { display: grid; gap: 0.35rem; color: #9aa3b2; }
  a { color: #93c5fd; overflow-wrap: anywhere; }
  .code { font-size: 1.4rem; font-weight: 700; letter-spacing: 0.1em; }
  .error { color: #fca5a5; }
  .notice { color: #fcd34d; }
  .meta { color: #9aa3b2; }
  .model-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .model-row label { color: #9aa3b2; font-size: 0.85rem; letter-spacing: 0.02em; }
  .model-row select { min-width: 16rem; max-width: 100%; }
  .quick { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
  .quick button { margin: 0; }
  .chat { display: grid; gap: 0.75rem; margin-bottom: 0.75rem; min-width: 0; }
  .chat-line { display: grid; gap: 0.2rem; padding: 0.5rem 0.75rem; border-radius: 2px; background: #171b22; min-width: 0; }
  .chat-line strong { color: #9aa3b2; font-size: 0.8rem; }
  .chat-line span { white-space: pre-wrap; overflow-wrap: anywhere; }
  .chat-line.assistant { border-left: 3px solid #2563eb; }
  .objective { display: grid; gap: 0.4rem; margin-bottom: 0.75rem; min-width: 0; }
  .objective label, .draft-label { color: #cbd5e1; font-size: 0.9rem; letter-spacing: 0.02em; }
  .objective textarea { width: 100%; min-width: 0; resize: vertical; }
  .objective .meta { margin: 0; font-size: 0.8rem; }
  .chat-form { display: grid; gap: 0.5rem; min-width: 0; }
  .ask-label { color: #cbd5e1; font-size: 0.9rem; letter-spacing: 0.02em; }
  .chat-form textarea { width: 100%; min-width: 0; resize: vertical; }
  .chat-actions { display: flex; justify-content: flex-end; }
  .chat-actions button { margin: 0; }
  .pending { display: grid; gap: 0.75rem; margin-bottom: 0.75rem; min-width: 0; }
  .pending-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .pending-head button { margin: 0; }
  .pending-card { display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid #3a4150; border-radius: 2px; min-width: 0; }
  .pending-title { color: #fcd34d; overflow-wrap: anywhere; }
  .pending-args { margin: 0; padding: 0.5rem; border-radius: 2px; background: #171b22; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .draft-label { display: grid; gap: 0.35rem; }
  .draft-label textarea { width: 100%; min-width: 0; resize: vertical; }
  .pending-buttons { display: flex; gap: 0.5rem; }
  .pending-buttons button { margin: 0; }
  dl { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: 0.4rem 1rem; margin: 0; }
  dt { color: #9aa3b2; }
  dd { margin: 0; overflow-wrap: anywhere; }
`;
