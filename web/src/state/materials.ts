/** The bundled material databases, parsed once.
 *
 * Rotor materials and pad compounds both ship as JSON and are read from three
 * or four pages each. Parsing them here rather than per page keeps one shape
 * of `RotorMaterial` in play — a page that mapped `specific_heat_J_kgK` and
 * forgot `thermal_expansion_1_K` would silently lose thermal growth without
 * any solver complaining.
 */
import rotorMaterialsRaw from "@data/materials/rotor_materials.json";
import padCompoundsRaw from "@data/materials/pad_compounds.json";

import type { RotorMaterial } from "@core/models/rotors.ts";
import type { PadFrictionModel } from "@core/models/padFriction.ts";
import { maxCharacterizedTemperatureC } from "@core/models/padFriction.ts";
import { parsePadFrictionModels } from "@core/config.ts";
import type { BrakeHardware } from "@core/models/internal.ts";

// --- rotor materials ----------------------------------------------------------

interface RawRotorMaterial {
  name: string;
  density_kg_m3: number;
  specific_heat_J_kgK: number;
  thermal_conductivity_W_mK?: number;
  youngs_modulus_Pa?: number;
  poissons_ratio?: number;
  thermal_expansion_1_K?: number;
  yield_strength_Pa?: number;
  emissivity?: number;
}

const RAW_ROTOR_MATERIALS = (rotorMaterialsRaw as { materials: RawRotorMaterial[] }).materials;

function toRotorMaterial(raw: RawRotorMaterial): RotorMaterial {
  return {
    name: raw.name,
    density_kg_m3: raw.density_kg_m3,
    specific_heat_j_kgk: raw.specific_heat_J_kgK,
    thermal_conductivity_w_mk: raw.thermal_conductivity_W_mK ?? null,
    youngs_modulus_pa: raw.youngs_modulus_Pa ?? null,
    poissons_ratio: raw.poissons_ratio ?? null,
    thermal_expansion_1_k: raw.thermal_expansion_1_K ?? null,
    yield_strength_pa: raw.yield_strength_Pa ?? null,
    emissivity: raw.emissivity ?? null,
  };
}

export const ROTOR_MATERIAL_NAMES: string[] = RAW_ROTOR_MATERIALS.map((m) => m.name);

/** name -> material, the shape `runParameterizedSweep` wants for rotor heating. */
export const ROTOR_MATERIALS: Record<string, RotorMaterial> = Object.fromEntries(
  RAW_ROTOR_MATERIALS.map((raw) => [raw.name, toRotorMaterial(raw)]),
);

/** Falls back to the first material rather than throwing: a hardware config
 *  naming a material nobody added should degrade, not brick the page. */
export function rotorMaterialByName(name: string | null | undefined): RotorMaterial {
  return ROTOR_MATERIALS[name ?? ""] ?? toRotorMaterial(RAW_ROTOR_MATERIALS[0]!);
}

// --- pad compounds ------------------------------------------------------------

/** Only compounds carrying a digitized mu(T) table — a prose note is not a
 *  callable curve, and `parsePadFrictionModels` drops those. */
export const PAD_MODELS: Record<string, PadFrictionModel> = parsePadFrictionModels(padCompoundsRaw);
export const PAD_NAMES: string[] = Object.keys(PAD_MODELS);

/** The "no curve, just a number" option, matching the Python sidebar. */
export const MANUAL_PAD = "Constant μ (manual)";

export function padModelFor(label: string): PadFrictionModel | null {
  return PAD_MODELS[label] ?? null;
}

/** Opening selection: the first characterized compound, at its design μ. */
export function defaultPadSelection(fallbackMu = 0.48): { label: string; mu: number } {
  const first = PAD_NAMES[0];
  if (first === undefined) return { label: MANUAL_PAD, mu: fallbackMu };
  return { label: first, mu: PAD_MODELS[first]!.design_mu ?? fallbackMu };
}

/** Pad selection applied to hardware, ready for a solver.
 *
 * Both halves matter. The coefficient drives the static checks (bias, line
 * pressure) and the model drives mu(T) — attaching only the number is how the
 * temperature-coupled columns come back empty while everything still "works".
 */
export function brakesWithPad(
  brakes: BrakeHardware,
  padLabel: string,
  padMu: number,
): BrakeHardware {
  return {
    ...brakes,
    pad_friction_coefficient: padMu,
    pad_friction_model: padModelFor(padLabel),
  };
}

/** Top of the compound's characterized band — beyond it, mu(T) is extrapolation. */
export function padLimitC(label: string): number | null {
  const model = padModelFor(label);
  return model === null ? null : maxCharacterizedTemperatureC(model);
}
