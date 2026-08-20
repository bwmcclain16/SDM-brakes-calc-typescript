import { NeedsInputError } from "../errors.ts";
import type { AxleBrake, BrakeHardware, Caliper } from "../models/internal.ts";
import { mmToM } from "../units.ts";

export const UNIFORM_PRESSURE = "uniform_pressure";
export const UNIFORM_WEAR = "uniform_wear";

export const pistonAreaMm2 = (pistonDiameterMm: number): number =>
  (Math.PI * pistonDiameterMm ** 2) / 4.0;

const _BOTH_SIDES_CONVENTION = "total_active_piston_area";

/** Total hydraulic piston area that generates clamp force.
 *
 * Convention (default, both rotor faces clamped): `piston_count` is the
 * TOTAL number of pistons across both sides of the opposed caliper
 * (P4.24 front = 4, rear = 2). The rotor has two friction faces, and the
 * opposed-piston clamp force per face equals `P * A_one_side`. Friction
 * torque summed over both faces is therefore:
 *
 *     T = 2 * mu_pad * (P * A_one_side) * r_eff
 *       =     mu_pad * (P * A_total)    * r_eff
 *
 * so callers use the TOTAL piston area with a single (no extra factor of 2)
 * `mu*P*A*r` torque expression. This keeps the two-face physics explicit
 * rather than coincidental. Only the `total_active_piston_area` convention
 * is supported; any other value is rejected so the choice is never silent.
 */
export function caliperActiveAreaMm2(caliper: Caliper): number {
  if (caliper.area_convention !== _BOTH_SIDES_CONVENTION) {
    throw new Error(
      `caliper '${caliper.name}': unsupported area_convention ` +
        `'${caliper.area_convention}'. Use '${_BOTH_SIDES_CONVENTION}' ` +
        "(piston_count = total pistons across both sides; both rotor faces clamped).",
    );
  }
  return caliper.piston_count * pistonAreaMm2(caliper.piston_diameter_mm);
}

/** 24-25 workbook (uniform-wear / mean) method: `r_o - pad_height/2`. */
export function uniformWearRadiusM(axle: AxleBrake): number {
  const outerRadiusM = mmToM(axle.rotor_outer_diameter_mm) / 2.0;
  return outerRadiusM - mmToM(axle.pad_height_mm) / 2.0;
}

/** Uniform-pressure effective radius over the pad swept band (spec 15):
 *
 * `r_eff = (2/3) (r_o^3 - r_i^3) / (r_o^2 - r_i^2)` using the pad swept outer
 * and inner radii. Raises `NeedsInputError` when the swept band is not given
 * rather than silently falling back, so the method choice is never hidden.
 */
export function uniformPressureRadiusM(axle: AxleBrake): number {
  if (axle.pad_swept_outer_diameter_mm == null || axle.pad_swept_inner_diameter_mm == null) {
    throw new NeedsInputError(
      "axle.pad_swept_outer_diameter_mm / pad_swept_inner_diameter_mm " +
        "(required for uniform_pressure effective radius)",
    );
  }
  const rO = mmToM(axle.pad_swept_outer_diameter_mm) / 2.0;
  const rI = mmToM(axle.pad_swept_inner_diameter_mm) / 2.0;
  return (2.0 / 3.0) * (rO ** 3 - rI ** 3) / (rO ** 2 - rI ** 2);
}

/** Effective friction radius. Production default is uniform-pressure; the
 * uniform-wear pad-height method is retained as a hand-check / fallback. */
export function effectiveRotorRadiusM(axle: AxleBrake, method: string = UNIFORM_PRESSURE): number {
  if (method === UNIFORM_PRESSURE) return uniformPressureRadiusM(axle);
  if (method === UNIFORM_WEAR) return uniformWearRadiusM(axle);
  throw new Error(`unknown effective_radius_method '${method}'`);
}

export const masterCylinderAreaMm2 = (boreMm: number): number => (Math.PI * boreMm ** 2) / 4.0;

/** Per-axle torque factor for the bias split.
 *
 * With independent master cylinders the bias bar splits driver pushrod FORCE by
 * `pressure_fraction`; circuit pressure is `pressure_fraction * F_total /
 * A_MC`. So the factor carries `1/A_MC`. When both bores are equal the term
 * cancels in the front/rear ratio and the split matches the single-MC proxy.
 */
export function axleTorqueFactor(
  axle: AxleBrake,
  pressureFraction: number,
  mcBoreMm: number,
  method: string = UNIFORM_PRESSURE,
): number {
  return (
    caliperActiveAreaMm2(axle.caliper) *
    (pressureFraction / masterCylinderAreaMm2(mcBoreMm)) *
    effectiveRotorRadiusM(axle, method)
  );
}

export function frontAxleTorqueDistribution(brakes: BrakeHardware, method: string = UNIFORM_PRESSURE): number {
  const frontFactor = axleTorqueFactor(
    brakes.front, brakes.front_pressure_fraction, brakes.front_master_cylinder_bore_mm, method,
  );
  const rearFactor = axleTorqueFactor(
    brakes.rear, brakes.rear_pressure_fraction, brakes.rear_master_cylinder_bore_mm, method,
  );
  return frontFactor / (frontFactor + rearFactor);
}

export function rearAxleTorqueDistribution(brakes: BrakeHardware, method: string = UNIFORM_PRESSURE): number {
  return 1.0 - frontAxleTorqueDistribution(brakes, method);
}

export const pressureRatioFrontToRear = (brakes: BrakeHardware): number =>
  brakes.front_pressure_fraction / brakes.rear_pressure_fraction;

export const areaRatioFrontToRear = (brakes: BrakeHardware): number =>
  caliperActiveAreaMm2(brakes.front.caliper) / caliperActiveAreaMm2(brakes.rear.caliper);

/** Spec section 15 hand-check: approximates r_F/r_R by the rotor OD ratio.
 *
 * This reproduces the spec's documented ~73.1% front split and is kept ONLY
 * as a transparency hand-check. The production solver uses the pad-height
 * effective radius (see `effectiveRotorRadiusM`), which yields a slightly
 * lower front split.
 */
export function frontAxleTorqueDistributionOdRatioHandcheck(brakes: BrakeHardware): number {
  const factor = (axle: AxleBrake, pressureFraction: number): number =>
    caliperActiveAreaMm2(axle.caliper) * pressureFraction * mmToM(axle.rotor_outer_diameter_mm);

  const front = factor(brakes.front, brakes.front_pressure_fraction);
  const rear = factor(brakes.rear, brakes.rear_pressure_fraction);
  return front / (front + rear);
}
