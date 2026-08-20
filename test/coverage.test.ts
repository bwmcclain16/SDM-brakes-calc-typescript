/** Port coverage guard.
 *
 * Walks every scalar fixture file, resolves the TypeScript module it belongs to,
 * and runs all of its recorded cases. Fails if a fixture has no ported module, or
 * if any function inside a ported module is missing an export.
 *
 * This exists because per-module tests can only fail for modules that HAVE a test.
 * A module nobody ported is invisible to them; it is not invisible here. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listFixtures, loadFixture, runFixture, tsName } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `solvers.brake_bias.json` -> `../src/solvers/brakeBias.ts` */
function modulePathFor(fixture: string): { rel: string; abs: string } | null {
  const stem = fixture.replace(/\.json$/, "");
  const dot = stem.indexOf(".");
  if (dot < 0) return null;
  const area = stem.slice(0, dot);
  if (area !== "solvers" && area !== "models") return null; // thermal.* uses its own harness
  const rel = `../src/${area}/${tsName(stem.slice(dot + 1))}.ts`;
  return { rel, abs: join(HERE, rel) };
}

test("every scalar fixture is covered by a ported TypeScript module", async () => {
  const unported: string[] = [];
  const failures: string[] = [];
  const skipped: string[] = [];
  let totalCases = 0;
  let totalChecked = 0;
  const rows: string[] = [];

  for (const file of listFixtures()) {
    const target = modulePathFor(file);
    if (!target) continue;
    const cases = Object.values(loadFixture(file).functions).reduce((n, c) => n + c.length, 0);
    totalCases += cases;
    if (!existsSync(target.abs)) {
      unported.push(`${file} -> ${target.rel} (${cases} cases unverified)`);
      continue;
    }
    const mod = (await import(target.rel)) as Record<string, unknown>;
    const r = runFixture(file, mod);
    totalChecked += r.checked;
    failures.push(...r.failures.map((f) => `${file}: ${f}`));
    skipped.push(...r.skipped.map((s) => `${file}: ${s}`));
    rows.push(`      ${file.padEnd(38)} ${String(r.checked).padStart(4)}/${cases}`);
  }

  console.log(`\n    port coverage:\n${rows.join("\n")}`);
  console.log(`    ${totalChecked}/${totalCases} recorded cases verified`);

  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
  assert.deepEqual(skipped, [], `\nunported functions:\n${skipped.join("\n")}`);
  assert.deepEqual(unported, [], `\nunported modules:\n${unported.join("\n")}`);
  assert.equal(totalChecked, totalCases, "every recorded case must be verified");
});
