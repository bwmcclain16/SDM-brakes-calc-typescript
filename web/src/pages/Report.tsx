/** Export the active scenario: CSV, HTML report, or print-to-PDF.
 *
 * Three buttons, three destinations, one shared row set: the scenario's full
 * configuration (vehicle, brake hardware, conditions) flattened to
 * `{field, value}` rows, plus the same two headline metrics Compare shows, so
 * a report pulled in isolation still answers "is the bias sane" without
 * cross-referencing another page.
 *
 * PDF is a deliberate substitution, not a missing feature: the Python app
 * rendered PDF bytes with weasyprint; a static browser build has no native
 * PDF layout engine and pulling one in would mean shipping a second engine
 * just to re-derive what the browser's own print pipeline already does. So
 * "Print / Save as PDF" opens the same print-ready HTML in a new window and
 * calls the browser's native print() — the user picks "Save as PDF" in that
 * dialog. See `src/io/exportPdf.ts` for the full rationale.
 */
import { useState } from "react";
import type { Scenario } from "../state/store.ts";
import { rowsToCsv, reportFilename } from "@core/io/exportCsv.ts";
import { buildHtmlReport, type Assumption } from "@core/reports/reportBuilder.ts";
import { exportPdf } from "@core/io/exportPdf.ts";
import { frontAxleTorqueDistribution } from "@core/solvers/brakeBias.ts";
import { idealFrontBrakeFraction } from "@core/solvers/vehicle.ts";
import { NeedsInputError } from "@core/errors.ts";
import type { PageProps } from "./registry.tsx";

import baselineFile from "@data/vehicles/fsae_2026_baseline.json";

// Tag for report filenames. Bump alongside web/package.json's version — there
// is no build-time version injection in this static site, so it is a literal
// here rather than an import.
const MODEL_VERSION = "web-0.1.0";

/** The baseline data file's own `assumptions` array already matches the
 *  `Assumption` shape (`field` / `source` / `impact`, plus extra bookkeeping
 *  fields the report doesn't use). These describe the solver's data
 *  provenance, not any one scenario, so they're the same for every scenario
 *  rather than something carried on `Scenario` itself. */
const ASSUMPTIONS: Assumption[] = (
  (baselineFile as unknown as { assumptions?: Assumption[] }).assumptions ?? []
).map((a) => ({ field: a.field, source: a.source, impact: a.impact }));

function slug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario"
  );
}

/** Push one `{field, value}` row. `value` is `unknown` on purpose — it's
 *  passed straight through `rowsToCsv`/`buildHtmlReport`'s own stringifying,
 *  same as every other row producer in this app. */
function row(rows: Record<string, unknown>[], field: string, value: unknown): void {
  rows.push({ field, value });
}

function computedRows(scenario: Scenario): { rows: Record<string, unknown>[]; status: string } {
  const rows: Record<string, unknown>[] = [];
  try {
    row(rows, "computed.front_torque_split_pct", frontAxleTorqueDistribution(scenario.brakes) * 100);
  } catch (err) {
    if (!(err instanceof NeedsInputError)) throw err;
    row(rows, "computed.front_torque_split_pct", `needs input: ${err.fieldName}`);
    return { rows, status: `NEEDS INPUT: ${err.fieldName}` };
  }
  row(
    rows,
    "computed.ideal_bias_at_target_pct",
    idealFrontBrakeFraction(scenario.vehicle, scenario.conditions.target_deceleration_g) * 100,
  );
  return { rows, status: "OK — all inputs resolved" };
}

/** Flattens the scenario to the same field/value rows used for CSV, the HTML
 *  report, and the print/PDF path, so all three exports agree. */
