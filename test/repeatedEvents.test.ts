import test from "node:test";
import assert from "node:assert/strict";
import * as repeatedEvents from "../src/solvers/repeatedEvents.ts";
import { runFixture } from "./harness.ts";

test("solvers/repeatedEvents matches the Python golden fixtures", () => {
  const r = runFixture("solvers.repeated_events.json", repeatedEvents as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
