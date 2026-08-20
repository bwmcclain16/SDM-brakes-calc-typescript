import { G } from "../constants.ts";
import type { BrakeHardware, Vehicle } from "../models/internal.ts";
import type { SuspensionSetup } from "../models/suspension.ts";
import { lateralLoadTransfer, totalN } from "../models/suspension.ts";
import type { LoadSensitiveTire } from "../models/tires.ts";
import { muX, muY } from "../models/tires.ts";
import { frontAxleTorqueDistribution } from "./brakeBias.ts";
import { dynamicAxleLoadsN, totalMassKg } from "./vehicle.ts";

export interface CombinedBrakingCase {
  driver_mass_kg: number;
  longitudinal_accel_g: number;
  lateral_accel_g: number;
  tire_mu: number;
  combined_slip_exponent?: number;
  steering_angle_deg?: number;
  front_slip_angle_deg?: number;
  rear_slip_angle_deg?: number;
  slip_mu_loss_per_deg?: number;
  // Optional load-sensitive tire (spec 10.1). When present, per-wheel mu is
  // read from mu(Fz) instead of the flat tire_mu; tire_mu stays as the
  // documented fallback so existing screens keep working.
  tire?: LoadSensitiveTire | null;
  // Optional suspension setup (spec 9/12). When present, lateral transfer
  // comes from the roll-stiffness model (geometric + elastic + unsprung)
  // instead of the crude per-axle h_cg/track split.
  suspension?: SuspensionSetup | null;
}

const degToRad = (deg: number): number => (deg * Math.PI) / 180.0;

/** Spec 10.3: `Fx_avail = mu_x*Fz*[1 - (Fy/(mu_y*Fz))^n]^(1/n)`. */
function remainingLongitudinalCapacityN(
  fzN: number,
  fyN: number,
  muXVal: number,
  muYVal: number,
  exponent: number,
): number {
  const longitudinalCapacity = muXVal * fzN;
  const lateralCapacity = muYVal * fzN;
  if (longitudinalCapacity <= 0 || lateralCapacity <= 0) {
    return 0.0;
  }
  const lateralUtilization = Math.min(Math.abs(fyN) / lateralCapacity, 1.0);
  return longitudinalCapacity * (1.0 - lateralUtilization ** exponent) ** (1.0 / exponent);
}

export interface CombinedBrakingRow {
  wheel: string;
  fz_n: number;
  effective_mu: number;
  steering_angle_deg: number;
  slip_angle_deg: number;
  fy_demand_n: number;
  fx_brake_demand_n: number;
  fx_tire_frame_demand_n: number;
  fx_available_n: number;
  rotor_torque_demand_nm: number;
  rotor_torque_available_nm: number;
  combined_utilization: number;
  lock_margin_n: number;
  locks_predicted: boolean;
}

