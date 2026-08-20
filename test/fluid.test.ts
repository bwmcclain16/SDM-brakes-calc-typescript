import test from "node:test";
import assert from "node:assert/strict";
import * as fluid from "../src/solvers/fluid.ts";
import { runFixture } from "./harness.ts";

test("solvers/fluid matches the Python golden fixtures", () => {
  const r = runFixture("solvers.fluid.json", fluid as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
