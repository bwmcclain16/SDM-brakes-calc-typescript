import { NeedsInputError } from "../errors.ts";
import type { BrakeFluid } from "../models/fluid.ts";

/** Boiling-point margins for one fluid at an operating temperature (spec 23.2).
 *
 * Margin = boiling_point - operating_temperature. The WET margin governs design
 * (fluid absorbs water in service); `wet_margin_c` is `null` only when the
 * fluid has no published wet boiling point. `acceptable` is judged against the
 * wet margin when available, else the dry margin, vs `required_margin_c`.
 */
export interface BoilingMargin {
  fluid_name: string;
  operating_temperature_c: number;
  dry_boiling_point_c: number;
  wet_boiling_point_c: number | null;
  dry_margin_c: number;
  wet_margin_c: number | null;
  required_margin_c: number;
  acceptable: boolean;
}

export function boilingMargin(
  fluid: BrakeFluid,
  operatingTemperatureC: number,
  requiredMarginC = 0.0,
): BoilingMargin {
  const dryMargin = fluid.dry_boiling_point_c - operatingTemperatureC;
  let wetMargin: number | null;
  let governing: number;
  if (fluid.wet_boiling_point_c == null) {
    wetMargin = null;
    governing = dryMargin;
  } else {
    wetMargin = fluid.wet_boiling_point_c - operatingTemperatureC;
    governing = wetMargin;
  }
  return {
    fluid_name: fluid.name,
    operating_temperature_c: operatingTemperatureC,
    dry_boiling_point_c: fluid.dry_boiling_point_c,
    wet_boiling_point_c: fluid.wet_boiling_point_c ?? null,
    dry_margin_c: dryMargin,
    wet_margin_c: wetMargin,
    required_margin_c: requiredMarginC,
    acceptable: governing >= requiredMarginC,
  };
}

/** All fluids' margins sorted best-worst by the governing (wet) margin.
 *
 * Wet margin is the worst-case design number. A fluid with no published wet
 * boiling point is an UNKNOWN worst case, so it is ranked conservatively LAST
 * (never promoted above a fluid with a known, larger wet margin on the strength
 * of its dry number). Such fluids are still returned (not dropped); the caller
 * sees `wet_margin_c is None`.
 */
export function rankFluidsByWetMargin(
  fluids: Record<string, BrakeFluid> | BrakeFluid[],
  operatingTemperatureC: number,
  requiredMarginC = 0.0,
): BoilingMargin[] {
  const items = Array.isArray(fluids) ? fluids : Object.values(fluids);
  const margins = items.map((f) => boilingMargin(f, operatingTemperatureC, requiredMarginC));
  const sortKey = (m: BoilingMargin): number => (m.wet_margin_c !== null ? m.wet_margin_c : -Infinity);
  return [...margins].sort((a, b) => sortKey(b) - sortKey(a));
}

/** Volumetric compliance of the fluid column, dV/dP = V / K (spec 16.4).
 *
 * Raises `NeedsInputError` when the fluid has no bulk modulus rather than
 * guessing a stiffness that would silently set pedal travel.
 */
export function fluidComplianceM3PerPa(fluid: BrakeFluid, systemVolumeMl: number): number {
  if (fluid.bulk_modulus_pa == null) {
    throw new NeedsInputError(`brake_fluid '${fluid.name}'.bulk_modulus_pa`);
  }
  const volumeM3 = systemVolumeMl * 1.0e-6;
  return volumeM3 / fluid.bulk_modulus_pa;
}
