/** Port of `sdm_brakes.reports.report_builder`.
 *
 * The Python version rendered a jinja2 template, with `results.to_html()`
 * producing the results table. There is no jinja2 or pandas here: this builds
 * the same HTML document with plain template-literal string construction and
 * a hand-rolled table renderer, and returns the HTML string instead of
 * writing it to disk. Sections and content match the original: title, a
 * validation-status line, an Assumptions list, and a Results table.
 *
 * One deliberate behavior change: the Python template used a bare
 * `jinja2.Template` with autoescaping off, so `{{ title }}` etc. were
 * inserted verbatim. This port HTML-escapes every interpolated text value
 * (title, status, assumption fields, table cells). For ordinary engineering
 * strings/numbers the output is identical either way; the only difference is
 * that a stray `<`, `&`, or `"` in an input can no longer break the markup. */

/** One row of the Assumptions section, matching the `assumption.field` /
 * `.source` / `.impact` fields the Jinja template read off each dict. */
export interface Assumption {
  field: string;
  source: string;
  impact: string;
}

function escapeHtml(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Builds a `<table class="results">` from an array of plain row objects.
 * Column order follows the first row's key insertion order, same convention
 * as `rowsToCsv` in `io/exportCsv.ts` (kept independent here rather than
 * imported, since the two renderers' escaping/formatting needs differ).
 * Missing keys on a given row render as an empty cell. */
function buildResultsTable(results: ReadonlyArray<Record<string, unknown>>): string {
  if (results.length === 0) return '<table class="results"></table>';
  const columns = Object.keys(results[0]!);
  const headerCells = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
  const bodyRows = results
    .map((row) => {
      const cells = columns
        .map((col) => `<td>${escapeHtml(row[col] ?? "")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return (
    `<table class="results">` +
    `<thead><tr>${headerCells}</tr></thead>` +
    `<tbody>${bodyRows}</tbody>` +
    `</table>`
  );
}

/** Port of `build_html_report`. Returns the rendered HTML report as a string. */
export function buildHtmlReport(
  title: string,
  results: ReadonlyArray<Record<string, unknown>>,
  assumptions: ReadonlyArray<Assumption>,
  validationStatus: string,
): string {
  const tableHtml = buildResultsTable(results);
  const assumptionItems = assumptions
    .map(
      (a) =>
        `    <li><strong>${escapeHtml(a.field)}</strong>: ${escapeHtml(a.source)}; impact ${escapeHtml(a.impact)}</li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #222; margin: 32px; }
    h1, h2 { color: #111; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; }
    th, td { border: 1px solid #bbb; padding: 5px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    .status { font-weight: bold; }
    .needs-input { color: #9a3412; font-weight: bold; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="status">Validation status: ${escapeHtml(validationStatus)}</p>
  <h2>Assumptions</h2>
  <ul>
${assumptionItems}
  </ul>
  <h2>Results</h2>
  ${tableHtml}
</body>
</html>
`;
}
