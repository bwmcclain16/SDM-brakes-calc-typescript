/** Temperature-dependent pad friction coefficient model (spec section 4.1.1).
 *
 * Brembo (and the comparison vendors) supply the pad coefficient of friction as a
 * function of rotor/pad interface temperature rather than a single scalar. This
 * module turns those digitized `(T, mu)` curves into a callable `mu(T)` lookup
 * used wherever a rotor temperature is known.
 *
 * Conventions (consistent with the rest of the package):
 * - Temperatures are degrees Celsius at the API boundary.
 * - Below the lowest characterized temperature the coefficient is held flat at the
 *   lowest-temperature value (per the team decision: "less than the low bound is
 *   assumed the same as the low bound"). Cold-pad bite below the operating band is
 *   not characterized by the vendor data, and holding flat is the conservative,
 *   non-fabricating choice.
 * - Above the highest characterized temperature the model throws
 *   `PadTemperatureLimitExceeded` rather than extrapolating an unknown fade
 *   curve -- this is a loud design pass/fail signal.
 */
import { NeedsInputError, PadTemperatureLimitExceeded } from "../errors.ts";

/** A digitized `mu` vs temperature curve for one pad compound.
 *
 * `temperatures_c` and `mu_values` are paired, strictly increasing in
 * temperature. `design_mu` is the conservative single-scalar value retained
 * for static checks that have no temperature context (brake bias, line-pressure
 * sizing). `name` is used in error messages. */
export interface PadFrictionModel {
  name: string;
  temperatures_c: number[];
  mu_values: number[];
  design_mu?: number | null;
}

/** Mirrors `PadFrictionModel.__post_init__`: validates the paired curve arrays. */
export function validatePadFrictionModel(model: PadFrictionModel): void {
  if (model.temperatures_c.length !== model.mu_values.length) {
    throw new NeedsInputError("pad_friction.mu_vs_temperature (T and mu length mismatch)");
  }
  if (model.temperatures_c.length < 2) {
    throw new NeedsInputError("pad_friction.mu_vs_temperature (>= 2 points)");
  }
  for (let i = 1; i < model.temperatures_c.length; i++) {
    if (model.temperatures_c[i]! <= model.temperatures_c[i - 1]!) {
      throw new NeedsInputError(
        "pad_friction.mu_vs_temperature (temperatures must strictly increase)",
      );
    }
  }
}

export const minCharacterizedTemperatureC = (model: PadFrictionModel): number =>
  model.temperatures_c[0]!;

export const maxCharacterizedTemperatureC = (model: PadFrictionModel): number =>
  model.temperatures_c[model.temperatures_c.length - 1]!;

/** Coefficient of friction at `temperatureC`.
 *
 * Linear interpolation between characterized points. Clamps flat below the
 * low bound; throws `PadTemperatureLimitExceeded` above the high bound. */
export function muAt(model: PadFrictionModel, temperatureC: number): number {
  const lo = model.temperatures_c[0]!;
  const hi = model.temperatures_c[model.temperatures_c.length - 1]!;
  if (temperatureC <= lo) return model.mu_values[0]!;
  if (temperatureC > hi) throw new PadTemperatureLimitExceeded(temperatureC, hi, model.name);
  // locate the bracketing interval
  for (let i = 1; i < model.temperatures_c.length; i++) {
    const tHi = model.temperatures_c[i]!;
    if (temperatureC <= tHi) {
      const tLo = model.temperatures_c[i - 1]!;
      const mLo = model.mu_values[i - 1]!;
      const mHi = model.mu_values[i]!;
      const frac = (temperatureC - tLo) / (tHi - tLo);
      return mLo + frac * (mHi - mLo);
    }
  }
  // unreachable: temperatureC <= hi guaranteed above
  return model.mu_values[model.mu_values.length - 1]!;
}

/** Builds a `PadFrictionModel` from unordered `(T, mu)` points, sorting by temperature. */
export function fromPoints(
  name: string,
  points: Array<[number, number]>,
  designMu: number | null = null,
): PadFrictionModel {
  const ordered = [...points].sort((a, b) => a[0] - b[0]);
  const model: PadFrictionModel = {
    name,
    temperatures_c: ordered.map(([t]) => t),
    mu_values: ordered.map(([, m]) => m),
    design_mu: designMu,
  };
  validatePadFrictionModel(model);
  return model;
}
