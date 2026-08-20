import { NeedsInputError } from "../errors.ts";

export function lumpedTemperatureRiseC(
  energyJ: number,
  rotorMassKg: number | null,
  specificHeatJKgk: number | null,
): number {
  if (rotorMassKg === null) throw new NeedsInputError("rotor_mass_kg");
  if (specificHeatJKgk === null) throw new NeedsInputError("specific_heat_j_kgk");
  return energyJ / (rotorMassKg * specificHeatJKgk);
}
