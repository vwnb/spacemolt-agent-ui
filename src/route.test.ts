import { describe, expect, it } from "vitest";
import {
  HttpError,
  isDefiniteRequestFailure,
  locationMatchesStep,
  locationPlaceLabel,
  normalizePlace,
  type RouteStep,
} from "./route.js";

const jumpStep: RouteStep = { systemId: "tau_ceti", name: "Tau Ceti", jumps: 1 };
const travelStep: RouteStep = { systemId: "sol_central", name: "Sol Central", jumps: 2, kind: "travel" };

describe("route location helpers", () => {
  it("normalizes system ids and display names", () => {
    expect(normalizePlace(" Tau Ceti ")).toBe("tauceti");
    expect(normalizePlace("tau-ceti")).toBe("tauceti");
  });

  it("matches jump steps against any current system field", () => {
    expect(locationMatchesStep({ system_name: "Tau Ceti" }, jumpStep)).toBe(true);
    expect(locationMatchesStep({ system_id: "tau_ceti" }, jumpStep)).toBe(true);
    expect(locationMatchesStep({ system: "Tau Ceti" }, jumpStep)).toBe(true);
    expect(locationMatchesStep({ system_id: "sol" }, jumpStep)).toBe(false);
  });

  it("matches travel steps against POI fields only", () => {
    expect(locationMatchesStep({ system_id: "tau_ceti", poi_id: "sol_central" }, travelStep)).toBe(true);
    expect(locationMatchesStep({ system_id: "sol_central", poi_id: "other" }, travelStep)).toBe(false);
  });

  it("does not treat a transit destination as an arrival", () => {
    expect(locationMatchesStep({
      system_id: "sol",
      transit_dest_system_id: "tau_ceti",
      in_transit: true,
    }, jumpStep)).toBe(false);
  });

  it("labels the current place for retry messages", () => {
    expect(locationPlaceLabel({ poi_name: "Sol Central", system_name: "Sol" })).toBe("Sol Central / Sol");
  });

  it("treats only 4xx responses as definite request failures", () => {
    expect(isDefiniteRequestFailure(new HttpError(400, "bad id").status)).toBe(true);
    expect(isDefiniteRequestFailure(new HttpError(504, "gateway timeout").status)).toBe(false);
    expect(isDefiniteRequestFailure(undefined)).toBe(false);
  });
});
