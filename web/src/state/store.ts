/** Scenarios and operating conditions — the app's whole shared state.
 *
 * A scenario is a complete, named, immutable snapshot: vehicle, brake hardware,
 * and the conditions the analyses are evaluated at. Holding several at once is
 * what makes "put a 4 mm rotor next to a 6 mm rotor" possible; before scenarios
 * existed, changing an input simply destroyed the previous result.
 *
 * Two rules carried over from the restructure of the Python app, both of which
 * were fixing real bugs rather than tidying:
 *
 * 1. Conditions describe the STOP, not the car. Driver mass, target
 *    deceleration and ambient temperature live here, once, because when they
 *    were declared per-page the same quantity held different values at the same
 *    time (hydraulics sized for a 68 kg driver while straight-line braking
 *    assumed 75 kg, with nothing on screen reconciling them).
 * 2. Sweep bounds do NOT live here. They describe what one analysis explores,
 *    not what the car is doing, and hoisting them would be the same mistake in
 *    the other direction.
 */
import type { BrakeHardware, Vehicle } from "@core/models/internal.ts";

export interface Conditions {
  driver_mass_kg: number;
  target_deceleration_g: number;
  ambient_temperature_c: number;
  allowable_rotor_temperature_c: number;
  event_gap_s: number;
  pedal_force_n: number;
  pad_label: string;
  pad_mu: number;
  include_aero: boolean;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly vehicle: Vehicle;
  readonly brakes: BrakeHardware;
  readonly conditions: Conditions;
}

/** Legend/column label — the name alone ("Baseline / copy / copy 2") tells you
 *  nothing about which curve is which, so the geometry rides along. */
export function scenarioLabel(s: Scenario): string {
  const od = s.brakes.front?.rotor_outer_diameter_mm;
  const t = s.brakes.front?.rotor_thickness_mm;
  return od != null && t != null ? `${s.name} (${od.toFixed(0)}×${t.toFixed(1)} mm)` : s.name;
}

export interface AppState {
  scenarios: Scenario[];
  activeId: string;
  compareIds: string[];
}

export type Action =
  | { type: "activate"; id: string }
  | { type: "duplicate"; name?: string }
  | { type: "delete"; id: string }
  | { type: "rename"; id: string; name: string }
  | { type: "setCompare"; ids: string[] }
  | { type: "patchConditions"; patch: Partial<Conditions> }
  | { type: "patchVehicle"; patch: Partial<Vehicle> }
  | { type: "patchBrakes"; patch: Partial<BrakeHardware> };

let counter = 0;
const nextId = (): string => `s${++counter}`;

export function makeScenario(
  name: string,
  vehicle: Vehicle,
  brakes: BrakeHardware,
  conditions: Conditions,
): Scenario {
  return { id: nextId(), name, vehicle, brakes, conditions };
}

/** Scenarios selected for comparison, always including the active one. */
export function comparedScenarios(state: AppState): Scenario[] {
  const byId = new Map(state.scenarios.map((s) => [s.id, s]));
  const ids = [state.activeId, ...state.compareIds.filter((id) => id !== state.activeId)];
  return ids.map((id) => byId.get(id)).filter((s): s is Scenario => s != null);
}

export const isComparing = (state: AppState): boolean => comparedScenarios(state).length > 1;

export const activeScenario = (state: AppState): Scenario =>
  state.scenarios.find((s) => s.id === state.activeId) ?? state.scenarios[0]!;

function uniqueName(existing: Scenario[], wanted: string): string {
  if (!existing.some((s) => s.name === wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`;
    if (!existing.some((s) => s.name === candidate)) return candidate;
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "activate":
      return { ...state, activeId: action.id };

    case "duplicate": {
      const source = activeScenario(state);
      const copy = makeScenario(
        uniqueName(state.scenarios, action.name?.trim() || `${source.name} copy`),
        source.vehicle,
        source.brakes,
        source.conditions,
      );
      return { ...state, scenarios: [...state.scenarios, copy], activeId: copy.id };
    }

    case "delete": {
      // Never leave the app with nothing selected.
      if (state.scenarios.length <= 1) return state;
      const remaining = state.scenarios.filter((s) => s.id !== action.id);
      return {
        ...state,
        scenarios: remaining,
        activeId: state.activeId === action.id ? remaining[0]!.id : state.activeId,
        compareIds: state.compareIds.filter((id) => id !== action.id),
      };
    }

    case "rename":
      return {
        ...state,
        scenarios: state.scenarios.map((s) =>
          s.id === action.id
            ? { ...s, name: uniqueName(state.scenarios.filter((o) => o.id !== s.id), action.name) }
            : s,
        ),
      };

    case "setCompare":
      return { ...state, compareIds: action.ids.filter((id) => id !== state.activeId) };

    // Edits apply to the ACTIVE scenario only, which is what makes duplicating
    // and then changing one thing a meaningful comparison.
    case "patchConditions":
      return patchActive(state, (s) => ({ ...s, conditions: { ...s.conditions, ...action.patch } }));
    case "patchVehicle":
      return patchActive(state, (s) => ({ ...s, vehicle: { ...s.vehicle, ...action.patch } }));
    case "patchBrakes":
      return patchActive(state, (s) => ({ ...s, brakes: { ...s.brakes, ...action.patch } }));
  }
}

function patchActive(state: AppState, fn: (s: Scenario) => Scenario): AppState {
  return {
    ...state,
    scenarios: state.scenarios.map((s) => (s.id === state.activeId ? fn(s) : s)),
  };
}
