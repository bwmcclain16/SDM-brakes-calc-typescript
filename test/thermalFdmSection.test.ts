import test from "node:test";
import assert from "node:assert/strict";
import { compare, decode, loadFixture } from "./harness.ts";
import {
  compareDigest,
  compareFinalField,
  comparePerSnapshot,
  digestField,
  digestFieldStack,
  formatMismatches,
  nearZeroResidualOk,
} from "./thermalHarness.ts";
import { makeHeatPulse, type FieldSnapshot, type HeatPulse, type HeatPulseProfile } from "../src/solvers/thermalFdm.ts";
import {
  makeHoleBand,
  makeSectionFdmModel,
  makeSweptBand,
  makeRotorSection,
  rectangularSection,
  simulateSectionEventTrain,
  simulateSectionSingleStop,
  solveSectionSteadyBandTemperature,
  type HoleBand,
  type SectionFdmModel,
} from "../src/solvers/thermalFdmSection.ts";
import type { CoolingParameters } from "../src/models/internal.ts";
import type { RotorMaterial } from "../src/models/rotors.ts";

const FIELD_TOL = 1e-12;
const SCALAR_TOL = 1e-12;

type SectionFixture = {
  module: string;
  scenarios: Record<string, { inputs: Record<string, unknown>; result: Record<string, unknown> }>;
};

const fixture = loadFixture("thermal.section.json") as unknown as SectionFixture;

function buildMaterial(raw: unknown): RotorMaterial {
  return decode(raw) as RotorMaterial;
}
function buildCooling(raw: unknown): CoolingParameters {
  return decode(raw) as CoolingParameters;
}
function buildPulse(raw: unknown): HeatPulse {
  const p = decode(raw) as { energy_j: number; duration_s: number; profile?: HeatPulseProfile };
  return makeHeatPulse(p.energy_j, p.duration_s, p.profile ?? "linear");
}

interface SectionInputs {
  outer_diameter_mm: number;
  inner_diameter_mm: number;
  thickness_mm: number;
  hole_bands: { count: number; hole_diameter_mm: number; center_radius_mm: number }[];
}

function buildModel(inputs: Record<string, unknown>): SectionFdmModel {
  const material = buildMaterial(inputs.material);
  const cooling = buildCooling(inputs.cooling);
  const sectionRaw = decode(inputs.section) as SectionInputs & { points_mm?: number[][] };
  const holeBands: HoleBand[] = (sectionRaw.hole_bands ?? []).map((b) =>
    makeHoleBand(b.count, b.hole_diameter_mm, b.center_radius_mm),
  );
  // An explicit polygon exercises the rasterizer on real imported-DXF geometry;
  // the rectangular helper leaves every cell center trivially interior.
  const section = sectionRaw.points_mm
    ? makeRotorSection(
        sectionRaw.points_mm.map((pt) => [pt[0]!, pt[1]!] as [number, number]),
        material,
        holeBands,
      )
    : rectangularSection(
        sectionRaw.outer_diameter_mm,
        sectionRaw.inner_diameter_mm,
        sectionRaw.thickness_mm,
        material,
        holeBands,
      );
  const sweptRaw = decode(inputs.swept_band) as { depth_mm: number; outer_offset_mm: number };
  const sweptBand = makeSweptBand(sweptRaw.depth_mm, sweptRaw.outer_offset_mm);
  return makeSectionFdmModel(
    section,
    cooling,
    sweptBand,
    null,
    inputs.n_radial as number,
    inputs.n_axial as number,
  );
}

/** Compare an actual solver result object against a recorded fixture result.
 * Mirrors thermalFdm.test.ts's checkResultAgainstFixture, extended to handle
 * `active_mask`, which -- unlike `temperature_c` / `train_snapshots_c` -- is a
 * SINGLE 2-D field (no time dimension), not a stack of snapshots. It is
 * wrapped in a length-1 stack for `digestFieldStack` (a 1-element stack digest
 * equals the single field's digest) and passed directly as the "final"
 * snapshot to `compareFinalField`. */
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
      const path = `${label}.${key}`;
      // `active_mask` is a SINGLE 2-D field (no time dimension), unlike
      // `temperature_c` / `train_snapshots_c` which are (n_snap, n_axial,
      // n_radial) stacks. digestFieldStack always reports a 3-D shape
      // (including the stack length), which would mismatch the fixture's
      // plain 2-D digest for active_mask -- so it goes through digestField
      // instead, and its "final" is the field itself, not a stack's last
      // element.
      if (key === "active_mask") {
        const snap = actual[key] as FieldSnapshot;
        failures.push(
          ...formatMismatches(path, compareDigest(wrapper.__digest__ as never, digestField(snap), FIELD_TOL, path)),
        );
        if (wrapper.final !== undefined) {
          failures.push(
            ...formatMismatches(
              `${path}.final`,
              compareFinalField(wrapper.final, snap, FIELD_TOL, `${path}.final`),
            ),
          );
        }
        continue;
      }
      const stack = actual[key] as FieldSnapshot[];
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

test("solvers/thermalFdmSection: section_baseline_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["section_baseline_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSectionSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkResultAgainstFixture(
    "section_baseline_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdmSection: section_cross_drilled_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["section_cross_drilled_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSectionSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkResultAgainstFixture(
    "section_cross_drilled_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdmSection: section_event_train matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["section_event_train"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSectionEventTrain(model, pulse, inputs.gap_s as number);
  const failures = checkResultAgainstFixture(
    "section_event_train",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdmSection: section_steady_band_450c matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["section_steady_band_450c"]!;
  const model = buildModel(inputs);
  const actual = solveSectionSteadyBandTemperature(model, inputs.band_temperature_c as number);
  const failures = checkResultAgainstFixture(
    "section_steady_band_450c",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFdmSection: section_stepped_profile_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["section_stepped_profile_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateSectionSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkResultAgainstFixture(
    "section_stepped_profile_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], failures.join("; "));
});
