import test from "node:test";
import assert from "node:assert/strict";
import * as brakeBias from "../src/solvers/brakeBias.ts";
import { runFixture } from "./harness.ts";

test("solvers/brakeBias matches the Python golden fixtures", () => {
  const r = runFixture("solvers.brake_bias.json", brakeBias as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
