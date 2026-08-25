/** Initial state, seeded from the bundled config data.
 *
 * Conditions defaults come FROM the config files, not from literals here:
 * `single_stop_target_g` from the vehicle file, ambient and allowable rotor
 * temperature from the cooling baseline. Hardcoding them would recreate the bug
 * the shared conditions bar exists to prevent — one quantity with two sources of
 * truth, diverging the moment somebody edits the data.
 *
 * The JSON is imported rather than fetched so it is bundled and type-checked at
 * build time; a static site has no reason to make a network round trip for data
 * that ships with it.
 */
import type { BrakeHardware, Vehicle } from "@core/models/internal.ts";

import baselineVehicle from "@data/vehicles/fsae_2026_baseline.json";
import coolingBaseline from "@data/thermal/cooling_baseline.json";
import padCompounds from "@data/materials/pad_compounds.json";

import type { AppState, Conditions } from "./store.ts";
import { makeScenario } from "./store.ts";

interface BaselineFile {
  vehicle: Vehicle & Record<string, unknown>;
  brake_hardware: BrakeHardware & Record<string, unknown>;
}

interface CoolingFile {
  cooling: {
    ambient_temperature_C: number;
    allowable_rotor_temperature_C: number;
  };
}

const baseline = baselineVehicle as unknown as BaselineFile;
const cooling = (coolingBaseline as unknown as CoolingFile).cooling;

/** First pad compound in the database, matching how the Python sidebar seeds. */
function defaultPad(): { label: string; mu: number } {
  const compounds = padCompounds as unknown as Record<string, { design_mu?: number }>;
  const entries = Object.entries(compounds).filter(([, v]) => v && typeof v === "object");
  const [label, value] = entries[0] ?? ["Constant μ", {}];
  return { label, mu: value?.design_mu ?? 0.48 };
}

export function defaultConditions(): Conditions {
  const pad = defaultPad();
  return {
    driver_mass_kg: 75.0,
    target_deceleration_g: Number(baseline.vehicle.single_stop_target_g ?? 1.3),
    ambient_temperature_c: Number(cooling.ambient_temperature_C ?? 35),
    allowable_rotor_temperature_c: Number(cooling.allowable_rotor_temperature_C ?? 500),
    event_gap_s: 8.0,
    pedal_force_n: 418.0,
    pad_label: pad.label,
    pad_mu: pad.mu,
    include_aero: true,
  };
}

export function initialState(): AppState {
  const scenario = makeScenario(
    "Baseline",
    baseline.vehicle,
    baseline.brake_hardware,
    defaultConditions(),
  );
  return { scenarios: [scenario], activeId: scenario.id, compareIds: [] };
}
