import { G } from "../constants.ts";
import type { BrakeHardware, Vehicle } from "../models/internal.ts";
import type { CombinedBrakingCase, CombinedBrakingRow } from "./combinedBraking.ts";
import { evaluateCombinedBraking } from "./combinedBraking.ts";
import { dynamicAxleLoadsN } from "./vehicle.ts";

/**
 * Quasi-static corner-entry profile (spec 27.3).
 *
 * Arrays must share one length; `time_s` strictly increasing. Longitudinal
 * acceleration is positive in braking; lateral acceleration sign sets turn
 * direction (positive = left turn in this model's convention, loading the
 * left-side wheels). Speed is integrated forward from `entry_speed_mps`
 * and floored at zero -- the spec's brake-pressure/throttle/engine-braking
 * channels are Phase 7 inputs and are intentionally absent here.
 */
export interface TrailBrakingProfile {
  time_s: number[];
  longitudinal_accel_g: number[];
  lateral_accel_g: number[];
  entry_speed_mps: number;
  steering_angle_deg?: number[] | null;
}

/** Mirrors `TrailBrakingProfile.__post_init__`. */
export function validateTrailBrakingProfile(profile: TrailBrakingProfile): void {
  const n = profile.time_s.length;
  if (profile.longitudinal_accel_g.length !== n || profile.lateral_accel_g.length !== n) {
    throw new Error("trail-braking profile arrays must share one length");
  }
  if (profile.steering_angle_deg != null && profile.steering_angle_deg.length !== n) {
    throw new Error("steering profile length must match time array");
  }
  for (let i = 1; i < n; i++) {
    if (profile.time_s[i]! <= profile.time_s[i - 1]!) {
      throw new Error("time_s must be strictly increasing");
    }
  }
}

/** np.linspace(start, stop, num) — endpoint inclusive. */
function linspace(start: number, stop: number, num: number): number[] {
  if (num <= 0) return [];
  if (num === 1) return [start];
  const step = (stop - start) / (num - 1);
  return Array.from({ length: num }, (_, i) => (i === num - 1 ? stop : i * step + start));
}

/** Canonical corner-entry shape: brake released linearly while lateral
 * acceleration (and steering) build linearly toward the apex. */
export function makeLinearTrailProfile(
  entrySpeedMps: number,
  durationS: number,
  peakLongitudinalG: number,
  peakLateralG: number,
  points = 25,
  peakSteeringAngleDeg = 0.0,
): TrailBrakingProfile {
  const fractions = linspace(0.0, 1.0, points);
  const profile: TrailBrakingProfile = {
    time_s: fractions.map((f) => f * durationS),
    longitudinal_accel_g: fractions.map((f) => peakLongitudinalG * (1.0 - f)),
    lateral_accel_g: fractions.map((f) => peakLateralG * f),
    entry_speed_mps: entrySpeedMps,
    steering_angle_deg: fractions.map((f) => peakSteeringAngleDeg * f),
  };
  validateTrailBrakingProfile(profile);
  return profile;
}

/** Forward-Euler speed trace from the longitudinal profile, floored at 0. */
export function integrateSpeedMps(profile: TrailBrakingProfile): number[] {
  const time = profile.time_s;
  const ax = profile.longitudinal_accel_g.map((a) => a * G);
  const speed = new Array<number>(time.length);
  speed[0] = profile.entry_speed_mps;
  for (let i = 1; i < time.length; i++) {
    const dt = time[i]! - time[i - 1]!;
    speed[i] = Math.max(speed[i - 1]! - ax[i - 1]! * dt, 0.0);
  }
  return speed;
}

export interface TrailBrakingSummary {
  inside_rear_wheel: string;
  min_inside_rear_lock_margin_n: number;
  any_wheel_locks: boolean;
  first_lock_time_s: number | null;
  first_lock_wheel: string | null;
  peak_combined_utilization: number;
  wheel_energy_j: Record<string, number>;
  recommended_front_brake_fraction: number;
  stable: boolean;
}

export interface TrailBrakingHistoryRow extends CombinedBrakingRow {
  time_s: number;
  speed_mps: number;
  longitudinal_accel_g: number;
  lateral_accel_g: number;
  brake_power_w: number;
}

/** np.trapezoid(y, x): trapezoidal rule over possibly-nonuniform x. */
function trapezoid(y: number[], x: number[]): number {
  let total = 0;
  for (let i = 0; i < y.length - 1; i++) {
    total += ((x[i + 1]! - x[i]!) * (y[i]! + y[i + 1]!)) / 2.0;
  }
  return total;
}

