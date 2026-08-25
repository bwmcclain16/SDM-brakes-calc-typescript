/** Port of `sdm_brakes.io.export_pdf`.
 *
 * DELIBERATE SUBSTITUTION, not a missing feature: the Python version rendered
 * PDF bytes with weasyprint (a native PDF layout engine), falling back to
 * writing plain HTML to disk if weasyprint was unavailable or failed. Neither
 * half of that is portable — there is no filesystem to write to, and pulling
 * in a client-side PDF-rendering library would mean shipping a second layout
 * engine into the bundle purely to re-derive what the browser already does
 * natively and better.
 *
 * The browser's own print pipeline is the correct replacement: every browser
 * can render arbitrary HTML/CSS and turn it into a PDF via its native
 * "Print > Save as PDF" path, with full CSS support (including `@media
 * print`) that weasyprint could only approximate. So `exportPdf` does not
 * produce PDF bytes at all — it hands back the same print-ready HTML that
 * `buildHtmlReport` produces, plus a note describing how the caller drives
 * the browser's print pipeline.
 *
 * What this does NOT provide: PDF bytes, a Blob, or a programmatic download.
 * The caller is responsible for getting `html` on screen (e.g. assign it into
 * a hidden `<iframe>` or a new tab/window) and then calling `window.print()`
 * on that document — browsers require a user gesture / real document context
 * for print, so it cannot be produced headlessly here. The user completes the
 * export by choosing "Save as PDF" in the browser's print dialog. */

import { buildHtmlReport, type Assumption } from "../reports/reportBuilder.ts";

export interface PrintReadyReport {
  /** The full HTML document to display before printing. */
  html: string;
  /** Human-readable instructions for turning `html` into a PDF. */
  note: string;
}

const PRINT_NOTE =
  "No PDF library is bundled (deliberate substitution for weasyprint). " +
  "Render `html` in the page (e.g. a hidden <iframe> or a new window/tab) " +
  "and call window.print() on it, then choose \"Save as PDF\" in the " +
  "browser's print dialog.";

/** Port of `export_pdf_or_html`. Builds the report via `buildHtmlReport` and
 * returns it as print-ready HTML — there is no PDF/HTML fallback branch to
 * port, since the single browser-native path covers both cases the Python
 * version's try/except was choosing between. */
export function exportPdf(
  title: string,
  results: ReadonlyArray<Record<string, unknown>>,
  assumptions: ReadonlyArray<Assumption>,
  validationStatus: string,
): PrintReadyReport {
  return {
    html: buildHtmlReport(title, results, assumptions, validationStatus),
    note: PRINT_NOTE,
  };
}
