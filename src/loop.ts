export type LoopPreset = {
  id: string;
  label: string;
  tool: string;
  action: string;
  args: string;
  repetitions: number;
  delaySeconds: number;
  stopOnNoProgress: boolean;
  help: string;
};

export type LoopPlan = {
  name: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
  repetitions: number;
  delaySeconds: number;
  stopOnNoProgress: boolean;
};

export const LOOP_PRESETS: LoopPreset[] = [
  {
    id: "mine",
    label: "Mine here",
    tool: "spacemolt",
    action: "mine",
    args: "{}",
    repetitions: 10,
    delaySeconds: 11,
    stopOnNoProgress: true,
    help: "Mines the current POI once per SpaceMolt tick and stops early if the deposit is empty or cargo is full.",
  },
  {
    id: "survey",
    label: "Survey system",
    tool: "spacemolt",
    action: "survey_system",
    args: "{}",
    repetitions: 1,
    delaySeconds: 11,
    stopOnNoProgress: false,
    help: "Reads ore at charted POIs and scans for hidden POIs; use repeats for periodic scans.",
  },
  {
    id: "refuel",
    label: "Refuel self",
    tool: "spacemolt",
    action: "refuel",
    args: "{}",
    repetitions: 1,
    delaySeconds: 11,
    stopOnNoProgress: false,
    help: "Uses the docked station service or cargo fuel cells; player transfers need approval instead.",
  },
  {
    id: "repair",
    label: "Repair self",
    tool: "spacemolt",
    action: "repair",
    args: "{}",
    repetitions: 1,
    delaySeconds: 11,
    stopOnNoProgress: false,
    help: "Uses the docked repair service or cargo repair kits; player transfers need approval instead.",
  },
  {
    id: "custom",
    label: "Custom safe action",
    tool: "spacemolt",
    action: "",
    args: "{}",
    repetitions: 5,
    delaySeconds: 11,
    stopOnNoProgress: false,
    help: "Runs any registered safe action. Approval-gated actions are refused by the backend.",
  },
];

export function parseLoopArgs(text: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, args: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Loop arguments must be a JSON object." };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Loop arguments must be valid JSON, for example {}." };
  }
}

export function loopActionLabel(tool: string, action: string): string {
  const cleanTool = tool.trim();
  const cleanAction = action.trim();
  if (!cleanTool) return cleanAction || "action";
  if (!cleanAction) return cleanTool;
  return `${cleanTool}/${cleanAction}`;
}

export function loopStopReason(value: unknown): string | null {
  const text = typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : JSON.stringify(value);
  const lower = text.toLowerCase();
  if (/cargo(?: hold)?(?: is)? full|hold(?: is)? full|full cargo/.test(lower)) return "cargo hold is full";
  if (/nothing to mine|no (?:ore|resource|deposit|mineral)|depleted|exhausted|empty deposit|deposit is empty/.test(lower)) {
    return "deposit is empty or depleted";
  }
  return null;
}