/** np.average(values, weights=weights). */
function weightedAverage(values: number[], weights: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i]! * weights[i]!;
    den += weights[i]!;
  }
  return num / den;
}

/**
 * Time-resolved quasi-static trail-braking sweep (spec 27.3).
 *
 * Each sample is an independent quasi-static combined-braking solution at
 * that instant's (ax, ay, steering); no transient load-transfer dynamics.
 * Returns the long-format per-wheel time history and a summary with the
 * spec's headline outputs: inside-rear lock margin, stability flags,
 * wheel-by-wheel friction energy, and a bias recommendation (the
 * deceleration-weighted mean of the instantaneous ideal front fraction over
 * the braking phase -- a target for bias-bar setting, not an optimizer).
 */
export function evaluateTrailBraking(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  baseCase: CombinedBrakingCase,
  profile: TrailBrakingProfile,
): [TrailBrakingHistoryRow[], TrailBrakingSummary] {
  const time = profile.time_s;
  const speed = integrateSpeedMps(profile);
  const steering = profile.steering_angle_deg != null ? profile.steering_angle_deg : time.map(() => 0.0);

  const history: TrailBrakingHistoryRow[] = [];
  const idealFractions: number[] = [];
  const weights: number[] = [];

  for (let i = 0; i < time.length; i++) {
    const t = time[i]!;
    const axG = profile.longitudinal_accel_g[i]!;
    const ayG = profile.lateral_accel_g[i]!;
    const stepCase: CombinedBrakingCase = {
      ...baseCase,
      longitudinal_accel_g: axG,
      lateral_accel_g: ayG,
      steering_angle_deg: steering[i]!,
    };
    const frame = evaluateCombinedBraking(vehicle, brakes, stepCase);
    // Friction power each wheel's brake absorbs at this instant.
    for (const row of frame) {
      history.push({
        time_s: t,
        speed_mps: speed[i]!,
        longitudinal_accel_g: axG,
        lateral_accel_g: ayG,
        ...row,
        brake_power_w: row.fx_brake_demand_n * speed[i]!,
      });
    }

    if (axG > 0.0) {
      const [frontN, rearN] = dynamicAxleLoadsN(vehicle, baseCase.driver_mass_kg, axG);
      idealFractions.push(frontN / (frontN + rearN));
      weights.push(axG);
    }
  }

  // Trapezoidal per-wheel energy over the event.
  const wheelEnergy: Record<string, number> = {};
  for (const wheel of ["FL", "FR", "RL", "RR"]) {
    const group = history.filter((r) => r.wheel === wheel);
    wheelEnergy[wheel] = trapezoid(
      group.map((r) => r.brake_power_w),
      group.map((r) => r.time_s),
    );
  }

  // Inside = unloaded side: positive ay loads the left wheels here, so the
  // inside rear is RR for a left turn, RL for a right turn. Direction is
  // taken from the sign of the peak-lateral sample.
  let peakIdx = 0;
  let peakAbs = Math.abs(profile.lateral_accel_g[0]!);
  for (let i = 1; i < profile.lateral_accel_g.length; i++) {
    const v = Math.abs(profile.lateral_accel_g[i]!);
    if (v > peakAbs) {
      peakAbs = v;
      peakIdx = i;
    }
  }
  const peakAy = profile.lateral_accel_g[peakIdx]!;
  const insideRear = peakAy >= 0.0 ? "RR" : "RL";
  const insideRows = history.filter((r) => r.wheel === insideRear);

  const locked = history.filter((r) => r.locks_predicted);
  let firstLockTime: number | null = null;
  let firstLockWheel: string | null = null;
  if (locked.length > 0) {
    let minRow = locked[0]!;
    for (const r of locked) {
      if (r.time_s < minRow.time_s) minRow = r;
    }
    firstLockTime = minRow.time_s;
    firstLockWheel = minRow.wheel;
  }

  const summary: TrailBrakingSummary = {
    inside_rear_wheel: insideRear,
    min_inside_rear_lock_margin_n: Math.min(...insideRows.map((r) => r.lock_margin_n)),
    any_wheel_locks: history.some((r) => r.locks_predicted),
    first_lock_time_s: firstLockTime,
    first_lock_wheel: firstLockWheel,
    peak_combined_utilization: Math.max(...history.map((r) => r.combined_utilization)),
    wheel_energy_j: wheelEnergy,
    recommended_front_brake_fraction:
      idealFractions.length > 0 ? weightedAverage(idealFractions, weights) : NaN,
    // A rear lock during corner entry is a spin risk; that's the stability
    // flag this low-order model can responsibly raise.
    stable: !history.some((r) => r.wheel.startsWith("R") && r.locks_predicted),
  };
  return [history, summary];
}
