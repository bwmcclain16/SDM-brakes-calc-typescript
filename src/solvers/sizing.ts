import { NeedsInputError } from "../errors.ts";
import type { BrakeHardware } from "../models/internal.ts";
import { UNIFORM_PRESSURE, caliperActiveAreaMm2, effectiveRotorRadiusM } from "./brakeBias.ts";
import { circuitLinePressurePa, linePressuresPa, padMu } from "./hydraulics.ts";
import { areaMm2ToM2 } from "../units.ts";

export const GRAVITY_M_S2 = 9.80665;

/** Brake torque one axle must produce to hit the target deceleration.
 *
 * Total ground braking force is `m * (g_decel)`; reacted at the tire it needs
 * `F * r_tire` of brake torque, of which this axle carries
 * `axle_torque_distribution`. This is the demand side that caliper area must
 * meet at the available line pressure.
 */
export function requiredAxleTorqueNm(
  totalMassKg: number,
  decelerationG: number,
  tireRollingRadiusM: number,
  axleTorqueDistribution: number,
): number {
  const totalBrakeTorque = totalMassKg * decelerationG * GRAVITY_M_S2 * tireRollingRadiusM;
  return axleTorqueDistribution * totalBrakeTorque;
}

/** Spec 17.1: `A_required = T / (mu * P * r_eff)` (total active piston area,
 * both-faces convention). Returns mm^2 so it compares directly to
 * `caliperActiveAreaMm2`. */
export function caliperRequiredActiveAreaMm2(
  targetAxleTorqueNm: number,
  circuitPressurePa: number,
  padMuValue: number,
  effectiveRadiusM: number,
): number {
  if (circuitPressurePa <= 0.0) {
    const err = new Error("circuit_pressure_pa must be positive to size caliper area");
    throw err;
  }
  const requiredAreaM2 = targetAxleTorqueNm / (padMuValue * circuitPressurePa * effectiveRadiusM);
  return requiredAreaM2 / areaMm2ToM2(1.0);
}

export interface CaliperAreaCheck {
  axle_name: string;
  target_axle_torque_nm: number;
  circuit_pressure_pa: number;
  required_active_area_mm2: number;
  actual_active_area_mm2: number;
  area_margin_ratio: number;
  adequate: boolean;
}

/** Required vs actual caliper piston area at a design pedal force. */
export function caliperAreaCheck(
  brakes: BrakeHardware,
  axleName: string,
  targetAxleTorqueNm: number,
  pedalForceN: number,
  padTemperatureC: number | null = null,
  method: string = UNIFORM_PRESSURE,
): CaliperAreaCheck {
  const axle = axleName === "front" ? brakes.front : brakes.rear;
  const pressure = circuitLinePressurePa(pedalForceN, brakes, axleName);
  const mu = padMu(brakes, padTemperatureC);
  const rEff = effectiveRotorRadiusM(axle, method);
  const required = caliperRequiredActiveAreaMm2(targetAxleTorqueNm, pressure, mu, rEff);
  const actual = caliperActiveAreaMm2(axle.caliper);
  return {
    axle_name: axleName,
    target_axle_torque_nm: targetAxleTorqueNm,
    circuit_pressure_pa: pressure,
    required_active_area_mm2: required,
    actual_active_area_mm2: actual,
    area_margin_ratio: actual / required,
    adequate: actual >= required,
  };
}

export interface LinePressureSafetyFactor {
  pedal_force_n: number;
  front_pressure_pa: number;
  rear_pressure_pa: number;
  max_circuit_pressure_pa: number;
  rated_pressure_pa: number;
  safety_factor: number;
  within_limit: boolean;
}

/** Spec 16.3: `SF = P_rated / P_max`.
 *
 * `P_rated` is the absolute pressure ceiling the lines/sensors are allowed to
 * see (baseline: 2500 psi = 17.24 MPa). `P_max` is the higher of the two
 * circuit pressures at the design pedal force. Raises `NeedsInputError` when
 * no rated pressure is configured rather than fabricating a limit.
 */
export function linePressureSafetyFactor(
  brakes: BrakeHardware,
  pedalForceN: number,
): LinePressureSafetyFactor {
  if (brakes.line_rated_pressure_pa == null) {
    throw new NeedsInputError("brake_hardware.line_rated_pressure_pa");
  }
  const [frontP, rearP] = linePressuresPa(pedalForceN, brakes);
  const maxP = Math.max(frontP, rearP);
  const sf = brakes.line_rated_pressure_pa / maxP;
  return {
    pedal_force_n: pedalForceN,
    front_pressure_pa: frontP,
    rear_pressure_pa: rearP,
    max_circuit_pressure_pa: maxP,
    rated_pressure_pa: brakes.line_rated_pressure_pa,
    safety_factor: sf,
    within_limit: sf >= 1.0,
  };
}
