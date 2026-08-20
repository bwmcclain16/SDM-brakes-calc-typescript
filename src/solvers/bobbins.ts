/** Brake button (bobbin) drive-joint structural analysis and sizing optimization
 * (spec 22.2).
 *
 * Brake torque reacts through the drive buttons as a tangential force at the
 * bolt-circle radius:
 *
 *     F_total  = T_rotor / r_bobbin
 *     F_nominal = F_total / N
 *     F_design  = Kt * F_total / (K_share * N)     (worst button)
 *
 * The worst button is checked in shear (`tau = F_design / A_shear` against the
 * fastener shear allowable) and in bearing on the rotor drive tab
 * (`sigma_br = F_design / (d * t_tab)` against the rotor yield strength).
 * Optimization brute-forces the (count, diameter) grid and recommends the
 * smallest count, then the smallest diameter, that meets the safety-factor
 * targets -- the user's "minimal buttons, minimal button size" objective.
 */
import { NeedsInputError } from "../errors.ts";
import {
  allowableShearPa,
  validateBobbinConfiguration,
  type BobbinConfiguration,
  type FastenerMaterial,
} from "../models/bobbins.ts";
import type { RotorMaterial } from "../models/rotors.ts";
import { mmToM } from "../units.ts";

export interface BobbinLoadResult {
  rotor_torque_nm: number;
  bobbin_radius_m: number;
  total_tangential_force_n: number;
  per_button_nominal_force_n: number;
  per_button_design_force_n: number;
  shear_area_m2: number;
  shear_stress_pa: number;
  allowable_shear_pa: number;
  shear_safety_factor: number;
  bearing_stress_pa: number | null;
  bearing_safety_factor: number | null;
}

/** Per spec 22.2. Torque is for ONE rotor (axle torque / 2).
 *
 * `rotor_material` + a tab thickness enable the bearing check on the rotor
 * drive slot; pass `rotor_material = null` to skip it explicitly (bearing
 * fields come back `null`). `rotor_thickness_mm` is the fallback tab
 * thickness when `config.rotor_tab_thickness_mm` is null/undefined.
 */
export function bobbinLoads(
  rotor_torque_nm: number,
  config: BobbinConfiguration,
  rotor_material: RotorMaterial | null = null,
  rotor_thickness_mm: number | null = null,
): BobbinLoadResult {
  if (rotor_torque_nm < 0.0) {
    throw new Error("rotor_torque_nm must be >= 0");
  }

  const rBobbin = mmToM(config.bolt_circle_diameter_mm) / 2.0;
  const totalForce = rotor_torque_nm / rBobbin;
  const nominal = totalForce / config.count;
  const design =
    (config.stress_concentration_factor ?? 1.5) *
    totalForce /
    ((config.load_sharing_factor ?? 0.75) * config.count);

  const d = mmToM(config.button_diameter_mm);
  const shearArea = ((config.shear_plane_count ?? 1) * Math.PI * d ** 2) / 4.0;
  const shearStress = design / shearArea;
  const allowableShear = allowableShearPa(config.material);
  const shearSf = shearStress > 0.0 ? allowableShear / shearStress : Infinity;

  let bearingStress: number | null = null;
  let bearingSf: number | null = null;
  if (rotor_material !== null && rotor_material !== undefined) {
    let tabMm = config.rotor_tab_thickness_mm;
    if (tabMm === null || tabMm === undefined) {
      if (rotor_thickness_mm === null || rotor_thickness_mm === undefined) {
        throw new NeedsInputError("bobbin.rotor_tab_thickness_mm (or rotor_thickness_mm)");
      }
      tabMm = rotor_thickness_mm;
    }
    if (rotor_material.yield_strength_pa === null || rotor_material.yield_strength_pa === undefined) {
      throw new NeedsInputError(`rotor_material[${rotor_material.name}].yield_strength_pa`);
    }
    bearingStress = design / (d * mmToM(tabMm));
    bearingSf = bearingStress > 0.0 ? rotor_material.yield_strength_pa / bearingStress : Infinity;
  }

  return {
    rotor_torque_nm,
    bobbin_radius_m: rBobbin,
    total_tangential_force_n: totalForce,
    per_button_nominal_force_n: nominal,
    per_button_design_force_n: design,
    shear_area_m2: shearArea,
    shear_stress_pa: shearStress,
    allowable_shear_pa: allowableShear,
    shear_safety_factor: shearSf,
    bearing_stress_pa: bearingStress,
    bearing_safety_factor: bearingSf,
  };
}

/** Bearing forces on BOTH sides of the floating-rotor drive joint.
 *
 * The drive button reacts the brake torque as a tangential force that bears
 * against two structures: the friction-ring (rotor) drive tab on one side and
 * the hat/carrier mounting ear(s) on the other. In a single-shear lap joint
 * each side sees the full per-button force; in a double-shear clevis the two
 * hat ears split the force (F/2 each) while the rotor tab in the middle still
 * carries the full force. Bearing stress is `F / (d * t)` against each
 * part's own tab thickness and yield strength.
 */
export interface MountForceResult {
  per_button_force_n: number; // worst-button tangential force (F_design)
  friction_ring_force_n: number; // force on the rotor drive tab (full)
  friction_ring_bearing_stress_pa: number;
  friction_ring_bearing_sf: number;
  mount_ear_count: number;
  mount_ear_force_n: number; // force on ONE hat/carrier ear
  mount_bearing_stress_pa: number;
  mount_bearing_sf: number;
  total_ring_reaction_n: number; // summed over all N buttons
  total_mount_reaction_n: number;
}

