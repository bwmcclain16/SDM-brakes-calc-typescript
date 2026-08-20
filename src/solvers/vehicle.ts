import { G } from "../constants.ts";
import type { DriverMassSweep, Vehicle } from "../models/internal.ts";
import { mphToMps } from "../units.ts";

export const totalMassKg = (vehicle: Vehicle, driverMassKg: number): number =>
  vehicle.mass_without_driver_kg + driverMassKg;

/** np.linspace(min, max, points) — endpoint inclusive. */
export function driverMassesKg(sweep: DriverMassSweep): number[] {
  const n = sweep.points;
  if (n <= 0) return [];
  if (n === 1) return [sweep.min_kg];
  const step = (sweep.max_kg - sweep.min_kg) / (n - 1);
  // Last point set explicitly: linspace guarantees the endpoint exactly,
  // accumulating min + i*step does not.
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? sweep.max_kg : sweep.min_kg + i * step,
  );
}

export function kineticEnergyJ(massKg: number, speedMph: number): number {
  const speedMps = mphToMps(speedMph);
  return 0.5 * massKg * speedMps ** 2;
}

export function stoppingDistanceM(
  initialSpeedMph: number,
  finalSpeedMph: number,
  decelerationG: number,
): number {
  const v0 = mphToMps(initialSpeedMph);
  const v1 = mphToMps(finalSpeedMph);
  return (v0 ** 2 - v1 ** 2) / (2.0 * decelerationG * G);
}

export function brakingDurationS(
  initialSpeedMph: number,
  finalSpeedMph: number,
  decelerationG: number,
): number {
  return (mphToMps(initialSpeedMph) - mphToMps(finalSpeedMph)) / (decelerationG * G);
}

/** [front, rear] newtons. */
export function staticAxleLoadsN(vehicle: Vehicle, driverMassKg: number): [number, number] {
  const totalWeightN = totalMassKg(vehicle, driverMassKg) * G;
  const front = totalWeightN * vehicle.static_front_weight_fraction;
  return [front, totalWeightN - front];
}

export const longitudinalLoadTransferN = (
  vehicle: Vehicle,
  driverMassKg: number,
  decelerationG: number,
): number =>
  (totalMassKg(vehicle, driverMassKg) * decelerationG * G * vehicle.cg_height_m) /
  vehicle.wheelbase_m;

export function dynamicAxleLoadsN(
  vehicle: Vehicle,
  driverMassKg: number,
  decelerationG: number,
  frontAeroDownforceN = 0.0,
  rearAeroDownforceN = 0.0,
): [number, number] {
  const [frontStatic, rearStatic] = staticAxleLoadsN(vehicle, driverMassKg);
  const transfer = longitudinalLoadTransferN(vehicle, driverMassKg, decelerationG);
  return [frontStatic + transfer + frontAeroDownforceN, rearStatic - transfer + rearAeroDownforceN];
}

export const idealFrontBrakeFraction = (vehicle: Vehicle, decelerationG: number): number =>
  vehicle.static_front_weight_fraction +
  (decelerationG * vehicle.cg_height_m) / vehicle.wheelbase_m;

export function idealFrontBrakeFractionWithAero(
  vehicle: Vehicle,
  driverMassKg: number,
  decelerationG: number,
  frontAeroDownforceN: number,
  rearAeroDownforceN: number,
): number {
  const [frontLoad, rearLoad] = dynamicAxleLoadsN(
    vehicle, driverMassKg, decelerationG, frontAeroDownforceN, rearAeroDownforceN,
  );
  return frontLoad / (frontLoad + rearLoad);
}
