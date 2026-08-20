import test from "node:test";
import assert from "node:assert/strict";
import * as rotors from "../src/models/rotors.ts";
import { runFixture } from "./harness.ts";

test("models/rotors matches the Python golden fixtures", () => {
  const r = runFixture("models.rotors.json", rotors as Record<string, unknown>);
  assert.deepEqual(r.failures, [], `\n${r.failures.join("\n")}`);
  assert.deepEqual(r.skipped, [], `unported: ${r.skipped.join(", ")}`);
  assert.ok(r.checked > 0, "no cases ran");
  console.log(`    ${r.checked} golden cases verified`);
});
