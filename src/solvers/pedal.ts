import { NeedsInputError } from "../errors.ts";
import type { BrakeFluid } from "../models/fluid.ts";
import type { BrakeHardware } from "../models/internal.ts";
import { caliperActiveAreaMm2 } from "./brakeBias.ts";
import { fluidComplianceM3PerPa } from "./fluid.ts";
import { circuitLinePressurePa, masterCylinderAreaM2 } from "./hydraulics.ts";
import { mmToM } from "../units.ts";

/** Fluid volume swallowed by elastic caliper/piston take-up (spec 16.4).
 *
 * The clamp load `F = P * A_active` deflects the caliper body/pistons by
 * `x = F / k`; the pistons advance that far, displacing `A_active * x`.
 * Combining: `dV = A_active^2 * P / k`. Raises `NeedsInputError` when no
 * caliper stiffness is configured rather than assuming a rigid caliper (which
 * would understate pedal travel).
 */
export function caliperTakeupVolumeM3(
  brakes: BrakeHardware,
  axleName: string,
  circuitPressurePa: number,
): number {
  if (brakes.caliper_stiffness_n_per_m == null) {
    throw new NeedsInputError("brake_hardware.caliper_stiffness_n_per_m");
  }
  const axle = axleName === "front" ? brakes.front : brakes.rear;
  const activeAreaM2 = caliperActiveAreaMm2(axle.caliper) * 1.0e-6;
  return (activeAreaM2 ** 2 * circuitPressurePa) / brakes.caliper_stiffness_n_per_m;
}

export interface PedalTravelResult {
  axle_name: string;
  pedal_force_n: number;
  circuit_pressure_pa: number;
  fluid_displaced_volume_m3: number;
  caliper_displaced_volume_m3: number;
  line_displaced_volume_m3: number;
  total_displaced_volume_m3: number;
  master_cylinder_stroke_m: number;
  pedal_stroke_m: number;
  pedal_travel_deg: number;
  max_pedal_travel_deg: number;
  within_limit: boolean;
}

/** Pedal angular travel for one circuit at a design pedal force (spec 16.4).
 *
 * Compliance volume at the master cylinder is the sum of three terms, each
 * growing with circuit pressure `P`:
 *
 *   - fluid compressibility  dV = (V/K) * P
 *   - caliper/piston take-up  dV = A_active^2 * P / k
 *   - line/hose expansion     dV = C_line * P   (C_line supplied by caller; 0
 *     means perfectly rigid lines -- an optimistic floor, not a claim)
 *
 * The master-cylinder piston must sweep `dV_total`, giving stroke
 * `s_mc = dV_total / A_mc`. The pedal pad moves `pedal_ratio * s_mc` along
 * an arc of radius `pedal_arm_length`, so `theta = s_pedal / L_arm`. This
 * is checked against `max_pedal_travel_deg` (baseline 10 deg).
 *
 * `circuit_fluid_volume_ml` defaults to half of the system total, since the
 * two circuits are hydraulically independent and split the column roughly
 * evenly. Raises `NeedsInputError` for any missing geometry/stiffness rather
 * than guessing.
 *
 * NOTE: the last two parameters are swapped relative to the Python
 * declaration order (`circuit_fluid_volume_ml` then `line_compliance_m3_per_pa`).
 * Every real call site (including the golden fixtures) passes
 * `line_compliance_m3_per_pa` by keyword while leaving `circuit_fluid_volume_ml`
 * at its default -- Python resolves that by name, but JS has no keyword
 * arguments, so the harness replays it positionally. Swapping the order here
 * is what makes that replay land on the right parameter.
 */
export function pedalTravel(
  brakes: BrakeHardware,
  axleName: string,
  pedalForceN: number,
  fluid: BrakeFluid,
  circuitFluidVolumeMl: number | null = null,
  lineComplianceM3PerPa = 0.0,
): PedalTravelResult {
  if (brakes.pedal_arm_length_mm == null) {
    throw new NeedsInputError("brake_hardware.pedal_arm_length_mm");
  }
  if (circuitFluidVolumeMl == null) {
    if (brakes.system_fluid_volume_ml == null) {
      throw new NeedsInputError("brake_hardware.system_fluid_volume_ml");
    }
    circuitFluidVolumeMl = brakes.system_fluid_volume_ml / 2.0;
  }

  const pressure = circuitLinePressurePa(pedalForceN, brakes, axleName);

  const dvFluid = fluidComplianceM3PerPa(fluid, circuitFluidVolumeMl) * pressure;
  const dvCaliper = caliperTakeupVolumeM3(brakes, axleName, pressure);
  const dvLine = lineComplianceM3PerPa * pressure;
  const dvTotal = dvFluid + dvCaliper + dvLine;

  const aMc = masterCylinderAreaM2(brakes, axleName);
  const sMc = dvTotal / aMc;
  const sPedal = brakes.pedal_ratio * sMc;
  const armM = mmToM(brakes.pedal_arm_length_mm);
  const thetaDeg = (sPedal / armM) * (180.0 / Math.PI);

  return {
    axle_name: axleName,
    pedal_force_n: pedalForceN,
    circuit_pressure_pa: pressure,
    fluid_displaced_volume_m3: dvFluid,
    caliper_displaced_volume_m3: dvCaliper,
    line_displaced_volume_m3: dvLine,
    total_displaced_volume_m3: dvTotal,
    master_cylinder_stroke_m: sMc,
    pedal_stroke_m: sPedal,
    pedal_travel_deg: thetaDeg,
    max_pedal_travel_deg: brakes.max_pedal_travel_deg,
    within_limit: thetaDeg <= brakes.max_pedal_travel_deg,
  };
}
