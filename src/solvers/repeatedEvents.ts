/** Repeated-event (autocross) lumped rotor thermal model (spec section 20.8).
 *
 * Each braking event dumps its assigned energy into the rotor instantaneously
 * (conservative lumped heating, spec 20.1); between events the rotor cools by
 * convection + radiation over the inter-event gap. The simulation runs until the
 * per-event peak temperature reaches *cyclic convergence* rather than a preset
 * event count.
 *
 * All temperatures are degrees Celsius at the API boundary; radiation is computed
 * in Kelvin internally.
 */
import { STEFAN_BOLTZMANN, ZERO_CELSIUS_K } from "../constants.ts";
import type { CoolingParameters } from "../models/internal.ts";

/** `dT/dt` from convection + radiation losses (negative when T > ambient). */
export function coolingRateCPerS(
  temperatureC: number,
  cooling: CoolingParameters,
  convectiveAreaM2: number,
  radiationAreaM2: number,
  thermalCapacityJK: number,
): number {
  const tInfC = cooling.ambient_temperature_c;
  const qConv = cooling.convection_coefficient_w_m2k * convectiveAreaM2 * (temperatureC - tInfC);
  const tK = temperatureC + ZERO_CELSIUS_K;
  const tInfK = tInfC + ZERO_CELSIUS_K;
  const qRad = cooling.emissivity * STEFAN_BOLTZMANN * radiationAreaM2 * (tK ** 4 - tInfK ** 4);
  return -(qConv + qRad) / thermalCapacityJK;
}

/** Integrate Newton+radiation cooling over `gap_s` (RK4), return end temp. */
export function coolOverGapC(
  startTemperatureC: number,
  gapS: number,
  cooling: CoolingParameters,
  convectiveAreaM2: number,
  radiationAreaM2: number,
  thermalCapacityJK: number,
  steps = 200,
): number {
  if (gapS <= 0.0) return startTemperatureC;
  const dt = gapS / steps;
  let temperature = startTemperatureC;

  const rate = (tC: number): number =>
    coolingRateCPerS(tC, cooling, convectiveAreaM2, radiationAreaM2, thermalCapacityJK);

  for (let i = 0; i < steps; i++) {
    const k1 = rate(temperature);
    const k2 = rate(temperature + 0.5 * dt * k1);
    const k3 = rate(temperature + 0.5 * dt * k2);
    const k4 = rate(temperature + dt * k3);
    temperature += (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
  }
  return temperature;
}

export interface RepeatedEventResult {
  converged: boolean;
  events_to_convergence: number | null;
  cyclic_peak_temperature_c: number;
  cyclic_min_temperature_c: number;
  cyclic_average_temperature_c: number;
  limit_exceeded: boolean;
  limit_exceeded_before_convergence: boolean;
  peak_temperatures_c: number[];
}

/** Simulate the event train to cyclic convergence (spec 20.8).
 *
 * Convergence: `|T_peak[n]-T_peak[n-1]| < convergence_tol_c` AND the same
 * difference divided by `max(T_peak[n]-T_ambient, eps)` `< relative_tol`,
 * for `consecutive_required` consecutive events.
 */
export function simulateRepeatedEvents(
  energyPerEventJ: number,
  gapS: number,
  cooling: CoolingParameters,
  convectiveAreaM2: number,
  radiationAreaM2: number,
  thermalCapacityJK: number,
  initialTemperatureC: number | null = null,
  maxEvents = 5000,
  convergenceTolC = 2.0,
  relativeTol = 0.01,
  consecutiveRequired = 3,
): RepeatedEventResult {
  const tInf = cooling.ambient_temperature_c;
  let temperature = initialTemperatureC === null ? tInf : initialTemperatureC;
  const deltaTEvent = energyPerEventJ / thermalCapacityJK;

  const peaks: number[] = [];
  const troughs: number[] = [];
  let consecutive = 0;
  let eventsToConvergence: number | null = null;
  let limitExceededBeforeConvergence = false;
  const allow = cooling.allowable_rotor_temperature_c;

  for (let eventIndex = 1; eventIndex <= maxEvents; eventIndex++) {
    temperature += deltaTEvent; // instantaneous heating -> peak
    peaks.push(temperature);
    if (temperature > allow && eventsToConvergence === null) {
      limitExceededBeforeConvergence = true;
    }
    temperature = coolOverGapC(
      temperature, gapS, cooling, convectiveAreaM2, radiationAreaM2, thermalCapacityJK,
    );
    troughs.push(temperature);

    if (peaks.length >= 2) {
      const diff = Math.abs(peaks[peaks.length - 1]! - peaks[peaks.length - 2]!);
      const rel = diff / Math.max(peaks[peaks.length - 1]! - tInf, 1e-9);
      if (diff < convergenceTolC && rel < relativeTol) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }
      if (consecutive >= consecutiveRequired) {
        eventsToConvergence = eventIndex;
        break;
      }
    }
  }

  const converged = eventsToConvergence !== null;
  const cyclicPeak = peaks[peaks.length - 1]!;
  const cyclicMin = troughs[troughs.length - 1]!;
  return {
    converged,
    events_to_convergence: eventsToConvergence,
    cyclic_peak_temperature_c: cyclicPeak,
    cyclic_min_temperature_c: cyclicMin,
    cyclic_average_temperature_c: 0.5 * (cyclicPeak + cyclicMin),
    limit_exceeded: cyclicPeak > allow,
    limit_exceeded_before_convergence: limitExceededBeforeConvergence,
    peak_temperatures_c: peaks,
  };
}
