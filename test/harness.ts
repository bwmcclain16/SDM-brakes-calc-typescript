/** Golden-fixture harness.
 *
 * `tools/extract_fixtures.py` records every call the 304-test Python suite makes
 * into `ts/fixtures/*.json` -- real inputs, real outputs, including the 24-25
 * workbook regression anchors. This runs the TypeScript port against those exact
 * records. A port that drifts numerically fails here rather than in someone's
 * brake-temperature prediction. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "..", "fixtures");

export type Case = { args: unknown[]; kwargs: Record<string, unknown>; result: unknown; ok: boolean };
export type Param = { name: string; hasDefault: boolean; default?: unknown };
export type FixtureFile = {
  module: string;
  functions: Record<string, Case[]>;
  signatures?: Record<string, Param[]>;
};

/** Reverse of the Python encoder. */
export function decode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const o = value as Record<string, unknown>;
  if ("__float__" in o) {
    const t = o["__float__"];
    return t === "nan" ? NaN : t === "inf" ? Infinity : -Infinity;
  }
  if ("__ndarray__" in o) {
    const shape = o["shape"] as number[];
    const flat = (o["data"] as unknown[]).map(decode) as number[];
    if (shape.length <= 1) return flat;
    const [rows, cols] = [shape[0]!, shape[1]!];
    return Array.from({ length: rows }, (_, i) => flat.slice(i * cols, (i + 1) * cols));
  }
  if ("__dataframe__" in o) return (o["records"] as unknown[]).map(decode);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "__dataclass__" || k === "__series__") continue;
    out[k] = decode(v);
  }
  return out;
}

export type Mismatch = { path: string; expected: unknown; actual: unknown };

/** Deep numeric comparison. Relative tolerance on floats; NaN equals NaN. */
export function compare(expected: unknown, actual: unknown, relTol = 1e-12, path = ""): Mismatch[] {
  const bad = (): Mismatch[] => [{ path: path || "<root>", expected, actual }];
  if (typeof expected === "number") {
    if (typeof actual !== "number") return bad();
    if (Number.isNaN(expected)) return Number.isNaN(actual) ? [] : bad();
    if (!Number.isFinite(expected)) return expected === actual ? [] : bad();
    const scale = Math.max(Math.abs(expected), Math.abs(actual), 1e-30);
    return Math.abs(expected - actual) <= relTol * scale ? [] : bad();
  }
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual) ? [] : bad();
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return bad();
    return expected.flatMap((e, i) => compare(e, actual[i], relTol, `${path}[${i}]`));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return bad();
  const a = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).flatMap(([k, v]) =>
    k in a ? compare(v, a[k], relTol, path ? `${path}.${k}` : k) : bad(),
  );
}

/** Bind a recorded call to a positional argument list.
 *
 * Python allows `f(a, line_compliance=x)` while leaving an EARLIER optional
 * parameter at its default. Appending `Object.values(kwargs)` after the
 * positional args lands `x` in the wrong slot -- silently, and with a plausible
 * number. So keywords are placed by NAME using the recorded parameter order,
 * and any gap below the highest supplied index is filled with Python's own
 * recorded default. */
export function bindArgs(c: Case, params: Param[] | undefined): unknown[] {
  const args = c.args.map(decode);
  const kwNames = Object.keys(c.kwargs);
  if (!kwNames.length) return args;
  if (!params) return [...args, ...Object.values(c.kwargs).map(decode)];

  const slots: unknown[] = [...args];
  const filled = new Set<number>(args.map((_, i) => i));
  for (const [name, raw] of Object.entries(c.kwargs)) {
    const idx = params.findIndex((p) => p.name === name);
    if (idx < 0) throw new Error(`kwarg "${name}" not in recorded signature`);
    slots[idx] = decode(raw);
    filled.add(idx);
  }
  const highest = Math.max(...filled);
  for (let i = 0; i <= highest; i++) {
    if (filled.has(i)) continue;
    const p = params[i];
    if (!p?.hasDefault) throw new Error(`no recorded default for parameter ${i} ("${p?.name}")`);
    slots[i] = decode(p.default);
  }
  return slots.slice(0, highest + 1);
}

/** `front_axle_torque_distribution` -> `frontAxleTorqueDistribution`.
 *  `PadFrictionModel.mu_at` -> `muAt` (methods become free functions). */
export function tsName(pythonName: string): string {
  const bare = pythonName.includes(".") ? pythonName.split(".").pop()! : pythonName;
  return bare.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function loadFixture(file: string): FixtureFile {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as FixtureFile;
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
}

export type Impl = (...a: never[]) => unknown;

export type RunReport = { checked: number; skipped: string[]; failures: string[] };

/** Run every recorded case for `file` against the module's exports.
 *  Functions with no matching export are reported as skipped, not silently passed. */
export function runFixture(
  file: string,
  moduleExports: Record<string, unknown>,
  relTol = 1e-12,
): RunReport {
  const fixture = loadFixture(file);
  const report: RunReport = { checked: 0, skipped: [], failures: [] };

  for (const [pyName, cases] of Object.entries(fixture.functions)) {
    const impl = moduleExports[tsName(pyName)] as Impl | undefined;
    if (typeof impl !== "function") {
      if (cases.length) report.skipped.push(`${pyName} (${cases.length} cases, no export "${tsName(pyName)}")`);
      continue;
    }
    const params = fixture.signatures?.[pyName];
    for (const [i, c] of cases.entries()) {
      const where = `${pyName}[${i}]`;
      let callArgs: unknown[];
      try {
        callArgs = bindArgs(c, params);
      } catch (e) {
        report.failures.push(`${where}: ${(e as Error).message}`);
        continue;
      }
      if (!c.ok) {
        const expectedError = (c.result as Record<string, string>)["__raises__"]!;
        try {
          (impl as (...a: unknown[]) => unknown)(...callArgs);
          report.failures.push(`${where}: expected throw ${expectedError}, returned normally`);
        } catch (e) {
          const got = (e as Error).name;
          // Python's builtin ValueError/TypeError have no TS counterpart; a plain
          // Error is the faithful port, so accept it rather than forcing ported
          // code to fake a Python error name.
          const ok = got === expectedError ||
            (["ValueError", "TypeError", "ZeroDivisionError"].includes(expectedError) && got === "Error");
          if (!ok) report.failures.push(`${where}: expected ${expectedError}, threw ${got}`);
          else report.checked++;
        }
        continue;
      }
      let actual: unknown;
      try {
        actual = (impl as (...a: unknown[]) => unknown)(...callArgs);
      } catch (e) {
        report.failures.push(`${where}: threw ${(e as Error).name}: ${(e as Error).message}`);
        continue;
      }
      const diffs = compare(decode(c.result), actual, relTol);
      if (diffs.length) {
        const d = diffs[0]!;
        report.failures.push(
          `${where}: at ${d.path} expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}` +
            (diffs.length > 1 ? ` (+${diffs.length - 1} more)` : ""),
        );
      } else report.checked++;
    }
  }
  return report;
}