function buildReportRows(scenario: Scenario): { rows: Record<string, unknown>[]; status: string } {
  const rows: Record<string, unknown>[] = [];
  const v = scenario.vehicle;
  row(rows, "vehicle.mass_without_driver_kg", v.mass_without_driver_kg);
  row(rows, "vehicle.static_front_weight_fraction", v.static_front_weight_fraction);
  row(rows, "vehicle.wheelbase_m", v.wheelbase_m);
  row(rows, "vehicle.front_track_m", v.front_track_m);
  row(rows, "vehicle.rear_track_m", v.rear_track_m);
  row(rows, "vehicle.cg_height_m", v.cg_height_m);
  row(rows, "vehicle.tire_rolling_radius_m", v.tire_rolling_radius_m);

  for (const [axleName, axle] of [
    ["front", scenario.brakes.front],
    ["rear", scenario.brakes.rear],
  ] as const) {
    row(rows, `brake_hardware.${axleName}.rotor_outer_diameter_mm`, axle.rotor_outer_diameter_mm);
    row(rows, `brake_hardware.${axleName}.rotor_thickness_mm`, axle.rotor_thickness_mm);
    row(rows, `brake_hardware.${axleName}.rotor_mass_kg`, axle.rotor_mass_kg);
    row(rows, `brake_hardware.${axleName}.pad_height_mm`, axle.pad_height_mm);
    row(rows, `brake_hardware.${axleName}.caliper.name`, axle.caliper.name);
    row(rows, `brake_hardware.${axleName}.caliper.piston_count`, axle.caliper.piston_count);
    row(rows, `brake_hardware.${axleName}.caliper.piston_diameter_mm`, axle.caliper.piston_diameter_mm);
  }

  const b = scenario.brakes;
  row(rows, "brake_hardware.front_pressure_fraction", b.front_pressure_fraction);
  row(rows, "brake_hardware.rear_pressure_fraction", b.rear_pressure_fraction);
  row(rows, "brake_hardware.front_master_cylinder_bore_mm", b.front_master_cylinder_bore_mm);
  row(rows, "brake_hardware.rear_master_cylinder_bore_mm", b.rear_master_cylinder_bore_mm);
  row(rows, "brake_hardware.pedal_ratio", b.pedal_ratio);
  row(rows, "brake_hardware.pedal_efficiency", b.pedal_efficiency);
  row(rows, "brake_hardware.max_pedal_travel_deg", b.max_pedal_travel_deg);

  const c = scenario.conditions;
  row(rows, "conditions.driver_mass_kg", c.driver_mass_kg);
  row(rows, "conditions.target_deceleration_g", c.target_deceleration_g);
  row(rows, "conditions.ambient_temperature_c", c.ambient_temperature_c);
  row(rows, "conditions.allowable_rotor_temperature_c", c.allowable_rotor_temperature_c);
  row(rows, "conditions.event_gap_s", c.event_gap_s);
  row(rows, "conditions.pedal_force_n", c.pedal_force_n);
  row(rows, "conditions.pad_label", c.pad_label);
  row(rows, "conditions.pad_mu", c.pad_mu);
  row(rows, "conditions.include_aero", c.include_aero);

  const computed = computedRows(scenario);
  rows.push(...computed.rows);
  return { rows, status: computed.status };
}

/** Client-side download via a Blob + object URL. The URL is revoked on the
 *  next tick — `click()` on a detached anchor starts the download
 *  synchronously in every current browser, but revoking in the *same* tick
 *  has a history of racing it in older engines, so it's deferred rather than
 *  called inline. Either way, nothing keeps the Blob (and the file it holds)
 *  alive past this function returning. */
function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Report({ scenario }: PageProps) {
  const [popupBlocked, setPopupBlocked] = useState(false);

  const title = `${scenario.name} — SDM Brakes configuration report`;
  const fileBase = slug(scenario.name);

  const handleCsv = () => {
    const { rows } = buildReportRows(scenario);
    download(
      rowsToCsv(rows),
      reportFilename(fileBase, "config-summary", MODEL_VERSION, "csv"),
      "text/csv;charset=utf-8",
    );
  };

  const handleHtml = () => {
    const { rows, status } = buildReportRows(scenario);
    const html = buildHtmlReport(title, rows, ASSUMPTIONS, status);
    download(html, reportFilename(fileBase, "config-summary", MODEL_VERSION, "html"), "text/html;charset=utf-8");
  };

  const handlePrint = () => {
    const { rows, status } = buildReportRows(scenario);
    const { html } = exportPdf(title, rows, ASSUMPTIONS, status);
    const win = window.open("", "_blank");
    if (win == null) {
      setPopupBlocked(true);
      return;
    }
    setPopupBlocked(false);
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    // Print-ready HTML needs a layout pass before print() measures it; a
    // same-tick call can print a blank page in some browsers.
    win.setTimeout(() => win.print(), 150);
  };

  return (
    <>
      <section className="panel" style={{ padding: 18 }}>
        <h2 style={{ marginBottom: 4 }}>{scenario.name}</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Exports the active scenario's configuration (vehicle, brake hardware, conditions), the
          same front torque split and ideal-bias headline metrics shown on Compare, and the
          project's documented modelling assumptions.
        </p>

        <div className="controls" style={{ marginBottom: 0 }}>
          <button className="primary" onClick={handleCsv}>
            Download CSV
          </button>
          <button className="primary" onClick={handleHtml}>
            Download HTML report
          </button>
          <button onClick={handlePrint}>Print / Save as PDF</button>
        </div>

        <p className="note">
          "Print / Save as PDF" is a deliberate substitution for the Python app's weasyprint
          export, not a missing feature: it opens this same report as print-ready HTML in a new
          tab and invokes the browser's own print dialog — choose "Save as PDF" there to get a
          file. No PDF library ships in this build.
        </p>
        {popupBlocked && (
          <p className="note" style={{ color: "var(--warn)" }}>
            The browser blocked the print tab as a popup. Allow popups for this page and try
            again.
          </p>
        )}
      </section>
    </>
  );
}
