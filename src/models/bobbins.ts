/** Brake button (bobbin) configuration and fastener material models (spec 22.2).
 *
 * Bobbins are the drive buttons connecting a floating friction ring to its hat.
 * Brake torque reacts through them as a tangential force at the bolt-circle
 * radius: `F_total = T / r_bobbin`, shared across `count` buttons. Because a
 * floating rotor engages its buttons unevenly (clearance-driven), the worst
 * button is designed to `F_design = Kt * F_total / (K_share * N)` where
 * `K_share <= 1` is the load-sharing factor and `Kt` the stress-concentration
 * factor -- both explicit assumptions per spec 22.2 ("apply load-sharing and
 * stress-concentration factors").
 *
 * Geometry is accepted in mm at the boundary (matching the data layer); solvers
 * convert internally and return SI.
 */
import { NeedsInputError } from "../errors.ts";

/** von Mises shear-yield ratio used when a fastener material does not supply an
 * explicit shear yield strength: `tau_yield = 0.577 * sigma_yield`. */
export const VON_MISES_SHEAR_FACTOR = 0.577;

export interface FastenerMaterial {
  name: string;
  yield_strength_pa: number | null;
  ultimate_strength_pa?: number | null;
  shear_yield_strength_pa?: number | null;
  density_kg_m3?: number | null;
}

/** Shear allowable: explicit shear yield if given, else 0.577 * yield. */
export function allowableShearPa(material: FastenerMaterial): number {
  if (material.shear_yield_strength_pa != null) {
    return material.shear_yield_strength_pa;
  }
  if (material.yield_strength_pa == null) {
    throw new NeedsInputError(`fastener_material[${material.name}].yield_strength_pa`);
  }
  return VON_MISES_SHEAR_FACTOR * material.yield_strength_pa;
}

/** One bobbin arrangement candidate.
 *
 * `rotor_tab_thickness_mm` is the bearing length of the rotor drive slot on
 * the button shank; `null`/`undefined` means "use the rotor thickness" (solid tab). */
export interface BobbinConfiguration {
  count: number;
  bolt_circle_diameter_mm: number;
  button_diameter_mm: number;
  material: FastenerMaterial;
  shear_plane_count?: number;
  load_sharing_factor?: number;
  stress_concentration_factor?: number;
  rotor_tab_thickness_mm?: number | null;
}

/** Mirrors `BobbinConfiguration.__post_init__`: validates the geometry/count fields. */
export function validateBobbinConfiguration(config: BobbinConfiguration): void {
  if (config.count < 1) {
    throw new Error(`bobbin count must be >= 1, got ${config.count}`);
  }
  if (config.bolt_circle_diameter_mm <= 0.0) {
    throw new Error("bolt_circle_diameter_mm must be positive");
  }
  if (config.button_diameter_mm <= 0.0) {
    throw new Error("button_diameter_mm must be positive");
  }
  if ((config.shear_plane_count ?? 1) < 1) {
    throw new Error("shear_plane_count must be >= 1");
  }
  const loadSharingFactor = config.load_sharing_factor ?? 0.75;
  if (!(0.0 < loadSharingFactor && loadSharingFactor <= 1.0)) {
    throw new Error("load_sharing_factor must be in (0, 1]");
  }
  if ((config.stress_concentration_factor ?? 1.5) < 1.0) {
    throw new Error("stress_concentration_factor must be >= 1");
  }
  if (config.rotor_tab_thickness_mm != null && config.rotor_tab_thickness_mm <= 0.0) {
    throw new Error("rotor_tab_thickness_mm must be positive when supplied");
  }
}
