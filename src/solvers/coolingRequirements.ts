/** Required cooling conductance and airflow (spec sections 20.6-20.7).
 *
 * Given the energy and duration of a representative event and an allowable
 * rotor temperature, estimate the convective conductance (hA), convection
 * coefficient (h), and cooling airflow needed to hold steady state. These are
 * sizing targets for the cooling-duct design, handed to the aero team for duct
 * shaping.
 */
import { NeedsInputError } from "../errors.ts";
import type { CoolingParameters } from "../models/internal.ts";

export function averageHeatInputW(eventEnergyJ: number, eventDurationS: number): number {
  if (eventDurationS <= 0.0) throw new NeedsInputError("event_duration_s (> 0)");
  return eventEnergyJ / eventDurationS;
}

/** `(hA)_required = Q_dot_avg / (T_allow - T_inf)` (spec 20.6). */
export function requiredConductanceWK(
  averageHeatInputWValue: number,
  allowableRotorTemperatureC: number,
  ambientTemperatureC: number,
): number {
  const delta = allowableRotorTemperatureC - ambientTemperatureC;
  if (delta <= 0.0) throw new NeedsInputError("allowable_rotor_temperature_c > ambient_temperature_c");
  return averageHeatInputWValue / delta;
}

export function requiredConvectionCoefficientWM2k(
  requiredConductanceWKValue: number,
  convectiveAreaM2: number,
): number {
  if (convectiveAreaM2 <= 0.0) throw new NeedsInputError("convective_area_m2 (> 0)");
  return requiredConductanceWKValue / convectiveAreaM2;
}

/** `m_dot = Q / (c_p_air * dT_air)` (spec 20.7). */
export function requiredAirMassFlowKgS(
  heatW: number,
  airSpecificHeatJKgk: number,
  airDeltaTC: number,
): number {
  if (airDeltaTC <= 0.0) throw new NeedsInputError("cooling_air_delta_t_c (> 0)");
  return heatW / (airSpecificHeatJKgk * airDeltaTC);
}

export function requiredAirVolumeFlowM3S(massFlowKgS: number, airDensityKgM3: number): number {
  if (airDensityKgM3 <= 0.0) throw new NeedsInputError("air_density_kg_m3 (> 0)");
  return massFlowKgS / airDensityKgM3;
}

export interface CoolingRequirement {
  average_heat_input_w: number;
  required_conductance_w_k: number;
  required_convection_coefficient_w_m2k: number;
  required_air_mass_flow_kg_s: number;
  required_air_volume_flow_m3_s: number;
}

export function coolingRequirement(
  eventEnergyJ: number,
  eventDurationS: number,
  convectiveAreaM2: number,
  cooling: CoolingParameters,
): CoolingRequirement {
  const qAvg = averageHeatInputW(eventEnergyJ, eventDurationS);
  const ha = requiredConductanceWK(qAvg, cooling.allowable_rotor_temperature_c, cooling.ambient_temperature_c);
  const h = requiredConvectionCoefficientWM2k(ha, convectiveAreaM2);
  const mdot = requiredAirMassFlowKgS(
    qAvg,
    cooling.air_specific_heat_j_kgk ?? 1005.0,
    cooling.cooling_air_delta_t_c ?? 30.0,
  );
  const vdot = requiredAirVolumeFlowM3S(mdot, cooling.air_density_kg_m3 ?? 1.16);
  return {
    average_heat_input_w: qAvg,
    required_conductance_w_k: ha,
    required_convection_coefficient_w_m2k: h,
    required_air_mass_flow_kg_s: mdot,
    required_air_volume_flow_m3_s: vdot,
  };
}
