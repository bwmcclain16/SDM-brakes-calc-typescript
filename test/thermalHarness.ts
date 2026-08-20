/** Differential-digest comparator for `thermal_fdm`'s field-valued results.
 *
 * The scalar golden-fixture harness (`./harness.ts`) does whole-value deep
 * comparison, which does not work here: this solver's returned temperature
 * fields are tens of thousands of floats per call.
 * `tools/extract_thermal_fixtures.py` records a differential digest instead --
 * shape/min/max/mean/sum/nonFinite per snapshot, plus the full FINAL 2-D
 * field -- into `ts/fixtures/thermal.annulus.json`. This module reproduces
 * that digest over the ported TypeScript `FieldSnapshot[]` stacks and
 * compares against the recorded digest, so a port that drifts anywhere in
 * the time integration fails here even when its final state happens to look
 * right.
 */
import type { Mismatch } from "./harness.ts";
import type { FieldSnapshot } from "../src/solvers/thermalFdm.ts";

export interface FieldDigest {
  shape: number[];
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
  nonFinite: number;
}

/** Digest of a SINGLE 2-D field (matches Python's per-snapshot `digest(s)`). */
export function digestField(fs: FieldSnapshot): FieldDigest {
  const data = fs.data;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0.0;
  let nonFinite = 0;
  let finiteCount = 0;
  for (let idx = 0; idx < data.length; idx++) {
    const v = data[idx]!;
    if (!Number.isFinite(v)) {
      nonFinite++;
      continue;
    }
    finiteCount++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    shape: [fs.nAxial, fs.nRadial],
    min: finiteCount ? min : null,
    max: finiteCount ? max : null,
    mean: finiteCount ? sum / finiteCount : null,
    sum: finiteCount ? sum : null,
    nonFinite,
  };
}

/** Digest over the WHOLE stack of snapshots (matches Python's `digest(v)` on
 * the full (snapshots, axial, radial) array). */
export function digestFieldStack(stack: FieldSnapshot[]): FieldDigest {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0.0;
  let nonFinite = 0;
  let finiteCount = 0;
  for (const fs of stack) {
    const data = fs.data;
    for (let idx = 0; idx < data.length; idx++) {
      const v = data[idx]!;
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      finiteCount++;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  const first = stack[0];
  return {
    shape: [stack.length, first?.nAxial ?? 0, first?.nRadial ?? 0],
    min: finiteCount ? min : null,
    max: finiteCount ? max : null,
    mean: finiteCount ? sum / finiteCount : null,
    sum: finiteCount ? sum : null,
    nonFinite,
  };
}

function numClose(e: number | null, a: number | null, relTol: number): boolean {
  if (e === null || a === null) return e === a;
  const scale = Math.max(Math.abs(e), Math.abs(a), 1e-30);
  return Math.abs(e - a) <= relTol * scale;
}

export function compareDigest(
  expected: FieldDigest,
  actual: FieldDigest,
  relTol: number,
  path: string,
): Mismatch[] {
  if (
    expected.shape.length !== actual.shape.length ||
    expected.shape.some((s, i) => s !== actual.shape[i])
  ) {
    return [{ path: `${path}.shape`, expected: expected.shape, actual: actual.shape }];
  }
  const out: Mismatch[] = [];
  for (const key of ["min", "max", "mean", "sum"] as const) {
    if (!numClose(expected[key], actual[key], relTol)) {
      out.push({ path: `${path}.${key}`, expected: expected[key], actual: actual[key] });
    }
  }
  if (expected.nonFinite !== actual.nonFinite) {
    out.push({ path: `${path}.nonFinite`, expected: expected.nonFinite, actual: actual.nonFinite });
  }
  return out;
}

/** Element-by-element compare of the recorded FINAL 2-D field. */
export function compareFinalField(
  expected: number[][],
  actual: FieldSnapshot,
  relTol: number,
  path: string,
): Mismatch[] {
  if (expected.length !== actual.nAxial) {
    return [{ path: `${path}.shape[0]`, expected: expected.length, actual: actual.nAxial }];
  }
  const out: Mismatch[] = [];
  for (let j = 0; j < actual.nAxial; j++) {
    const row = expected[j]!;
    if (row.length !== actual.nRadial) {
      out.push({ path: `${path}[${j}].shape`, expected: row.length, actual: actual.nRadial });
      continue;
    }
    for (let i = 0; i < actual.nRadial; i++) {
      const e = row[i]!;
      const a = actual.data[j * actual.nRadial + i]!;
      const scale = Math.max(Math.abs(e), Math.abs(a), 1e-30);
      if (Math.abs(e - a) > relTol * scale) {
        out.push({ path: `${path}[${j}][${i}]`, expected: e, actual: a });
      }
    }
  }
  return out;
}

/** Per-snapshot digest drift check -- catches a port that's right at the end
 * but wrong mid-run. */
export function comparePerSnapshot(
  expected: FieldDigest[],
  actual: FieldSnapshot[],
  relTol: number,
  path: string,
): Mismatch[] {
  if (expected.length !== actual.length) {
    return [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
  }
  const out: Mismatch[] = [];
  for (let k = 0; k < expected.length; k++) {
    out.push(...compareDigest(expected[k]!, digestField(actual[k]!), relTol, `${path}[${k}]`));
  }
  return out;
}

/** `energy_balance_error_fraction` is a should-be-zero conservation residual:
 * `(stored + loss - in) / max(in, 1e-9)`, a near-total cancellation of terms
 * on the order of 1e4-1e5 J. Both the Python and TypeScript values land at
 * the double-precision noise floor (~1e-14..1e-16) purely from
 * differently-ordered floating-point summation -- comparing them to EACH
 * OTHER by relative tolerance is comparing two arbitrary rounding artifacts,
 * not a real quantity. Instead check that the actual value has the property
 * the fixture value also has: it is within `absTol` of exact conservation. */
export function nearZeroResidualOk(actual: number, absTol: number): boolean {
  return Math.abs(actual) <= absTol;
}

/** Format a Mismatch list the same way `runFixture` does. */
export function formatMismatches(prefix: string, diffs: Mismatch[]): string[] {
  if (!diffs.length) return [];
  const d = diffs[0]!;
  const msg =
    `${prefix} at ${d.path}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}` +
    (diffs.length > 1 ? ` (+${diffs.length - 1} more)` : "");
  return [msg];
}
