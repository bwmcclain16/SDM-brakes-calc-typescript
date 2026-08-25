import test from "node:test";
import assert from "node:assert/strict";
import { buildHtmlReport } from "../src/reports/reportBuilder.ts";

const results = [
  { speed_mph: 60, stopping_distance_m: 42.5 },
  { speed_mph: 45, stopping_distance_m: 23.9 },
];
const assumptions = [
  { field: "driver_mass_kg", source: "FSAE rules minimum", impact: "worst-case stopping distance" },
];

test("buildHtmlReport includes title, status, and section headings", () => {
  const html = buildHtmlReport("Test Report", results, assumptions, "PASS");
  assert.match(html, /<title>Test Report<\/title>/);
  assert.match(html, /<h1>Test Report<\/h1>/);
  assert.match(html, /Validation status: PASS/);
  assert.match(html, /<h2>Assumptions<\/h2>/);
  assert.match(html, /<h2>Results<\/h2>/);
});

test("buildHtmlReport renders each assumption as a list item", () => {
  const html = buildHtmlReport("Test Report", results, assumptions, "PASS");
  assert.match(
    html,
    /<li><strong>driver_mass_kg<\/strong>: FSAE rules minimum; impact worst-case stopping distance<\/li>/,
  );
});

test("buildHtmlReport renders the results table with header and data rows", () => {
  const html = buildHtmlReport("Test Report", results, assumptions, "PASS");
  assert.match(html, /<table class="results">/);
  assert.match(html, /<th>speed_mph<\/th><th>stopping_distance_m<\/th>/);
  assert.match(html, /<td>60<\/td><td>42\.5<\/td>/);
  assert.match(html, /<td>45<\/td><td>23\.9<\/td>/);
});

test("buildHtmlReport HTML-escapes interpolated text", () => {
  const html = buildHtmlReport(
    "<script>alert(1)</script>",
    [{ note: 'a & b < c "d"' }],
    [{ field: "<b>bold</b>", source: "x", impact: "y" }],
    "PASS",
  );
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /a &amp; b &lt; c &quot;d&quot;/);
});

test("buildHtmlReport handles an empty results array", () => {
  const html = buildHtmlReport("Empty", [], [], "NEEDS INPUT");
  assert.match(html, /<table class="results"><\/table>/);
});
