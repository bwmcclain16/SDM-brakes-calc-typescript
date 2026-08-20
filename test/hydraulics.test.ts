import test from "node:test";
import assert from "node:assert/strict";
import * as hydraulics from "../src/solvers/hydraulics.ts";
import { runFixture } from "./harness.ts";

test("solvers/hydraulics matches the Python golden fixtures", () => {
  const r = runFixture("solvers.hydraulics.json", hydraulics as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
