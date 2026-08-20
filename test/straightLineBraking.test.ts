import test from "node:test";
import assert from "node:assert/strict";
import * as straightLineBraking from "../src/solvers/straightLineBraking.ts";
import { runFixture } from "./harness.ts";

test("solvers/straightLineBraking matches the Python golden fixtures", () => {
  const r = runFixture("solvers.straight_line_braking.json", straightLineBraking as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
