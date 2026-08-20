/** Top-level parameterized sweep (speed x driver mass x deceleration x bias)
 * tying the whole calculator together for a straight-line braking event. */
import { PadTemperatureLimitExceeded } from "../errors.ts";
import type { AxleBrake, BrakeHardware, DriverMassSweep, StraightLineEvent, Vehicle } from "../models/internal.ts";
import type { PadFrictionModel } from "../models/padFriction.ts";
import { muAt } from "../models/padFriction.ts";
import type { RotorMaterial } from "../models/rotors.ts";
import { lumpedTemperatureRiseC } from "./thermal.ts";
import type { AeroMap } from "./aero.ts";
import { downforceAtSpeed } from "./aero.ts";
import { frontAxleTorqueDistribution, rearAxleTorqueDistribution } from "./brakeBias.ts";
import { requiredAxleTorqueNm } from "./sizing.ts";
import {
  brakingDurationS,
  driverMassesKg,
  dynamicAxleLoadsN,
  kineticEnergyJ,
  stoppingDistanceM,
  totalMassKg,
} from "./vehicle.ts";

export interface StraightLineResult {
  driver_mass_kg: number;
  initial_speed_mph: number;
  target_deceleration_g: number;
  total_mass_kg: number;
  kinetic_energy_j: number;
  energy_per_rotor_j: number;
  front_energy_per_rotor_j: number;
  rear_energy_per_rotor_j: number;
  front_energy_density_j_kg: number;
  rear_energy_density_j_kg: number;
  stopping_distance_m: number;
  braking_duration_s: number;
  front_dynamic_load_n: number;
  rear_dynamic_load_n: number;
  front_aero_downforce_n: number;
  rear_aero_downforce_n: number;
  ideal_front_bias: number;
  actual_front_torque_distribution: number;
  actual_rear_torque_distribution: number;
  total_brake_torque_nm: number;
  front_axle_torque_nm: number;
  rear_axle_torque_nm: number;
  front_rotor_torque_nm: number;
  rear_rotor_torque_nm: number;
  front_rotor_delta_t_c: number | null;
  rear_rotor_delta_t_c: number | null;
  effective_radius_method: string;
  ambient_temperature_c: number;
  front_rotor_peak_temperature_c: number | null;
  rear_rotor_peak_temperature_c: number | null;
  front_pad_mu_at_temperature: number | null;
  rear_pad_mu_at_temperature: number | null;
  front_pad_over_temperature_limit: boolean;
  rear_pad_over_temperature_limit: boolean;
}

/** Conservative lumped rotor temperature rise (spec 20.1): all assigned
 * brake energy enters the rotor, `dT = Q / (m c_p)`. Returns `null` when
 * no material (hence no specific heat) is available rather than guessing.
 */
function rotorDeltaTC(
  energyPerRotorJ: number,
  axle: AxleBrake,
  rotorMaterials: Record<string, RotorMaterial> | null,
): number | null {
  if (rotorMaterials === null || axle.rotor_material == null) return null;
  const material = rotorMaterials[axle.rotor_material] ?? null;
  if (material === null) return null;
  return lumpedTemperatureRiseC(energyPerRotorJ, axle.rotor_mass_kg, material.specific_heat_j_kgk);
}

/** Evaluate the temperature-dependent pad mu at the rotor peak temperature.
 *
 * Returns `[peak_temperature_c, mu, over_limit]`. When no mu(T) model or no
 * rotor temperature is available, mu is `null`. The model throws
 * `PadTemperatureLimitExceeded` above the characterized band; for sweep
 * robustness that is caught here and reported as `over_limit=true` (mu null)
 * rather than aborting the whole parametric sweep -- the throw still fires for
 * any single coupled torque computation that calls `muAt` directly.
 */
function padMuAtPeak(
  brakes: BrakeHardware,
  deltaTC: number | null,
  ambientTemperatureC: number,
): [number | null, number | null, boolean] {
  if (deltaTC === null) return [null, null, false];
  const peakC = ambientTemperatureC + deltaTC;
  if (brakes.pad_friction_model == null) return [peakC, null, false];
  try {
    return [peakC, muAt(brakes.pad_friction_model as PadFrictionModel, peakC), false];
  } catch (e) {
    if (e instanceof PadTemperatureLimitExceeded) return [peakC, null, true];
    throw e;
  }
}

