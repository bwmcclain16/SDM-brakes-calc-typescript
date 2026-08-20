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
import {
  facePlateHeatFraction,
  makeFacePlateModel,
  simulateFaceEventTrain,
  simulateFaceSingleStop,
  type FacePlateModel,
  type RotorFaceGeometry,
  type SweptBand,
} from "../src/solvers/thermalFacePlane.ts";
import { makeHeatPulse, type FieldSnapshot, type HeatPulse, type HeatPulseProfile } from "../src/solvers/thermalFdm.ts";
import type { CoolingParameters } from "../src/models/internal.ts";
import type { RotorMaterial } from "../src/models/rotors.ts";

const FIELD_TOL = 1e-12;
const SCALAR_TOL = 1e-12;

type FaceFixture = {
  module: string;
  scenarios: Record<string, { inputs: Record<string, unknown>; result: Record<string, unknown> }>;
};

const fixture = loadFixture("thermal.face.json") as unknown as FaceFixture;

function buildModel(inputs: Record<string, unknown>): FacePlateModel {
  const material = decode(inputs.material) as RotorMaterial;
  const geomRaw = decode(inputs.geometry) as Record<string, unknown>;
  const geometry: RotorFaceGeometry = { ...(geomRaw as unknown as RotorFaceGeometry), material };
  const cooling = decode(inputs.cooling) as CoolingParameters;
  const sweptBand = decode(inputs.swept_band) as SweptBand;
  return makeFacePlateModel(geometry, cooling, sweptBand, null, inputs.n_pixels as number);
}

function buildPulse(raw: unknown): HeatPulse {
  const p = decode(raw) as { energy_j: number; duration_s: number; profile?: HeatPulseProfile };
  return makeHeatPulse(p.energy_j, p.duration_s, p.profile ?? "linear");
}

/** Is this fixture value a field-digest wrapper (`{__digest__, final?, perSnapshot?}`)? */
function isDigestWrapper(v: unknown): v is { __digest__: unknown; final?: unknown; perSnapshot?: unknown } {
  return v !== null && typeof v === "object" && !Array.isArray(v) && "__digest__" in (v as Record<string, unknown>);
}

/** Compare an actual solver result object against a recorded fixture result.
 *
 * Mirrors thermalFdm.test.ts's checkResultAgainstFixture, adapted for this
 * module's mix of field-STACK results (`temperature_c`, `train_snapshots_c`:
 * digest + final + perSnapshot, actual is `FieldSnapshot[]`) and single-field
 * results (`active_mask`, `band_mask`: digest + final only, actual is one
 * `FieldSnapshot`). Iteration is driven by the fixture's own keys, so extra
 * actual-only fields (e.g. `final_field` on the event-train result) are never
 * checked. */
function checkFaceResult(label: string, expected: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const [key, evalue] of Object.entries(expected)) {
    const path = `${label}.${key}`;
    if (isDigestWrapper(evalue)) {
      const wrapper = evalue;
      if (wrapper.perSnapshot !== undefined) {
        const stack = actual[key] as FieldSnapshot[];
        failures.push(
          ...formatMismatches(path, compareDigest(wrapper.__digest__ as never, digestFieldStack(stack), FIELD_TOL, path)),
        );
        if (wrapper.final !== undefined) {
          const finalSnap = stack[stack.length - 1]!;
          failures.push(
            ...formatMismatches(
              `${path}.final`,
              compareFinalField(wrapper.final as number[][], finalSnap, FIELD_TOL, `${path}.final`),
            ),
          );
        }
        failures.push(
          ...formatMismatches(
            `${path}.perSnapshot`,
            comparePerSnapshot(wrapper.perSnapshot as never, stack, FIELD_TOL, `${path}.perSnapshot`),
          ),
        );
      } else {
        const single = actual[key] as FieldSnapshot;
        failures.push(
          ...formatMismatches(path, compareDigest(wrapper.__digest__ as never, digestField(single), FIELD_TOL, path)),
        );
        if (wrapper.final !== undefined) {
          failures.push(
            ...formatMismatches(
              `${path}.final`,
              compareFinalField(wrapper.final as number[][], single, FIELD_TOL, `${path}.final`),
            ),
          );
        }
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

test("solvers/thermalFacePlane: facePlateHeatFraction falls back to cooling default", () => {
  const geometry: RotorFaceGeometry = {
    outer_diameter_mm: 183,
    inner_diameter_mm: 148,
    thickness_mm: 4,
    material: { name: "x", density_kg_m3: 1, specific_heat_j_kgk: 1, thermal_conductivity_w_mk: 1 },
  };
  const cooling: CoolingParameters = {
    convection_coefficient_w_m2k: 60,
    emissivity: 0.55,
    ambient_temperature_c: 35,
    allowable_rotor_temperature_c: 500,
    rotor_heat_fraction: 0.7,
  };
  const model = makeFacePlateModel(geometry, cooling, { depth_mm: 17.5, outer_offset_mm: 0 }, null, 81);
  assert.equal(facePlateHeatFraction(model), 0.7);
});

test("solvers/thermalFacePlane: face_plain_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["face_plain_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateFaceSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkFaceResult("face_plain_single_stop", result, actual as unknown as Record<string, unknown>);
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFacePlane: face_cross_drilled_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["face_cross_drilled_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateFaceSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkFaceResult(
    "face_cross_drilled_single_stop",
    result,
    actual as unknown as Record<string, unknown>,
  );
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFacePlane: face_event_train matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["face_event_train"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateFaceEventTrain(
    model,
    pulse,
    inputs.gap_s as number,
    inputs.max_events as number,
    2.0,
    0.01,
    3,
    inputs.snapshots as number,
  );
  const failures = checkFaceResult("face_event_train", result, actual as unknown as Record<string, unknown>);
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
});

test("solvers/thermalFacePlane: face_slots_and_inner_contour_single_stop matches the Python golden fixture", () => {
  const { inputs, result } = fixture.scenarios["face_slots_and_inner_contour_single_stop"]!;
  const model = buildModel(inputs);
  const pulse = buildPulse(inputs.pulse);
  const actual = simulateFaceSingleStop(model, pulse, null, inputs.cool_down_s as number, 25);
  const failures = checkFaceResult("face_slots_and_inner_contour_single_stop", result, actual as unknown as Record<string, unknown>);
  assert.deepEqual(failures, [], failures.join("; "));
});
