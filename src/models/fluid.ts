/** A brake fluid characterized for boiling-margin and compliance checks.
 *
 * Boiling points are the DOT "equilibrium reflux" values: `dry` is fresh
 * fluid, `wet` is after the standardized 3.5% water uptake. Wet is the
 * design-relevant number for a season-old fill; it may be `null` when the
 * manufacturer does not publish it. `bulk_modulus_pa` is the secant bulk
 * modulus K used by the fluid compliance term (dV = V*dP/K).
 *
 * NOTE: this module has no golden fixture -- the Python test suite never
 * calls its (nonexistent) functions directly, so this port is unanchored.
 * `BrakeFluid` carries no methods in the Python source; it is a pure data
 * holder ported here field-for-field. */
export interface BrakeFluid {
  name: string;
  dry_boiling_point_c: number;
  wet_boiling_point_c?: number | null;
  bulk_modulus_pa?: number | null;
  density_kg_m3?: number | null;
  manufacturer?: string | null;
  dot_rating?: string | null;
  base_fluid?: boolean;
}
