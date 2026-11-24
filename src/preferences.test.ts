import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadLlmSelection,
  resolveLlmSelection,
  saveLlmModel,
  saveLlmProvider,
} from "./preferences.js";

const store = new Map<string, string>();

function stubStorage(): void {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
}

describe("LLM preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads saved provider and model values", () => {
    stubStorage();
    expect(loadLlmSelection()).toEqual({ provider: null, model: null });
    saveLlmProvider("openrouter");
    saveLlmModel("openrouter/free");
    expect(loadLlmSelection()).toEqual({ provider: "openrouter", model: "openrouter/free" });
  });

  it("keeps a saved provider and model that are still offered", () => {
    const resolved = resolveLlmSelection(
      { provider: "openrouter", model: "openrouter/free" },
      ["opper", "openrouter"],
      { opper: ["claude"], openrouter: ["openrouter/free"] },
      "opper",
    );
    expect(resolved).toEqual({ provider: "openrouter", model: "openrouter/free", modelIds: ["openrouter/free"] });
  });

  it("falls back when a saved provider is no longer offered", () => {
    const resolved = resolveLlmSelection(
      { provider: "retired", model: "old-model" },
      ["opper", "openrouter"],
      { opper: ["claude"], openrouter: ["openrouter/free"] },
      "opper",
    );
    expect(resolved).toEqual({ provider: "opper", model: "", modelIds: ["claude"] });
  });

  it("keeps server default selections as explicit empty preferences", () => {
    const resolved = resolveLlmSelection(
      { provider: "", model: "" },
      ["opper", "openrouter"],
      { opper: ["claude"], openrouter: ["openrouter/free"] },
      "opper",
    );
    expect(resolved).toEqual({ provider: "", model: "", modelIds: ["claude"] });
  });
});
