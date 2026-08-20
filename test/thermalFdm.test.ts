import test from "node:test";
import assert from "node:assert/strict";
import { compare, decode, loadFixture } from "./harness.ts";
import {
  compareDigest,
  compareFinalField,
  comparePerSnapshot,
  digestFieldStack,
  formatMismatches,
  nearZeroResidualOk,
} from "./thermalHarness.ts";
import {
  makeHeatPulse,
  makeRotorFdmModel,
  semiInfiniteSurfaceRiseC,
  simulateEventTrain,
  simulateSingleStop,
  solveSteadyBandTemperature,
  stableTimeStepS,
  type FieldSnapshot,
  type HeatPulse,
  type HeatPulseProfile,
} from "../src/solvers/thermalFdm.ts";
import type { CoolingParameters } from "../src/models/internal.ts";
import type { RotorGeometry, RotorMaterial } from "../src/models/rotors.ts";

const FIELD_TOL = 1e-12;
const SCALAR_TOL = 1e-12;

type ThermalFixture = {
  module: string;
  scenarios: Record<string, { inputs: Record<string, unknown>; result: Record<string, unknown> }>;
  scalars: Record<string, { cases: { args: number[]; value: unknown }[]; material: unknown }>;
};

const fixture = loadFixture("thermal.annulus.json") as unknown as ThermalFixture;

function buildGeometry(raw: unknown): RotorGeometry {
  return decode(raw) as RotorGeometry;
}
function buildCooling(raw: unknown): CoolingParameters {
  return decode(raw) as CoolingParameters;
}
function buildPulse(raw: unknown): HeatPulse {
  const p = decode(raw) as { energy_j: number; duration_s: number; profile?: HeatPulseProfile };
  return makeHeatPulse(p.energy_j, p.duration_s, p.profile ?? "linear");
}

/** Compare an actual solver result object against a recorded fixture result.
 * Scalars and 1-D arrays go through the scalar `compare()`; any value shaped
 * like `{__digest__, final?, perSnapshot?}` is a field-stack digest and goes
 * through the thermal-specific digest comparator instead. Keys present only
 * in `actual` (e.g. `final_field`, dropped from the fixture because it is a
 * nested dataclass) are simply never checked -- iteration is driven by the
 * fixture's own keys. */
function checkResultAgainstFixture(
  label: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] {
  const failures: string[] = [];
  for (const [key, evalue] of Object.entries(expected)) {
    if (
      evalue !== null &&
      typeof evalue === "object" &&
      !Array.isArray(evalue) &&
      "__digest__" in (evalue as Record<string, unknown>)
    ) {
      const wrapper = evalue as { __digest__: unknown; final?: number[][]; perSnapshot?: unknown };
      const stack = actual[key] as FieldSnapshot[];
      const path = `${label}.${key}`;
      failures.push(
        ...formatMismatches(
          path,
          compareDigest(wrapper.__digest__ as never, digestFieldStack(stack), FIELD_TOL, path),
        ),
      );
      if (wrapper.final !== undefined) {
        const finalSnap = stack[stack.length - 1]!;
        failures.push(
          ...formatMismatches(
            `${path}.final`,
            compareFinalField(wrapper.final, finalSnap, FIELD_TOL, `${path}.final`),
          ),
        );
      }
      if (wrapper.perSnapshot !== undefined) {
        failures.push(
          ...formatMismatches(
            `${path}.perSnapshot`,
            comparePerSnapshot(wrapper.perSnapshot as never, stack, FIELD_TOL, `${path}.perSnapshot`),
          ),
        );
      }
      continue;
    }
    if (key === "energy_balance_error_fraction") {
      // Should-be-zero conservation residual; see nearZeroResidualOk's doc
      // comment in thermalHarness.ts for why this isn't a relative compare().
      const a = actual[key] as number;
      const residualTol = 1e-9;
      if (!nearZeroResidualOk(a, residualTol)) {
        failures.push(
          `${label}.${key}: expected |value| <= ${residualTol} (reference ${String(decode(evalue))}), got ${a}`,
        );
      }
      continue;
    }
    const diffs = compare(decode(evalue), actual[key], SCALAR_TOL, key);
    failures.push(...formatMismatches(label, diffs));
  }
  return failures;
}

test("solvers/thermalFdm: annulus_adiabatic_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["annulus_adiabatic_single_stop"]!;
  const geometry = buildGeometry(inputs.geometry);
  const cooling = buildCooling(inputs.cooling);
  const model = makeRotorFdmModel(geometry, cooling, null, inputs.n_radial as number, inputs.n_axial as number);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkResultAgainstFixture(
    "annulus_adiabatic_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdm: annulus_baseline_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["annulus_baseline_single_stop"]!;
  const geometry = buildGeometry(inputs.geometry);
  const cooling = buildCooling(inputs.cooling);
  const model = makeRotorFdmModel(geometry, cooling, null, inputs.n_radial as number, inputs.n_axial as number);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkResultAgainstFixture(
    "annulus_baseline_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdm: annulus_event_train matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["annulus_event_train"]!;
  const geometry = buildGeometry(inputs.geometry);
  const cooling = buildCooling(inputs.cooling);
  const model = makeRotorFdmModel(geometry, cooling, null, inputs.n_radial as number, inputs.n_axial as number);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateEventTrain(model, pulse, inputs.gap_s as number);
  const failures = checkResultAgainstFixture(
    "annulus_event_train",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdm: annulus_steady_band_450c matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["annulus_steady_band_450c"]!;
  const geometry = buildGeometry(inputs.geometry);
  const cooling = buildCooling(inputs.cooling);
  const model = makeRotorFdmModel(geometry, cooling, null, inputs.n_radial as number, inputs.n_axial as number);
  const actual = solveSteadyBandTemperature(model, inputs.band_temperature_c as number);
  const failures = checkResultAgainstFixture(
    "annulus_steady_band_450c",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdm: stable_time_step_s matches the Python golden fixture", () => {
  const group = fixture.scalars["stable_time_step_s"]!;
  const material = decode(group.material) as RotorMaterial;
  const failures: string[] = [];
  group.cases.forEach((c, i) => {
    const [dr, dz, safety] = c.args as [number, number, number];
    const actual = stableTimeStepS(material, dr, dz, safety);
    failures.push(
      ...formatMismatches(
        `stable_time_step_s[${i}]`,
        compare(decode(c.value), actual, SCALAR_TOL, `stable_time_step_s[${i}]`),
      ),
    );
  });
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdm: semi_infinite_surface_rise_c matches the Python golden fixture", () => {
  const group = fixture.scalars["semi_infinite_surface_rise_c"]!;
  const material = decode(group.material) as RotorMaterial;
  const failures: string[] = [];
  group.cases.forEach((c, i) => {
    const [q, t] = c.args as [number, number];
    const actual = semiInfiniteSurfaceRiseC(q, material, t);
    failures.push(
      ...formatMismatches(
        `semi_infinite_surface_rise_c[${i}]`,
        compare(decode(c.value), actual, SCALAR_TOL, `semi_infinite_surface_rise_c[${i}]`),
      ),
    );
  });
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});
