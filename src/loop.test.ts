import { describe, expect, it } from "vitest";
import {
  LOOP_PRESETS,
  loopActionLabel,
  loopStopReason,
  parseLoopArgs,
} from "./loop.js";

describe("loop helpers", () => {
  it("provides a mine preset with tick-spaced repeats", () => {
    const mine = LOOP_PRESETS.find((preset) => preset.id === "mine");
    expect(mine).toMatchObject({ tool: "spacemolt", action: "mine", delaySeconds: 11, stopOnNoProgress: true });
  });

  it("parses empty and object loop arguments", () => {
    expect(parseLoopArgs("")).toEqual({ ok: true, args: {} });
    expect(parseLoopArgs('{"id":"sol_central"}')).toEqual({ ok: true, args: { id: "sol_central" } });
  });

  it("rejects non-object loop arguments", () => {
    expect(parseLoopArgs("[]").ok).toBe(false);
    expect(parseLoopArgs("null").ok).toBe(false);
    expect(parseLoopArgs("{" ).ok).toBe(false);
  });

  it("labels tool/action pairs", () => {
    expect(loopActionLabel("spacemolt", "mine")).toBe("spacemolt/mine");
    expect(loopActionLabel("", "mine")).toBe("mine");
  });

  it("detects mining stop conditions", () => {
    expect(loopStopReason("Nothing to mine here.")).toBe("deposit is empty or depleted");
    expect(loopStopReason({ result: "Ore deposit depleted." })).toBe("deposit is empty or depleted");
    expect(loopStopReason("Cargo hold is full.")).toBe("cargo hold is full");
    expect(loopStopReason("Mined 4 iron ore.")).toBe(null);
  });
});
