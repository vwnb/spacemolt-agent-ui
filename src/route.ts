export type RouteStep = { systemId: string; name?: string; jumps: number; kind?: "jump" | "travel" };

export type TransitLocation = {
  system?: unknown;
  system_id?: unknown;
  system_name?: unknown;
  poi?: unknown;
  poi_id?: unknown;
  poi_name?: unknown;
  in_transit?: unknown;
  transit_type?: unknown;
  transit_dest_system_id?: unknown;
  transit_dest_system_name?: unknown;
  transit_dest_poi_id?: unknown;
  transit_dest_poi_name?: unknown;
  transit_arrival_tick?: unknown;
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function normalizePlace(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, "")
    : "";
}

export function locationMatchesStep(location: TransitLocation | null, step: RouteStep): boolean {
  if (!location) return false;
  const targets = [normalizePlace(step.systemId), normalizePlace(step.name)].filter(Boolean);
  if (targets.length === 0) return false;
  const currentValues = step.kind === "travel"
    ? [location.poi_id, location.poi_name, location.poi]
    : [location.system_id, location.system_name, location.system];
  return currentValues.some((value) => targets.includes(normalizePlace(value)));
}

export function locationPlaceLabel(location: TransitLocation | null): string {
  if (!location) return "unknown location";
  const parts = [
    location.poi_name ?? location.poi_id ?? location.poi,
    location.system_name ?? location.system_id ?? location.system,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? parts.map(String).join(" / ") : "unknown location";
}

export function isDefiniteRequestFailure(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}
