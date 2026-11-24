const PROVIDER_STORAGE_KEY = "spacemolt-observer.llmProvider";
const MODEL_STORAGE_KEY = "spacemolt-observer.llmModel";

export type SavedLlmSelection = { provider: string | null; model: string | null };
export type ResolvedLlmSelection = { provider: string; model: string; modelIds: string[] };

function readValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function loadLlmSelection(): SavedLlmSelection {
  return { provider: readValue(PROVIDER_STORAGE_KEY), model: readValue(MODEL_STORAGE_KEY) };
}

export function saveLlmProvider(value: string): void {
  writeValue(PROVIDER_STORAGE_KEY, value);
}

export function saveLlmModel(value: string): void {
  writeValue(MODEL_STORAGE_KEY, value);
}

export function resolveLlmSelection(
  saved: SavedLlmSelection,
  providerKeys: string[],
  modelIdsByProvider: Record<string, string[]>,
  serverProvider: string,
): ResolvedLlmSelection {
  const provider = saved.provider !== null && (saved.provider === "" || providerKeys.includes(saved.provider))
    ? saved.provider
    : serverProvider;
  const modelIds = modelIdsByProvider[provider || serverProvider] ?? [];
  const model = saved.model !== null && (saved.model === "" || modelIds.includes(saved.model))
    ? saved.model
    : "";
  return { provider, model, modelIds };
}