export function evaluateCombinedBraking(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  case_: CombinedBrakingCase,
): CombinedBrakingRow[] {
  const massKg = totalMassKg(vehicle, case_.driver_mass_kg);
  const [frontAxleLoadN, rearAxleLoadN] = dynamicAxleLoadsN(
    vehicle,
    case_.driver_mass_kg,
    case_.longitudinal_accel_g,
  );

  let frontLateralTransferN: number;
  let rearLateralTransferN: number;
  if (case_.suspension != null) {
    const transfer = lateralLoadTransfer(
      vehicle,
      case_.suspension,
      case_.driver_mass_kg,
      case_.lateral_accel_g,
    );
    frontLateralTransferN = totalN(transfer.front);
    rearLateralTransferN = totalN(transfer.rear);
  } else {
    frontLateralTransferN =
      (frontAxleLoadN * case_.lateral_accel_g * vehicle.cg_height_m) / vehicle.front_track_m;
    rearLateralTransferN =
      (rearAxleLoadN * case_.lateral_accel_g * vehicle.cg_height_m) / vehicle.rear_track_m;
  }

  const wheelLoads: Record<string, number> = {
    FL: frontAxleLoadN / 2.0 + frontLateralTransferN / 2.0,
    FR: frontAxleLoadN / 2.0 - frontLateralTransferN / 2.0,
    RL: rearAxleLoadN / 2.0 + rearLateralTransferN / 2.0,
    RR: rearAxleLoadN / 2.0 - rearLateralTransferN / 2.0,
  };
  const totalFzN = Object.values(wheelLoads).reduce((a, b) => a + b, 0);
  const totalFxDemandN = massKg * case_.longitudinal_accel_g * G;
  const totalFyDemandN = massKg * case_.lateral_accel_g * G;
  const frontBrakeFraction = frontAxleTorqueDistribution(brakes);
  const wheelFx: Record<string, number> = {
    FL: (totalFxDemandN * frontBrakeFraction) / 2.0,
    FR: (totalFxDemandN * frontBrakeFraction) / 2.0,
    RL: (totalFxDemandN * (1.0 - frontBrakeFraction)) / 2.0,
    RR: (totalFxDemandN * (1.0 - frontBrakeFraction)) / 2.0,
  };

  const combinedSlipExponent = case_.combined_slip_exponent ?? 2.0;
  const steeringAngleDeg = case_.steering_angle_deg ?? 0.0;
  const frontSlipAngleDeg = case_.front_slip_angle_deg ?? 0.0;
  const rearSlipAngleDeg = case_.rear_slip_angle_deg ?? 0.0;
  const slipMuLossPerDeg = case_.slip_mu_loss_per_deg ?? 0.015;

  const rows: CombinedBrakingRow[] = [];
  for (const wheel of ["FL", "FR", "RL", "RR"]) {
    const fzN = wheelLoads[wheel]!;
    const isFront = wheel.startsWith("F");
    const steerRad = degToRad(isFront ? steeringAngleDeg : 0.0);
    const slipAngleDeg = isFront ? frontSlipAngleDeg : rearSlipAngleDeg;
    const slipKnockdown = 1.0 - slipMuLossPerDeg * Math.abs(slipAngleDeg);
    let baseMuX: number;
    let baseMuY: number;
    if (case_.tire != null) {
      baseMuX = muX(case_.tire, fzN);
      baseMuY = muY(case_.tire, fzN);
    } else {
      baseMuX = baseMuY = case_.tire_mu;
    }
    const effectiveMu = Math.max(baseMuX * slipKnockdown, 0.1);
    const effectiveMuY = Math.max(baseMuY * slipKnockdown, 0.1);
    const fyN = (totalFyDemandN * fzN) / totalFzN;
    const fxVehicleDemandN = wheelFx[wheel]!;
    const fxTireFrameDemandN =
      Math.abs(fxVehicleDemandN * Math.cos(steerRad)) + Math.abs(fyN * Math.sin(steerRad));
    const fxAvailableN = remainingLongitudinalCapacityN(
      fzN,
      fyN,
      effectiveMu,
      effectiveMuY,
      combinedSlipExponent,
    );
    const utilization = fxAvailableN > 0 ? fxTireFrameDemandN / fxAvailableN : Infinity;
    rows.push({
      wheel,
      fz_n: fzN,
      effective_mu: effectiveMu,
      steering_angle_deg: isFront ? steeringAngleDeg : 0.0,
      slip_angle_deg: slipAngleDeg,
      fy_demand_n: fyN,
      fx_brake_demand_n: fxVehicleDemandN,
      fx_tire_frame_demand_n: fxTireFrameDemandN,
      fx_available_n: fxAvailableN,
      // Rotor torque reacts the tire-frame longitudinal force at the
      // rolling radius; the lock-limited ceiling uses the same arm.
      rotor_torque_demand_nm: fxTireFrameDemandN * vehicle.tire_rolling_radius_m,
      rotor_torque_available_nm: fxAvailableN * vehicle.tire_rolling_radius_m,
      combined_utilization: utilization,
      lock_margin_n: fxAvailableN - fxTireFrameDemandN,
      locks_predicted: utilization > 1.0,
    });
  }
  return rows;
}