export function analyzeEvent(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  driverMassKg: number,
  event: StraightLineEvent,
  aeroMap: AeroMap | null = null,
  rotorMaterials: Record<string, RotorMaterial> | null = null,
  effectiveRadiusMethod: string = "uniform_pressure",
  ambientTemperatureC = 25.0,
): StraightLineResult {
  const mass = totalMassKg(vehicle, driverMassKg);
  const energy = kineticEnergyJ(mass, event.initial_speed_mph);
  const [frontAero, rearAero] = downforceAtSpeed(aeroMap, event.initial_speed_mph);
  const [frontLoad, rearLoad] = dynamicAxleLoadsN(
    vehicle, driverMassKg, event.target_deceleration_g, frontAero, rearAero,
  );
  const frontTorqueDistribution = frontAxleTorqueDistribution(brakes, effectiveRadiusMethod);
  const rearTorqueDistribution = rearAxleTorqueDistribution(brakes, effectiveRadiusMethod);
  const frontAxleTorque = requiredAxleTorqueNm(
    mass, event.target_deceleration_g, vehicle.tire_rolling_radius_m, frontTorqueDistribution,
  );
  const rearAxleTorque = requiredAxleTorqueNm(
    mass, event.target_deceleration_g, vehicle.tire_rolling_radius_m, rearTorqueDistribution,
  );
  const frontEnergyPerRotor = energy * frontTorqueDistribution / 2.0;
  const rearEnergyPerRotor = energy * rearTorqueDistribution / 2.0;
  const frontDeltaT = rotorDeltaTC(frontEnergyPerRotor, brakes.front, rotorMaterials);
  const rearDeltaT = rotorDeltaTC(rearEnergyPerRotor, brakes.rear, rotorMaterials);
  const [frontPeakC, frontMuT, frontOver] = padMuAtPeak(brakes, frontDeltaT, ambientTemperatureC);
  const [rearPeakC, rearMuT, rearOver] = padMuAtPeak(brakes, rearDeltaT, ambientTemperatureC);
  return {
    driver_mass_kg: driverMassKg,
    initial_speed_mph: event.initial_speed_mph,
    target_deceleration_g: event.target_deceleration_g,
    total_mass_kg: mass,
    kinetic_energy_j: energy,
    energy_per_rotor_j: energy / 4.0,
    front_energy_per_rotor_j: frontEnergyPerRotor,
    rear_energy_per_rotor_j: rearEnergyPerRotor,
    front_energy_density_j_kg: frontEnergyPerRotor / brakes.front.rotor_mass_kg,
    rear_energy_density_j_kg: rearEnergyPerRotor / brakes.rear.rotor_mass_kg,
    stopping_distance_m: stoppingDistanceM(
      event.initial_speed_mph,
      event.final_speed_mph,
      event.target_deceleration_g,
    ),
    braking_duration_s: brakingDurationS(
      event.initial_speed_mph,
      event.final_speed_mph,
      event.target_deceleration_g,
    ),
    front_dynamic_load_n: frontLoad,
    rear_dynamic_load_n: rearLoad,
    front_aero_downforce_n: frontAero,
    rear_aero_downforce_n: rearAero,
    ideal_front_bias: frontLoad / (frontLoad + rearLoad),
    actual_front_torque_distribution: frontTorqueDistribution,
    actual_rear_torque_distribution: rearTorqueDistribution,
    total_brake_torque_nm: frontAxleTorque + rearAxleTorque,
    front_axle_torque_nm: frontAxleTorque,
    rear_axle_torque_nm: rearAxleTorque,
    front_rotor_torque_nm: frontAxleTorque / 2.0,
    rear_rotor_torque_nm: rearAxleTorque / 2.0,
    front_rotor_delta_t_c: frontDeltaT,
    rear_rotor_delta_t_c: rearDeltaT,
    effective_radius_method: effectiveRadiusMethod,
    ambient_temperature_c: ambientTemperatureC,
    front_rotor_peak_temperature_c: frontPeakC,
    rear_rotor_peak_temperature_c: rearPeakC,
    front_pad_mu_at_temperature: frontMuT,
    rear_pad_mu_at_temperature: rearMuT,
    front_pad_over_temperature_limit: frontOver,
    rear_pad_over_temperature_limit: rearOver,
  };
}

export function runSpeedDriverSweep(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  driverSweep: DriverMassSweep,
  speedsMph: number[],
  targetDecelerationG: number,
  aeroMap: AeroMap | null = null,
  rotorMaterials: Record<string, RotorMaterial> | null = null,
  effectiveRadiusMethod: string = "uniform_pressure",
  ambientTemperatureC = 25.0,
): StraightLineResult[] {
  const rows: StraightLineResult[] = [];
  for (const driverMass of driverMassesKg(driverSweep)) {
    for (const speedMph of speedsMph) {
      const result = analyzeEvent(
        vehicle,
        brakes,
        Number(driverMass),
        { initial_speed_mph: speedMph, final_speed_mph: 0.0, target_deceleration_g: targetDecelerationG },
        aeroMap,
        rotorMaterials,
        effectiveRadiusMethod,
        ambientTemperatureC,
      );
      rows.push(result);
    }
  }
  return rows;
}

export function runParameterizedSweep(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  driverMasses: number[],
  speedsMph: number[],
  decelerationsG: number[],
  aeroMap: AeroMap | null = null,
  rotorMaterials: Record<string, RotorMaterial> | null = null,
  effectiveRadiusMethod: string = "uniform_pressure",
  ambientTemperatureC = 25.0,
): StraightLineResult[] {
  const rows: StraightLineResult[] = [];
  for (const driverMass of driverMasses) {
    for (const speedMph of speedsMph) {
      for (const decelerationG of decelerationsG) {
        const result = analyzeEvent(
          vehicle,
          brakes,
          Number(driverMass),
          {
            initial_speed_mph: Number(speedMph),
            final_speed_mph: 0.0,
            target_deceleration_g: Number(decelerationG),
          },
          aeroMap,
          rotorMaterials,
          effectiveRadiusMethod,
          ambientTemperatureC,
        );
        rows.push(result);
      }
    }
  }
  return rows;
}
