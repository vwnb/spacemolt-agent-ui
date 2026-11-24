import { useCallback, useEffect, useRef, useState } from "react";
import {
  SignInButton,
  Show,
  UserButton,
  useAuth,
} from "@clerk/react";
import {
  HttpError,
  isDefiniteRequestFailure,
  locationMatchesStep,
  locationPlaceLabel,
  type RouteStep,
  type TransitLocation,
} from "./route.js";
import { loadLlmSelection, resolveLlmSelection, saveLlmModel, saveLlmProvider } from "./preferences.js";

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

type WorkingTask = { label: string; startedAt: number };

type RetryRequest =
  | { kind: "chat"; message: string }
  | { kind: "execute"; actions: PendingAction[] }
  | { kind: "action"; tool: string; action: string; args: Record<string, unknown> }
  | { kind: "route"; plan: RoutePlan };

type RoutePlan = {
  destination: string;
  steps: RouteStep[];
  totalJumps: number;
  targetSystem?: string;
  targetPoi?: string;
  targetPoiName?: string;
  message?: string;
  estimatedFuel?: number;
  fuelAvailable?: number;
};

type RouteRun = {
  plan: RoutePlan;
  index: number;
  status: "running" | "stopped" | "done" | "error";
  error?: string;
};

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
  structured?: unknown;
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
  routes?: unknown;
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function transitLabel(location: TransitLocation | null): string {
  if (!location || location.in_transit !== true) return "";
  const kind = safeText(location.transit_type);
  const destination = safeText(
    location.transit_dest_system_name
    ?? location.transit_dest_system_id
    ?? location.transit_dest_poi_name
    ?? location.transit_dest_poi_id
    ?? "destination",
  );
  const rawTick = location.transit_arrival_tick;
  const tick = typeof rawTick === "number" ? rawTick : typeof rawTick === "string" ? Number(rawTick) : NaN;
  const arrival = Number.isFinite(tick) ? ` · arrival tick ${tick}` : "";
  return `${kind === "pathfinder" ? "Drifting" : kind === "travel" ? "Traveling" : "Jumping"} to ${destination}${arrival}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRoutePlan(value: unknown, fallbackDestination: string): RoutePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.found === false) return null;
  const rawSteps = Array.isArray(payload.route) ? payload.route : payload.steps;
  if (!Array.isArray(rawSteps)) return null;

  const steps: RouteStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as Record<string, unknown>;
    const systemId = textOrUndefined(step.systemId) ?? textOrUndefined(step.system_id);
    const jumps = numberOrUndefined(step.jumps);
    if (!systemId || jumps === undefined || jumps <= 0) continue;
    const kind = textOrUndefined(step.kind) ?? textOrUndefined(step.type);
    steps.push({
      systemId,
      name: textOrUndefined(step.name),
      jumps,
      kind: kind === "travel" || kind === "jump" ? kind : undefined,
    });
  }
  if (steps.length === 0) return null;
  steps.sort((left, right) => left.jumps - right.jumps);

  const totalJumps = numberOrUndefined(payload.totalJumps) ?? numberOrUndefined(payload.total_jumps) ?? steps.length;
  const targetPoi = textOrUndefined(payload.targetPoi) ?? textOrUndefined(payload.target_poi);
  if (targetPoi) {
    steps.push({
      systemId: targetPoi,
      name: textOrUndefined(payload.targetPoiName) ?? textOrUndefined(payload.target_poi_name) ?? targetPoi,
      jumps: totalJumps,
      kind: "travel",
    });
  }

  return {
    destination: textOrUndefined(payload.destination)
      ?? textOrUndefined(payload.target_poi)
      ?? textOrUndefined(payload.targetPoi)
      ?? textOrUndefined(payload.target_system)
      ?? textOrUndefined(payload.targetSystem)
      ?? fallbackDestination,
    steps,
    totalJumps,
    targetSystem: textOrUndefined(payload.targetSystem) ?? textOrUndefined(payload.target_system),
    targetPoi,
    targetPoiName: textOrUndefined(payload.targetPoiName) ?? textOrUndefined(payload.target_poi_name),
    message: textOrUndefined(payload.message),
    estimatedFuel: numberOrUndefined(payload.estimatedFuel) ?? numberOrUndefined(payload.estimated_fuel),
    fuelAvailable: numberOrUndefined(payload.fuelAvailable) ?? numberOrUndefined(payload.fuel_available),
  };
}

function routeStepLabel(step: RouteStep): string {
  return step.name ?? step.systemId;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let timer: number | undefined;
    const onAbort = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
    throw new HttpError(res.status, typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`);
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
  const abortRef = useRef<AbortController | null>(null);
  const [task, setTask] = useState<WorkingTask | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [location, setLocation] = useState<TransitLocation | null>(null);
  const [tracking, setTracking] = useState(false);
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const [routeInput, setRouteInput] = useState("");
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routeRun, setRouteRun] = useState<RouteRun | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
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
        const fallbackModels = parseModelChoices(data.llmModelOptions);
        const serverProvider = typeof data.llmProvider === "string" ? data.llmProvider : "";
        if (serverProvider && !byProvider[serverProvider]) byProvider[serverProvider] = fallbackModels;
        const selected = resolveLlmSelection(
          loadLlmSelection(),
          providers.map((provider) => provider.key),
          Object.fromEntries(Object.entries(byProvider).map(([key, choices]) => [key, choices.map((choice) => choice.id)])),
          serverProvider,
        );
        setProviderChoices(providers);
        setModelChoicesByProvider(byProvider);
        setDefaultProvider(serverProvider);
        setDefaultModel(typeof data.llmModel === "string" ? data.llmModel : "");
        setSelectedProvider(selected.provider);
        setModelChoices(byProvider[selected.provider || serverProvider] ?? []);
        setSelectedModel(selected.model);
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

  const beginTask = useCallback((label: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTask({ label, startedAt: Date.now() });
    setElapsed(0);
    setTracking(true);
    return controller;
  }, []);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTask(null);
    setChatBusy(false);
    setApprovalBusy(false);
    setRouteRun((current) => current?.status === "running" ? { ...current, status: "stopped" } : current);
    setChatHistory((current) => trimChatHistory([...current, {
      role: "assistant",
      content: "Interrupted locally — stopped waiting here. Anything already sent to SpaceMolt may still complete.",
    }]));
  }, []);

  useEffect(() => {
    if (!task) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - task.startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [task]);

  useEffect(() => {
    if (!sessionId || !tracking) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const data = await readJson(`${BACKEND_URL}/api/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (cancelled) return;
        const raw = data.location;
        const parsed = raw && typeof raw === "object" ? raw as TransitLocation : null;
        setLocation(parsed);
        if (parsed?.in_transit !== true && !abortRef.current) setTracking(false);
      } catch {
        if (!cancelled && !abortRef.current) setTracking(false);
      }
      if (!cancelled && timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          void poll();
        }, 2500);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId, tracking]);

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
    setRetryRequest({ kind: "chat", message: clean });
    const controller = beginTask("Agent turn");

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
        signal: controller.signal,
      });
      const chat = data as unknown as ChatResult;
      const actions = Array.isArray(chat.actions) ? chat.actions : [];
      const pending = parsePendingActions(chat.pending_actions);
      const foundRoutes = Array.isArray(chat.routes)
        ? chat.routes.flatMap((route) => {
          const parsed = parseRoutePlan(route, "");
          return parsed ? [parsed] : [];
        })
        : [];
      if (foundRoutes.length > 0) setRoutePlan(foundRoutes[0]);
      const details = actions.length
        ? `\n\nActions:\n${actions.map(actionLabel).join("\n")}`
        : "";
      const approvalNote = pending.length
        ? `\n\n${pending.length} action(s) are waiting for your approval below.`
        : "";
      const routeNote = foundRoutes.length > 0
        ? `\n\nRoute ready: ${foundRoutes[0].totalJumps} jump(s). Press Follow route below to travel.`
        : "";
      const reply = safeText(chat.reply);
      setPendingActions(pending);
      setChatHistory(trimChatHistory([...next, {
        role: "assistant",
        content: `${reply === "—" ? "No reply." : reply}${details}${approvalNote}${routeNote}`,
      }]));
      if (chat.error) setChatError(safeText(chat.error));
      setRetryRequest(null);
    } catch (err) {
      if (isAbortError(err)) return;
      const messageText = err instanceof Error ? err.message : String(err);
      setChatHistory(trimChatHistory([...next, { role: "assistant", content: `Error: ${messageText}` }]));
      setChatError(messageText);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setTask(null);
        setChatBusy(false);
      }
    }
  }, [sessionId, chatHistory, objective, selectedProvider, defaultProvider, selectedModel, beginTask]);

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
    setRetryRequest({ kind: "execute", actions });
    const controller = beginTask(`${actions.length} approved action(s)`);

    try {
      const data = await readJson(`${BACKEND_URL}/api/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, actions: preparedActions }),
        signal: controller.signal,
      });
      const results = Array.isArray(data.actions) ? data.actions as GameActionRecord[] : [];
      setPendingActions((current) => current.filter((action) => !action.id || !ids.has(action.id)));
      setDraftEdits((current) => clearDraftEdits(current, actions));
      setChatHistory((current) => [...current, {
        role: "assistant",
        content: `Approved ${actions.length} action(s).\n\nActions:\n${results.map(actionLabel).join("\n")}`,
      }]);
      if (data.error) setChatError(safeText(data.error));
      setRetryRequest(null);
    } catch (err) {
      if (isAbortError(err)) return;
      const messageText = err instanceof Error ? err.message : String(err);
      setChatError(messageText);
      setChatHistory(trimChatHistory([...chatHistory, {
        role: "assistant",
        content: `Approval failed: ${messageText}`,
      }]));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setTask(null);
        setApprovalBusy(false);
      }
    }
  }, [sessionId, chatHistory, draftEdits, beginTask]);

  const declineActions = useCallback((actions: PendingAction[]) => {
    const ids = new Set(actions.map((action) => action.id).filter((id): id is string => Boolean(id)));
    setPendingActions((current) => current.filter((action) => !action.id || !ids.has(action.id)));
    setDraftEdits((current) => clearDraftEdits(current, actions));
    setChatHistory((current) => [...current, {
      role: "assistant",
      content: `Declined ${actions.length} action(s). Nothing was sent to SpaceMolt.`,
    }]);
  }, []);

  const runAction = useCallback(async (tool: string, action: string, args: Record<string, unknown>) => {
    if (!sessionId) return;
    setChatBusy(true);
    setChatError("");
    setRetryRequest({ kind: "action", tool, action, args });
    const controller = beginTask(`${tool}/${action}`);
    const label = `${tool}/${action}`;

    try {
      const data = await readJson(`${BACKEND_URL}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, tool, action, args }),
        signal: controller.signal,
      });
      const result = data.action as GameActionRecord | undefined;
      setChatHistory((current) => trimChatHistory([...current, {
        role: "assistant",
        content: `${label}: ${result && typeof result.result === "string" && result.result ? result.result : safeText(result?.error ?? "done")}`,
      }]));
      if (data.error) setChatError(safeText(data.error));
      setRetryRequest(null);
    } catch (err) {
      if (isAbortError(err)) return;
      const messageText = err instanceof Error ? err.message : String(err);
      setChatError(messageText);
      setChatHistory((current) => trimChatHistory([...current, {
        role: "assistant",
        content: `Retry of ${label} failed: ${messageText}`,
      }]));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setTask(null);
        setChatBusy(false);
      }
    }
  }, [sessionId, beginTask]);

  const planRoute = useCallback(async (rawDestination?: string) => {
    const destination = (rawDestination ?? routeInput).trim();
    if (!destination) {
      setChatError("Enter a destination system, POI, or base id.");
      return;
    }
    if (!sessionId) {
      setChatError("Connect a pilot first.");
      return;
    }
    setRouteBusy(true);
    setChatError("");
    try {
      const data = await readJson(`${BACKEND_URL}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, tool: "spacemolt", action: "find_route", args: { id: destination } }),
      });
      const record = data.action as GameActionRecord | undefined;
      const plan = parseRoutePlan(record?.structured, destination);
      if (!plan) {
        throw new Error(record?.result || record?.error || safeText(data.error) || "No route found.");
      }
      setRoutePlan(plan);
      setChatHistory((current) => trimChatHistory([...current, {
        role: "assistant",
        content: `Route to ${plan.destination}: ${plan.totalJumps} jump(s). ${plan.steps.map(routeStepLabel).join(" → ")}. Press Follow route to travel.`,
      }]));
    } catch (err) {
      if (isAbortError(err)) return;
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setRouteBusy(false);
    }
  }, [sessionId, routeInput]);

  const startRoute = useCallback(async (plan: RoutePlan) => {
    if (!sessionId || plan.steps.length === 0) return;
    const controller = beginTask(`Route to ${plan.destination}`);
    setChatBusy(true);
    setChatError("");
    setRetryRequest({ kind: "route", plan });
    setRouteRun({ plan, index: 0, status: "running" });
    setTracking(true);

    let currentIndex = 0;
    const append = (content: string) => {
      setChatHistory((current) => trimChatHistory([...current, { role: "assistant", content }]));
    };

    const locationRequest = (signal: AbortSignal) => readJson(`${BACKEND_URL}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal,
    });

    const readTransitLocation = async (signal: AbortSignal): Promise<TransitLocation | null> => {
      const data = await locationRequest(signal);
      const raw = data.location;
      const parsed = raw && typeof raw === "object" ? raw as TransitLocation : null;
      if (parsed) setLocation(parsed);
      return parsed;
    };

    const waitForArrival = async (signal: AbortSignal): Promise<boolean> => {
      for (let attempt = 0; attempt < 120; attempt++) {
        await delay(2500, signal);
        const parsed = await readTransitLocation(signal);
        if (parsed?.in_transit !== true) return true;
      }
      return false;
    };

    const waitForStep = async (step: RouteStep, signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> => {
      const startedAt = Date.now();
      let sawTransit = false;
      while (Date.now() - startedAt < 600_000) {
        await delay(2000, signal);
        const parsed = await readTransitLocation(signal);
        if (locationMatchesStep(parsed, step)) return { ok: true };
        if (parsed?.in_transit === true) {
          sawTransit = true;
          continue;
        }
        if (sawTransit) {
          return { ok: false, error: `Arrived at ${locationPlaceLabel(parsed)}, not ${routeStepLabel(step)}.` };
        }
        if (Date.now() - startedAt >= 20_000) {
          return { ok: false, error: `No transit started toward ${routeStepLabel(step)}; current location is ${locationPlaceLabel(parsed)}.` };
        }
      }
      return { ok: false, error: `Timed out waiting for arrival at ${routeStepLabel(step)}.` };
    };

    try {
      while (currentIndex < plan.steps.length) {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const step = plan.steps[currentIndex];
        setRouteRun({ plan, index: currentIndex, status: "running" });

        let before = await readTransitLocation(controller.signal);
        if (before?.in_transit === true) {
          append(`Waiting for the current jump to finish before continuing the route.`);
          if (!(await waitForArrival(controller.signal))) {
            throw new Error(`Timed out waiting for the current jump to finish.`);
          }
          before = await readTransitLocation(controller.signal);
        }
        if (locationMatchesStep(before, step)) {
          currentIndex += 1;
          setRouteRun({ plan, index: currentIndex, status: "running" });
          continue;
        }

        const isTravel = step.kind === "travel";
        const actionName = isTravel ? "travel" : "jump";
        append(`Route step ${currentIndex + 1}/${plan.steps.length}: ${isTravel ? "travelling to" : "jumping to"} ${routeStepLabel(step)} (${step.systemId}).`);

        let submitted = true;
        let requestError: string | undefined;
        try {
          const stepData = await readJson(`${BACKEND_URL}/api/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, tool: "spacemolt", action: actionName, args: { id: step.systemId } }),
            signal: controller.signal,
          });
          const record = stepData.action as GameActionRecord | undefined;
          if (record?.ok === false && stepData.pending !== true) {
            submitted = false;
            requestError = record.error || safeText(stepData.error) || `${isTravel ? "Travel to" : "Jump to"} ${step.systemId} failed.`;
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          requestError = err instanceof Error ? err.message : String(err);
          const status = err instanceof HttpError ? err.status : undefined;
          if (isDefiniteRequestFailure(status)) {
            submitted = false;
          } else {
            append(`Movement request did not return in time; checking SpaceMolt for the result.`);
          }
        }
        if (!submitted) {
          throw new Error(requestError ?? `${isTravel ? "Travel to" : "Jump to"} ${step.systemId} failed.`);
        }

        const outcome = await waitForStep(step, controller.signal);
        if (!outcome.ok) {
          throw new Error(`${outcome.error}${requestError ? ` (request: ${requestError})` : ""}`);
        }
        currentIndex += 1;
        setRouteRun({ plan, index: currentIndex, status: "running" });
      }

      if (abortRef.current === controller) {
        setRouteRun({ plan, index: currentIndex, status: "done" });
        append(`Route complete: reached ${plan.destination}.`);
        setRetryRequest(null);
        setTask(null);
        setTracking(false);
        setChatBusy(false);
        abortRef.current = null;
      }
    } catch (err) {
      if (isAbortError(err)) return;
      const messageText = err instanceof Error ? err.message : String(err);
      setChatError(messageText);
      if (abortRef.current === controller) {
        setRouteRun({ plan, index: currentIndex, status: "error", error: messageText });
        append(`Route stopped at step ${currentIndex + 1}: ${messageText}`);
        setRetryRequest({ kind: "route", plan });
        setTask(null);
        setTracking(false);
        setChatBusy(false);
        abortRef.current = null;
      }
    }
  }, [sessionId, beginTask]);

  const retry = useCallback(() => {
    const request = retryRequest;
    if (!request || !sessionId) return;
    setRetryRequest(null);
    if (request.kind === "chat") void submitChat(request.message);
    else if (request.kind === "execute") void approveActions(request.actions);
    else if (request.kind === "route") void startRoute(request.plan);
    else void runAction(request.tool, request.action, request.args);
  }, [retryRequest, sessionId, submitChat, approveActions, startRoute, runAction]);

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
                <a
                  className="link-url"
                  href={link.verificationUriComplete}
                  target="_blank"
                  rel="noreferrer"
                  title={link.verificationUriComplete}
                >
                  Open SpaceMolt approval link
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
                    setModelChoices(modelChoicesByProvider[key || defaultProvider] ?? []);
                    saveLlmProvider(key);
                    saveLlmModel("");
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
                  onChange={(event) => {
                    setSelectedModel(event.target.value);
                    saveLlmModel(event.target.value);
                  }}
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

              {(task || tracking) && (
                <div className="progress">
                  <div className="progress-text">
                    <strong>{transitLabel(location) || (task ? `${task.label}…` : "In transit…")}</strong>
                    <span className="meta">
                      {task ? `Working for ${elapsed}s` : "Waiting for arrival"}
                      {location?.system_name ?? location?.system_id ?? location?.system
                        ? ` · ${safeText(location?.system_name ?? location?.system_id ?? location?.system)}`
                        : ""}
                    </span>
                  </div>
                  {task && (
                    <button type="button" className="secondary" onClick={interrupt}>
                      Interrupt
                    </button>
                  )}
                </div>
              )}

              <div className="route-panel">
                <label className="ask-label" htmlFor="route-destination">Multi-jump route</label>
                <div className="route-form">
                  <input
                    id="route-destination"
                    value={routeInput}
                    onChange={(event) => setRouteInput(event.target.value)}
                    placeholder="Destination system, POI, or base id — e.g. tau_ceti"
                    disabled={chatBusy || routeBusy}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={chatBusy || routeBusy || !routeInput.trim()}
                    onClick={() => void planRoute()}
                  >
                    {routeBusy ? "Finding…" : "Find route"}
                  </button>
                  <button
                    type="button"
                    disabled={chatBusy || routeBusy || !routePlan || routePlan.steps.length === 0}
                    onClick={() => { if (routePlan) void startRoute(routePlan); }}
                  >
                    Follow route
                  </button>
                </div>
                {routePlan && (
                  <p className="meta">
                    {routePlan.totalJumps} jump(s) to {safeText(routePlan.destination)}
                    {routePlan.steps.length > 0 ? ` · ${routePlan.steps.map(routeStepLabel).join(" → ")}` : ""}
                    {routePlan.estimatedFuel !== undefined ? ` · est. fuel ${routePlan.estimatedFuel}` : ""}
                    {routePlan.fuelAvailable !== undefined ? ` · fuel available ${routePlan.fuelAvailable}` : ""}
                  </p>
                )}
                {routeRun && (
                  <p className="meta">
                    Route status: {routeRun.status} · step {routeRun.index}/{routeRun.plan.steps.length}
                    {routeRun.error ? ` · ${routeRun.error}` : ""}
                  </p>
                )}
              </div>

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
              {retryRequest && !task && (
                <div className="retry-row">
                  <button type="button" className="secondary" onClick={retry}>
                    Retry last request
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRetryRequest(null)}
                  >
                    Dismiss
                  </button>
                </div>
              )}
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
  main { max-width: 46rem; margin: 3rem auto; padding: 0 1rem; min-width: 0; overflow-wrap: anywhere; }
  header, .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-width: 0; }
  h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.015em; }
  h2 { font-size: 1.1rem; font-weight: 600; letter-spacing: 0.015em; }
  section { margin-top: 1.5rem; padding: 1rem; border: 1px solid #2a2f38; border-radius: 3px; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  button, input, select, textarea { font: inherit; padding: 0.5rem 0.75rem; border-radius: 2px; border: 1px solid #3a4150; background: #1d222b; color: inherit; }
  button { cursor: pointer; background: #2563eb; border-color: #2563eb; }
  button.secondary { background: #1d222b; border-color: #3a4150; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  section > button { margin-left: 0.5rem; }
  .form { display: grid; gap: 0.75rem; }
  .form label { display: grid; gap: 0.35rem; color: #9aa3b2; }
  a { color: #93c5fd; overflow-wrap: anywhere; word-break: break-word; }
  .link-url { display: inline-block; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
  .code { font-size: 1.4rem; font-weight: 700; letter-spacing: 0.1em; }
  .error { color: #fca5a5; }
  .notice { color: #fcd34d; }
  .meta { color: #9aa3b2; }
  .model-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .model-row label { color: #9aa3b2; font-size: 0.85rem; letter-spacing: 0.02em; }
  .model-row select { flex: 1 1 16rem; min-width: 0; max-width: 100%; }
  .quick { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
  .quick button { margin: 0; }
  .chat { display: grid; gap: 0.75rem; margin-bottom: 0.75rem; min-width: 0; }
  .chat-line { display: grid; gap: 0.2rem; padding: 0.5rem 0.75rem; border-radius: 2px; background: #171b22; min-width: 0; }
  .chat-line strong { color: #9aa3b2; font-size: 0.8rem; }
  .chat-line span { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; min-width: 0; max-width: 100%; }
  .chat-line.assistant { border-left: 3px solid #2563eb; }
  .objective { display: grid; gap: 0.4rem; margin-bottom: 0.75rem; min-width: 0; }
  .objective label, .draft-label { color: #cbd5e1; font-size: 0.9rem; letter-spacing: 0.02em; }
  .objective textarea { width: 100%; min-width: 0; resize: vertical; }
  .objective .meta { margin: 0; font-size: 0.8rem; }
  .chat-form { display: grid; gap: 0.5rem; min-width: 0; }
  .ask-label { color: #cbd5e1; font-size: 0.9rem; letter-spacing: 0.02em; }
  .route-panel { display: grid; gap: 0.5rem; margin-bottom: 0.75rem; min-width: 0; }
  .route-form { display: flex; flex-wrap: wrap; gap: 0.5rem; min-width: 0; }
  .route-form input { flex: 1 1 18rem; min-width: 0; }
  .route-form button { margin: 0; }
  .route-panel .meta { margin: 0; font-size: 0.85rem; overflow-wrap: anywhere; word-break: break-word; }
  .chat-form textarea { width: 100%; min-width: 0; resize: vertical; }
  .chat-actions { display: flex; justify-content: flex-end; }
  .chat-actions button { margin: 0; }
  .pending { display: grid; gap: 0.75rem; margin-bottom: 0.75rem; min-width: 0; }
  .pending-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .pending-head button { margin: 0; }
  .pending-card { display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid #3a4150; border-radius: 2px; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .pending-title { color: #fcd34d; overflow-wrap: anywhere; }
  .pending-args { margin: 0; padding: 0.5rem; border-radius: 2px; background: #171b22; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; min-width: 0; max-width: 100%; }
  .draft-label { display: grid; gap: 0.35rem; }
  .draft-label textarea { width: 100%; min-width: 0; resize: vertical; }
  .pending-buttons { display: flex; gap: 0.5rem; }
  .pending-buttons button { margin: 0; }
  .progress { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.75rem; margin-bottom: 0.75rem; border: 1px solid #2563eb; border-radius: 2px; background: #171b22; min-width: 0; }
  .progress-text { display: grid; gap: 0.25rem; min-width: 0; }
  .progress-text strong { color: #93c5fd; overflow-wrap: anywhere; }
  .progress-text .meta { font-size: 0.85rem; overflow-wrap: anywhere; word-break: break-word; }
  .progress button { margin: 0; flex-shrink: 0; }
  .retry-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .retry-row button { margin: 0; }
  dl { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: 0.4rem 1rem; margin: 0; }
  dt { color: #9aa3b2; }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
`;
