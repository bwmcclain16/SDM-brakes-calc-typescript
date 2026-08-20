/** Raised when a required engineering input is unresolved.
 *
 * Mirrors `sdm_brakes.exceptions.NeedsInputError`. Kept as a thrown error
 * rather than a Result type so call sites stay 1:1 with the validated Python
 * and the golden-fixture harness can compare raise-for-raise. */
export class NeedsInputError extends Error {
  readonly fieldName: string;
  constructor(fieldName: string) {
    super(`NEEDS INPUT: ${fieldName}`);
    this.name = "NeedsInputError";
    this.fieldName = fieldName;
  }
}

/** Raised when a pad temperature exceeds the characterized friction band.
 *
 * The mu(T) curves cover a finite range; above it the model refuses to invent
 * a value rather than silently extrapolating. This is a design pass/fail
 * signal, not a nuisance error. */
export class PadTemperatureLimitExceeded extends Error {
  readonly temperatureC: number;
  readonly limitC: number;
  readonly padName: string | null;
  constructor(temperatureC: number, limitC: number, padName: string | null = null) {
    const pad = padName ? ` for pad '${padName}'` : "";
    super(
      `PAD TEMPERATURE LIMIT EXCEEDED${pad}: ${temperatureC.toFixed(1)} C is above the ` +
        `characterized friction band upper bound of ${limitC.toFixed(1)} C.`,
    );
    this.name = "PadTemperatureLimitExceeded";
    this.temperatureC = temperatureC;
    this.limitC = limitC;
    this.padName = padName;
  }
}
