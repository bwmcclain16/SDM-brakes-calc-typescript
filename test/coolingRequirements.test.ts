import test from "node:test";
import assert from "node:assert/strict";
import * as coolingRequirements from "../src/solvers/coolingRequirements.ts";
import { runFixture } from "./harness.ts";

test("solvers/coolingRequirements matches the Python golden fixtures", () => {
  const r = runFixture("solvers.cooling_requirements.json", coolingRequirements as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
