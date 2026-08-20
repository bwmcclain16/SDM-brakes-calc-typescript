import { G } from "../constants.ts";
import type { Vehicle } from "./internal.ts";

/** Per-axle suspension inputs (spec 12.1). Rates are per corner. */
export interface AxleSuspension {
  spring_rate_n_per_m: number;
  // Motion ratio = spring displacement / wheel displacement, so
  // k_wheel = k_spring * MR^2 (spec 12.2).
  motion_ratio: number;
  arb_roll_stiffness_nm_per_rad: number;
  roll_center_height_m: number;
  unsprung_mass_kg: number;
  unsprung_cg_height_m: number;
  tire_vertical_rate_n_per_m?: number | null;
}

export interface SuspensionSetup {
  front: AxleSuspension;
  rear: AxleSuspension;
}

/** Spec 12.2: `k_wheel = k_spring * MR^2`. */
export function wheelRateNPerM(springRateNPerM: number, motionRatio: number): number {
  return springRateNPerM * motionRatio ** 2;
}

/** Wheel rate in series with the tire spring (spec 12.2). `null`/`undefined` tire
 * rate means a rigid tire -- the optimistic bound, not a measurement. */
export function rideRateNPerM(wheelRate: number, tireVerticalRate: number | null | undefined): number {
  if (tireVerticalRate === null || tireVerticalRate === undefined) {
    return wheelRate;
  }
  return 1.0 / (1.0 / wheelRate + 1.0 / tireVerticalRate);
}

/** Roll stiffness of one axle's two ride springs.
 *
 * `K_phi = sum(k_i * y_i^2)` with both corners at `y = t/2` gives
 * `K_phi = k * t^2 / 2`. NOTE: this is intentionally half of the spec's
 * section 12.3 approximation `(k_L + k_R)/2 * t^2`, which places the
 * springs at the full track width instead of the half-track moment arm;
 * the mechanics here follow Milliken's standard result. Flagged in
 * docs/audit_and_roadmap_to_phase9.md as a spec conflict.
 */
export function axleSpringRollStiffnessNmPerRad(rideRatePerCorner: number, trackM: number): number {
  return (rideRatePerCorner * trackM ** 2) / 2.0;
}

/** Spec 12.3: spring contribution plus ARB contribution. */
export function axleRollStiffnessNmPerRad(axle: AxleSuspension, trackM: number): number {
  const ride = rideRateNPerM(
    wheelRateNPerM(axle.spring_rate_n_per_m, axle.motion_ratio),
    axle.tire_vertical_rate_n_per_m,
  );
  return axleSpringRollStiffnessNmPerRad(ride, trackM) + axle.arb_roll_stiffness_nm_per_rad;
}

export interface AxleLateralTransfer {
  axle_name: string;
  geometric_n: number;
  elastic_n: number;
  unsprung_n: number;
}

export const totalN = (t: AxleLateralTransfer): number => t.geometric_n + t.elastic_n + t.unsprung_n;

export interface LateralTransferResult {
  front: AxleLateralTransfer;
  rear: AxleLateralTransfer;
  front_roll_stiffness_nm_per_rad: number;
  rear_roll_stiffness_nm_per_rad: number;
  front_roll_stiffness_fraction: number;
  roll_angle_rad: number;
  sprung_mass_kg: number;
  sprung_cg_height_m: number;
  roll_axis_height_at_cg_m: number;
}

/** Roll-stiffness-based lateral load transfer per axle (spec 9.1-9.3).
 *
 * Decomposes each axle's transfer into the three standard contributions:
 *
 *   - unsprung   `m_us,axle * a_y * h_us / t`
 *   - geometric  `m_s,axle * a_y * h_RC / t` (reacted through the links)
 *   - elastic    `lambda_roll,axle * m_s * a_y * (h_s - h_RA) / t`
 *     (sprung-mass roll moment shared by roll-stiffness fraction, spec 9.2)
 *
 * Assumptions, stated: the sprung mass front/rear split equals the total
 * static split (sprung CG sits at the same wheelbase station as the total
 * CG), and the roll-axis height is interpolated between the axle roll
 * centers at that station. Both are standard screening simplifications.
 */
export function lateralLoadTransfer(
  vehicle: Vehicle,
  suspension: SuspensionSetup,
  driverMassKg: number,
  lateralAccelG: number,
): LateralTransferResult {
  const totalMass = vehicle.mass_without_driver_kg + driverMassKg;
  const ay = lateralAccelG * G;

  const mUsF = suspension.front.unsprung_mass_kg;
  const mUsR = suspension.rear.unsprung_mass_kg;
  const sprungMass = totalMass - mUsF - mUsR;
  if (sprungMass <= 0.0) {
    throw new Error("unsprung masses exceed total vehicle mass");
  }

  // Sprung CG height from the total-CG bookkeeping identity.
  const sprungCgH =
    (totalMass * vehicle.cg_height_m -
      mUsF * suspension.front.unsprung_cg_height_m -
      mUsR * suspension.rear.unsprung_cg_height_m) /
    sprungMass;

  const frontFraction = vehicle.static_front_weight_fraction;
  const mSFront = sprungMass * frontFraction;
  const mSRear = sprungMass - mSFront;

  // Roll-axis height at the sprung CG station (rear RC at x=0, front at L).
  const hRa =
    suspension.rear.roll_center_height_m +
    (suspension.front.roll_center_height_m - suspension.rear.roll_center_height_m) * frontFraction;

  const kFront = axleRollStiffnessNmPerRad(suspension.front, vehicle.front_track_m);
  const kRear = axleRollStiffnessNmPerRad(suspension.rear, vehicle.rear_track_m);
  const kTotal = kFront + kRear;
  const lambdaFront = kFront / kTotal;

  const rollMoment = sprungMass * ay * (sprungCgH - hRa);
  const rollAngle = rollMoment / kTotal;

  const axleTransfer = (
    name: string,
    axle: AxleSuspension,
    trackM: number,
    mSAxle: number,
    stiffnessShare: number,
  ): AxleLateralTransfer => ({
    axle_name: name,
    geometric_n: (mSAxle * ay * axle.roll_center_height_m) / trackM,
    elastic_n: (stiffnessShare * rollMoment) / trackM,
    unsprung_n: (axle.unsprung_mass_kg * ay * axle.unsprung_cg_height_m) / trackM,
  });

  return {
    front: axleTransfer("front", suspension.front, vehicle.front_track_m, mSFront, lambdaFront),
    rear: axleTransfer("rear", suspension.rear, vehicle.rear_track_m, mSRear, 1.0 - lambdaFront),
    front_roll_stiffness_nm_per_rad: kFront,
    rear_roll_stiffness_nm_per_rad: kRear,
    front_roll_stiffness_fraction: lambdaFront,
    roll_angle_rad: rollAngle,
    sprung_mass_kg: sprungMass,
    sprung_cg_height_m: sprungCgH,
    roll_axis_height_at_cg_m: hRa,
  };
}
