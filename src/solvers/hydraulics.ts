import { NeedsInputError } from "../errors.ts";
import type { AxleBrake, BrakeHardware } from "../models/internal.ts";
import type { PadFrictionModel } from "../models/padFriction.ts";
import { muAt } from "../models/padFriction.ts";
import { UNIFORM_PRESSURE, caliperActiveAreaMm2, effectiveRotorRadiusM } from "./brakeBias.ts";
import { areaMm2ToM2, mmToM } from "../units.ts";

function circuit(brakes: BrakeHardware, axleName: string): [AxleBrake, number, number] {
  if (axleName === "front") {
    return [brakes.front, brakes.front_pressure_fraction, brakes.front_master_cylinder_bore_mm];
  }
  return [brakes.rear, brakes.rear_pressure_fraction, brakes.rear_master_cylinder_bore_mm];
}

export function requirePadMu(brakes: BrakeHardware): number {
  if (brakes.pad_friction_coefficient == null) {
    throw new NeedsInputError("brake_hardware.pad_friction_coefficient");
  }
  return brakes.pad_friction_coefficient;
}

/** Coefficient of friction to use for a torque computation.
 *
 * When a temperature-dependent `pad_friction_model` is attached *and* a
 * `pad_temperature_c` is supplied, mu is read from the digitized mu(T) curve
 * (clamped below the low bound, raising `PadTemperatureLimitExceeded` above
 * the characterized band). Otherwise the scalar design coefficient is used --
 * this is the path for static checks (brake bias, line-pressure sizing) that
 * have no rotor-temperature context.
 */
export function padMu(brakes: BrakeHardware, padTemperatureC: number | null = null): number {
  if (brakes.pad_friction_model != null && padTemperatureC != null) {
    return muAt(brakes.pad_friction_model as PadFrictionModel, padTemperatureC);
  }
  return requirePadMu(brakes);
}

export function masterCylinderAreaM2(brakes: BrakeHardware, axleName: string): number {
  const [, , boreMm] = circuit(brakes, axleName);
  const boreM = mmToM(boreMm);
  return (Math.PI * boreM ** 2) / 4.0;
}

export const pushrodForceTotalN = (pedalForceN: number, brakes: BrakeHardware): number =>
  pedalForceN * brakes.pedal_ratio * brakes.pedal_efficiency;

/** Pressure in one hydraulically-independent circuit.
 *
 * The balance bar splits the total pushrod force by the bias fraction; each
 * circuit's master cylinder then converts its share to pressure:
 * `P = (lambda_bias * F_pushrod_total) / A_MC`.
 */
export function circuitLinePressurePa(pedalForceN: number, brakes: BrakeHardware, axleName: string): number {
  const [, fraction] = circuit(brakes, axleName);
  const circuitForce = fraction * pushrodForceTotalN(pedalForceN, brakes);
  return circuitForce / masterCylinderAreaM2(brakes, axleName);
}

/** (front, rear) circuit pressures at a given pedal force. */
export function linePressuresPa(pedalForceN: number, brakes: BrakeHardware): [number, number] {
  return [
    circuitLinePressurePa(pedalForceN, brakes, "front"),
    circuitLinePressurePa(pedalForceN, brakes, "rear"),
  ];
}

export const clampForceN = (circuitPressurePa: number, activeAreaMm2: number): number =>
  circuitPressurePa * areaMm2ToM2(activeAreaMm2);

/** Brake torque for one axle from that circuit's line pressure (already
 * bias-split; do NOT re-apply the bias fraction here). */
export function axleBrakeTorqueNm(
  circuitPressurePa: number,
  brakes: BrakeHardware,
  axleName: string,
  padTemperatureC: number | null = null,
  method: string = UNIFORM_PRESSURE,
): number {
  const mu = padMu(brakes, padTemperatureC);
  const axle = axleName === "front" ? brakes.front : brakes.rear;
  const activeArea = caliperActiveAreaMm2(axle.caliper);
  return mu * clampForceN(circuitPressurePa, activeArea) * effectiveRotorRadiusM(axle, method);
}

export function axleBrakeTorqueFromPedalNm(
  pedalForceN: number,
  brakes: BrakeHardware,
  axleName: string,
  padTemperatureC: number | null = null,
  method: string = UNIFORM_PRESSURE,
): number {
  const pressure = circuitLinePressurePa(pedalForceN, brakes, axleName);
  return axleBrakeTorqueNm(pressure, brakes, axleName, padTemperatureC, method);
}

/** Pedal force that produces a target pressure in one circuit. */
export function pedalForceForCircuitPressureN(
  targetCircuitPressurePa: number,
  brakes: BrakeHardware,
  axleName: string,
): number {
  const [, fraction] = circuit(brakes, axleName);
  return (
    (targetCircuitPressurePa * masterCylinderAreaM2(brakes, axleName)) /
    (fraction * brakes.pedal_ratio * brakes.pedal_efficiency)
  );
}
