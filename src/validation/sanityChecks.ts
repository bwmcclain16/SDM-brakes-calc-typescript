/** Port of `sdm_brakes.validation.sanity_checks`. */

/** Mirrors the frozen `CheckResult` dataclass. `value`/`expected` stay
 * `number | string` because some checks compare labels, not just magnitudes. */
export interface CheckResult {
  name: string;
  passed: boolean;
  value: number | string;
  expected: number | string;
  tolerance: number | null;
}

/** Port of `within_tolerance`: passes when `|value - expected| <= tolerance`. */
export function withinTolerance(
  name: string,
  value: number,
  expected: number,
  tolerance: number,
): CheckResult {
  return {
    name,
    passed: Math.abs(value - expected) <= tolerance,
    value,
    expected,
    tolerance,
  };
}