/** Bearing on both sides of the drive joint (friction ring vs hat/mount).
 *
 * `per_button_force_n` is the worst-button design force from
 * {@link bobbinLoads}. `mount_ear_count` is how many hat ears share the
 * load per button: 1 for a single-shear lap joint, 2 for a double-shear
 * clevis (each ear then carries half). Bearing stress on each side uses that
 * side's own tab thickness and yield.
 */
export function rotorMountForces(
  per_button_force_n: number,
  button_count: number,
  button_diameter_mm: number,
  rotor_tab_thickness_mm: number,
  rotor_yield_pa: number,
  mount_tab_thickness_mm: number,
  mount_yield_pa: number,
  mount_ear_count: number = 1,
): MountForceResult {
  if (per_button_force_n < 0.0) {
    throw new Error("per_button_force_n must be >= 0");
  }
  if (button_count < 1) {
    throw new Error("button_count must be >= 1");
  }
  if (button_diameter_mm <= 0.0 || rotor_tab_thickness_mm <= 0.0 || mount_tab_thickness_mm <= 0.0) {
    throw new Error("button diameter and both tab thicknesses must be positive");
  }
  if (mount_ear_count < 1) {
    throw new Error("mount_ear_count must be >= 1");
  }
  if (rotor_yield_pa <= 0.0 || mount_yield_pa <= 0.0) {
    throw new Error("both yield strengths must be positive");
  }

  const d = mmToM(button_diameter_mm);
  const ringForce = per_button_force_n; // middle member, full load
  const earForce = per_button_force_n / mount_ear_count; // each hat ear

  const ringStress = ringForce / (d * mmToM(rotor_tab_thickness_mm));
  const earStress = earForce / (d * mmToM(mount_tab_thickness_mm));

  return {
    per_button_force_n,
    friction_ring_force_n: ringForce,
    friction_ring_bearing_stress_pa: ringStress,
    friction_ring_bearing_sf: ringStress > 0.0 ? rotor_yield_pa / ringStress : Infinity,
    mount_ear_count,
    mount_ear_force_n: earForce,
    mount_bearing_stress_pa: earStress,
    mount_bearing_sf: earStress > 0.0 ? mount_yield_pa / earStress : Infinity,
    total_ring_reaction_n: ringForce * button_count,
    total_mount_reaction_n: per_button_force_n * button_count,
  };
}

export interface BobbinCandidateRow {
  count: number;
  button_diameter_mm: number;
  per_button_nominal_force_n: number;
  per_button_design_force_n: number;
  shear_stress_mpa: number;
  shear_safety_factor: number;
  bearing_stress_mpa: number;
  bearing_safety_factor: number | null;
  passes: boolean;
}

export interface BobbinOptimizationResult {
  candidates: BobbinCandidateRow[];
  recommended_count: number | null;
  recommended_diameter_mm: number | null;
  recommended: BobbinLoadResult | null;
}

/** Brute-force the (count, diameter) grid; recommend min count then min size.
 *
 * Every candidate is returned in `candidates` (with pass flags) so the UI
 * can show *why* a configuration fails. When nothing passes the recommendation
 * fields are `null` -- not an exception -- and the table still comes back.
 */
export function optimizeBobbins(
  rotor_torque_nm: number,
  bolt_circle_diameter_mm: number,
  material: FastenerMaterial,
  rotor_material: RotorMaterial,
  rotor_thickness_mm: number,
  counts: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  diameters_mm: readonly number[] = [5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0],
  target_shear_sf: number = 2.0,
  target_bearing_sf: number = 1.5,
  shear_plane_count: number = 1,
  load_sharing_factor: number = 0.75,
  stress_concentration_factor: number = 1.5,
  rotor_tab_thickness_mm: number | null = null,
): BobbinOptimizationResult {
  const rows: BobbinCandidateRow[] = [];
  const results = new Map<string, BobbinLoadResult>();
  const keyOf = (count: number, diameterMm: number): string => `${count} ${diameterMm}`;

  for (const count of counts) {
    for (const diameter_mm of diameters_mm) {
      const config: BobbinConfiguration = {
        count,
        bolt_circle_diameter_mm,
        button_diameter_mm: diameter_mm,
        material,
        shear_plane_count,
        load_sharing_factor,
        stress_concentration_factor,
        rotor_tab_thickness_mm,
      };
      validateBobbinConfiguration(config);
      const result = bobbinLoads(rotor_torque_nm, config, rotor_material, rotor_thickness_mm);
      results.set(keyOf(count, diameter_mm), result);
      const shearPass = result.shear_safety_factor >= target_shear_sf;
      const bearingPass =
        result.bearing_safety_factor !== null &&
        result.bearing_safety_factor !== undefined &&
        result.bearing_safety_factor >= target_bearing_sf;
      rows.push({
        count,
        button_diameter_mm: diameter_mm,
        per_button_nominal_force_n: result.per_button_nominal_force_n,
        per_button_design_force_n: result.per_button_design_force_n,
        shear_stress_mpa: result.shear_stress_pa / 1e6,
        shear_safety_factor: result.shear_safety_factor,
        bearing_stress_mpa: (result.bearing_stress_pa ?? 0.0) / 1e6,
        bearing_safety_factor: result.bearing_safety_factor,
        passes: shearPass && bearingPass,
      });
    }
  }

  const candidates = [...rows].sort(
    (a, b) => a.count - b.count || a.button_diameter_mm - b.button_diameter_mm,
  );
  const best = candidates.find((row) => row.passes);
  if (best === undefined) {
    return { candidates, recommended_count: null, recommended_diameter_mm: null, recommended: null };
  }
  const bestCount = best.count;
  const bestDiameter = best.button_diameter_mm;
  return {
    candidates,
    recommended_count: bestCount,
    recommended_diameter_mm: bestDiameter,
    recommended: results.get(keyOf(bestCount, bestDiameter))!,
  };
}
