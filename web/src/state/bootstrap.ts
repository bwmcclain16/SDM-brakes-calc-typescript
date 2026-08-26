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
import activeConfig from "@data/active_config.json";
import sdm26Rotor from "@data/rotors/SDM26_Rotor.json";
import fsae2026Rotors from "@data/rotors/fsae_2026_baseline_rotors.json";

import { applyRotorSetup, parseRotorSetup } from "@core/config.ts";

import type { AppState, Conditions } from "./store.ts";
import { makeScenario } from "./store.ts";
import { defaultPadSelection } from "./materials.ts";

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

/** Rotor configs available for autoload, keyed by their path in active_config. */
const ROTOR_CONFIGS: Record<string, unknown> = {
  "data/rotors/SDM26_Rotor.yaml": sdm26Rotor,
  "data/rotors/fsae_2026_baseline_rotors.yaml": fsae2026Rotors,
};

/** Brake hardware with the ACTIVE rotor config overlaid, as the Python app does.
 *
 * `data/active_config.yaml` selects which rotor the team is actually running,
 * and `app/state.py::_brakes_with_active_rotors` overlays it on the vehicle
 * file. Skipping that is not cosmetic: the current selection (SDM26_Rotor)
 * moves the front pad swept band from 182.0/148.0 to 183.0/131.8, which shifts
 * the front torque split from 72.92% to 73.26% and every energy figure derived
 * from it. Loading the raw vehicle file alone silently analyses a rotor nobody
 * is running.
 *
 * A rotor file that fails to parse must not brick the app — the vehicle file's
 * own rotor data still applies, matching the Python fallback.
 */
function brakesWithActiveRotors(): BrakeHardware {
  const base = baseline.brake_hardware;
  const selected = (activeConfig as { rotor_config?: string | null }).rotor_config;
  if (!selected) return base;
  const doc = ROTOR_CONFIGS[selected];
  if (doc === undefined) return base;
  try {
    return applyRotorSetup(base, parseRotorSetup(doc));
  } catch {
    return base;
  }
}

export function defaultConditions(): Conditions {
  // First characterized compound at its design mu, matching the Python sidebar.
  const pad = defaultPadSelection(Number(baseline.brake_hardware.pad_friction_coefficient ?? 0.48));
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
    brakesWithActiveRotors(),
    defaultConditions(),
  );
  return { scenarios: [scenario], activeId: scenario.id, compareIds: [] };
}
