import test from "node:test";
import assert from "node:assert/strict";
import { withinTolerance } from "../src/validation/sanityChecks.ts";

test("withinTolerance passes when the difference is within tolerance", () => {
  const r = withinTolerance("front_bias", 0.62, 0.60, 0.05);
  assert.deepEqual(r, {
    name: "front_bias",
    passed: true,
    value: 0.62,
    expected: 0.60,
    tolerance: 0.05,
  });
});

test("withinTolerance passes at exactly the tolerance boundary", () => {
  // Integer-valued inputs so the subtraction is exact in IEEE-754 double
  // arithmetic and doesn't land just past the boundary by float rounding.
  const r = withinTolerance("boundary", 10, 9, 1);
  assert.equal(r.passed, true);
});

test("withinTolerance fails when the difference exceeds tolerance", () => {
  const r = withinTolerance("rotor_temp_c", 620, 500, 50);
  assert.equal(r.passed, false);
  assert.equal(r.value, 620);
  assert.equal(r.expected, 500);
});

test("withinTolerance treats value below expected symmetrically", () => {
  const under = withinTolerance("low_side", 0.4, 0.5, 0.05);
  assert.equal(under.passed, false);
  const within = withinTolerance("low_side_ok", 0.46, 0.5, 0.05);
  assert.equal(within.passed, true);
});
