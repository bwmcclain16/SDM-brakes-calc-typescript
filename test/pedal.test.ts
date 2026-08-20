import test from "node:test";
import assert from "node:assert/strict";
import * as pedal from "../src/solvers/pedal.ts";
import { runFixture } from "./harness.ts";

test("solvers/pedal matches the Python golden fixtures", () => {
  const r = runFixture("solvers.pedal.json", pedal as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
