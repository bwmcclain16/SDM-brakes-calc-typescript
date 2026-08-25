import test from "node:test";
import assert from "node:assert/strict";
import { exportPdf } from "../src/io/exportPdf.ts";
import { buildHtmlReport } from "../src/reports/reportBuilder.ts";

test("exportPdf returns the same HTML buildHtmlReport would produce, plus a print note", () => {
  const results = [{ speed_mph: 60, stopping_distance_m: 42.5 }];
  const assumptions = [{ field: "x", source: "y", impact: "z" }];

  const report = exportPdf("Test Report", results, assumptions, "PASS");
  const expectedHtml = buildHtmlReport("Test Report", results, assumptions, "PASS");

  assert.equal(report.html, expectedHtml);
  assert.equal(typeof report.note, "string");
  assert.match(report.note, /window\.print/);
});
