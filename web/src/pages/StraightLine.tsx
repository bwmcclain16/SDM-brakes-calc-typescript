/** Straight-Line Braking — parameterised sweep over speed, driver mass,
 * deceleration, and front pressure bias.
 *
 * Ported from `app/pages/3_Straight_Line_Braking.py`. That page runs
 * `run_parameterized_sweep` once per swept front-bias value and concatenates
 * the frames; this does the same via `runSweep` below, which is a thin
 * wrapper around the ported `runParameterizedSweep` solver.
 *
 * Sweep bounds (speed/driver-mass/deceleration/front-bias ranges, and which
 * of those four are actually being swept vs. held at a single value) are
 * this page's own state — mirroring the Python sidebar's "Variables to
 * sweep" multiselect, which defaults to Speed + Driver mass only. Driver
 * mass and target deceleration, when NOT swept, come live from
 * `scenario.conditions` (as the Python page reads `scenario.driver_mass_kg`
 * fresh on every rerun); front pressure bias, when not swept, is a page-local
 * value seeded ONCE from the active scenario's brakes and then left alone —
 * mirroring the Python page's frozen `st.number_input` widget default.
 */
import { useMemo, useState } from "react";
import type Plotly from "plotly.js-dist-min";
import type { PageProps } from "./registry.tsx";
import { Chart, TRACE_COLORS } from "../components/Chart.tsx";
import { scenarioLabel } from "../state/store.ts";
import type { Scenario } from "../state/store.ts";
import type { BrakeHardware, Vehicle } from "@core/models/internal.ts";
import type { AeroMap } from "@core/solvers/aero.ts";
import { loadAeroMap } from "@core/solvers/aero.ts";
import type { StraightLineResult } from "@core/solvers/straightLineBraking.ts";
import { runParameterizedSweep } from "@core/solvers/straightLineBraking.ts";
import { ROTOR_MATERIALS, brakesWithPad, padLimitC } from "../state/materials.ts";
import { frontAxleTorqueDistribution } from "@core/solvers/brakeBias.ts";
import { idealFrontBrakeFraction } from "@core/solvers/vehicle.ts";

import baselineAeroRaw from "@data/aero/baseline_aero.json";

const AERO_MAP: AeroMap = loadAeroMap(baselineAeroRaw);

// --- sweep bound helpers (mirrors app/sweep.py `range_values` and the
// driver-mass linspace inlined in the Python page's sidebar) -----------------

function rangeValues(minimum: number, maximum: number, step: number): number[] {
  if (maximum < minimum || step <= 0) return [minimum];
  const count = Math.round((maximum - minimum) / step);
  return Array.from({ length: count + 1 }, (_, i) => Math.round((minimum + i * step) * 1e6) / 1e6);
}

function linspace(minimum: number, maximum: number, points: number): number[] {
  const n = Math.max(1, Math.round(points));
  if (n === 1) return [minimum];
  return Array.from(
    { length: n },
    (_, i) => Math.round((minimum + (i * (maximum - minimum)) / (n - 1)) * 1e4) / 1e4,
  );
}

// --- sweep execution ----------------------------------------------------------

type SweepRow = StraightLineResult & { front_pressure_fraction: number; scenario: string };

interface SweepParams {
  speeds: number[];
  driverMasses: number[];
  decelerations: number[];
  frontBiases: number[];
}

/** Front bias is the one swept axis that lives ON the hardware object rather
 * than being a plain function argument, so each swept value needs its own
 * brakes clone — same trick as Python's `make_brakes`, minus the rotor-mass
 * override (rotor mass is Setup's concern, not this page's). */
function variantBrakes(brakes: BrakeHardware, frontBias: number): BrakeHardware {
  return { ...brakes, front_pressure_fraction: frontBias, rear_pressure_fraction: 1.0 - frontBias };
}

function runSweep(
  vehicle: Vehicle,
  brakes: BrakeHardware,
  params: SweepParams,
  aeroMap: AeroMap | null,
  conditions: Scenario["conditions"],
  label: string,
): SweepRow[] {
  // The pad selection and the rotor material database both feed the solver's
  // temperature coupling: without the mu(T) curve the pad columns come back
  // empty, and without the materials the rotor never heats, so mu(T) has no
  // temperature to follow. Attaching one and not the other looks like it works.
  const withPad = brakesWithPad(brakes, conditions.pad_label, conditions.pad_mu);
  const rows: SweepRow[] = [];
  for (const bias of params.frontBiases) {
    const brakesForBias = variantBrakes(withPad, bias);
    const results = runParameterizedSweep(
      vehicle,
      brakesForBias,
      params.driverMasses,
      params.speeds,
      params.decelerations,
      aeroMap,
      ROTOR_MATERIALS,
      "uniform_pressure",
      conditions.ambient_temperature_c,
    );
    for (const r of results) rows.push({ ...r, front_pressure_fraction: bias, scenario: label });
  }
  return rows;
}

interface Headline {
  label: string;
  cases: number;
  frontTorqueSplitPct: number;
  maxEnergyKJ: number;
  maxStopM: number;
}

function headlineFor(s: Scenario, rows: SweepRow[], frontBiases: number[]): Headline {
  const bias0 = frontBiases[0] ?? s.brakes.front_pressure_fraction;
  return {
    label: scenarioLabel(s),
    cases: rows.length,
    frontTorqueSplitPct: frontAxleTorqueDistribution(variantBrakes(s.brakes, bias0)) * 100,
    maxEnergyKJ: rows.length ? Math.max(...rows.map((r) => r.front_energy_per_rotor_j)) / 1000 : 0,
    maxStopM: rows.length ? Math.max(...rows.map((r) => r.stopping_distance_m)) : 0,
  };
}

// --- chart series grouping ----------------------------------------------------
// Every chart groups rows by whichever swept dimensions are actually varying
// (plus scenario, while comparing) so a default 2-axis sweep draws a handful
// of readable lines rather than one line per case.

interface Vary {
  scenario: boolean;
  driver: boolean;
  decel: boolean;
  bias: boolean;
}

function computeVary(rows: SweepRow[], comparing: boolean): Vary {
  return {
    scenario: comparing,
    driver: new Set(rows.map((r) => r.driver_mass_kg)).size > 1,
    decel: new Set(rows.map((r) => r.target_deceleration_g)).size > 1,
    bias: new Set(rows.map((r) => r.front_pressure_fraction)).size > 1,
  };
}

function seriesLabel(r: SweepRow, vary: Vary): string {
  const parts: string[] = [];
  if (vary.scenario) parts.push(r.scenario);
  if (vary.driver) parts.push(`${r.driver_mass_kg.toFixed(0)} kg driver`);
  if (vary.decel) parts.push(`${r.target_deceleration_g.toFixed(2)} g`);
  if (vary.bias) parts.push(`${(r.front_pressure_fraction * 100).toFixed(0)}% F`);
  return parts.length ? parts.join(" · ") : "All cases";
}

function dedupeBy<T>(rows: T[], keyFn: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = keyFn(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

function groupBy<T>(rows: T[], keyFn: (r: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return map;
}

const traceColor = (idx: number): string => TRACE_COLORS[idx % TRACE_COLORS.length] ?? "#FFB800";

/** Stopping distance depends only on speed and deceleration (not driver mass
 * or front bias), so rows are deduped down to unique (scenario, decel, speed)
 * triples before grouping into lines. */
function stoppingDistanceTraces(rows: SweepRow[], vary: Vary): Partial<Plotly.PlotData>[] {
  const deduped = dedupeBy(rows, (r) => `${r.scenario}|${r.target_deceleration_g}|${r.initial_speed_mph}`);
  const groups = groupBy(deduped, (r) => `${r.scenario}|${r.target_deceleration_g}`);
  const traces: Partial<Plotly.PlotData>[] = [];
  let idx = 0;
  for (const [, groupRows] of groups) {
    const sorted = [...groupRows].sort((a, b) => a.initial_speed_mph - b.initial_speed_mph);
    const first = sorted[0]!;
    const color = traceColor(idx);
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      x: sorted.map((r) => r.initial_speed_mph),
      y: sorted.map((r) => r.stopping_distance_m),
      name: seriesLabel(first, { ...vary, driver: false, bias: false }),
      line: { color },
      marker: { color },
    });
    idx++;
  }
  return traces;
}

/** Energy per rotor depends on speed, driver mass, deceleration AND front
 * bias, so no dimension is deduped away here — every combination gets its
 * own front/rear pair of lines. */
function energyTraces(rows: SweepRow[], vary: Vary): Partial<Plotly.PlotData>[] {
  const groups = groupBy(
    rows,
    (r) => `${r.scenario}|${r.driver_mass_kg}|${r.target_deceleration_g}|${r.front_pressure_fraction}`,
  );
  const traces: Partial<Plotly.PlotData>[] = [];
  let idx = 0;
  for (const [, groupRows] of groups) {
    const sorted = [...groupRows].sort((a, b) => a.initial_speed_mph - b.initial_speed_mph);
    const first = sorted[0]!;
    const label = seriesLabel(first, vary);
    const color = traceColor(idx);
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      x: sorted.map((r) => r.initial_speed_mph),
      y: sorted.map((r) => r.front_energy_per_rotor_j / 1000),
      name: `${label} — Front`,
      line: { color },
      marker: { color, symbol: "circle" },
    });
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      x: sorted.map((r) => r.initial_speed_mph),
      y: sorted.map((r) => r.rear_energy_per_rotor_j / 1000),
      name: `${label} — Rear`,
      line: { color, dash: "dot" },
      marker: { color, symbol: "diamond" },
    });
    idx++;
  }
  return traces;
}

/** Torque depends on mass, deceleration and bias — NOT speed — so rows are
 * deduped to unique (scenario, driver mass, decel, bias) cases first. */
function torqueTraces(rows: SweepRow[], vary: Vary): Partial<Plotly.PlotData>[] {
  const deduped = dedupeBy(
    rows,
    (r) => `${r.scenario}|${r.driver_mass_kg}|${r.target_deceleration_g}|${r.front_pressure_fraction}`,
  );
  const groups = groupBy(deduped, (r) => `${r.scenario}|${r.driver_mass_kg}|${r.front_pressure_fraction}`);
  const traces: Partial<Plotly.PlotData>[] = [];
  let idx = 0;
  for (const [, groupRows] of groups) {
    const sorted = [...groupRows].sort((a, b) => a.target_deceleration_g - b.target_deceleration_g);
    const first = sorted[0]!;
    const label = seriesLabel(first, { ...vary, decel: false });
    const color = traceColor(idx);
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      x: sorted.map((r) => r.target_deceleration_g),
      y: sorted.map((r) => r.front_rotor_torque_nm),
      name: `${label} — Front`,
      line: { color },
      marker: { color, symbol: "circle" },
    });
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      x: sorted.map((r) => r.target_deceleration_g),
      y: sorted.map((r) => r.rear_rotor_torque_nm),
      name: `${label} — Rear`,
      line: { color, dash: "dot" },
      marker: { color, symbol: "diamond" },
    });
    idx++;
  }
  return traces;
}

// --- small form control -------------------------------------------------------

function NumberField({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <label>{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

// --- page ----------------------------------------------------------------------

type TabId = "setup" | "plots" | "energy" | "torque" | "table";
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "plots", label: "Plots" },
  { id: "energy", label: "Rotor Energy" },
  { id: "torque", label: "Rotor Torque" },
  { id: "table", label: "Results Table" },
];

const MAX_TABLE_ROWS = 500;

export function StraightLine({ scenario, compared, comparing }: PageProps) {
  const [tab, setTab] = useState<TabId>("setup");

  // Which variables are parameterised — mirrors the Python sidebar's
  // "Variables to sweep" multiselect (default: Speed + Driver mass).
  const [sweepSpeed, setSweepSpeed] = useState(true);
  const [sweepDriver, setSweepDriver] = useState(true);
  const [sweepDecel, setSweepDecel] = useState(false);
  const [sweepBias, setSweepBias] = useState(false);

  const [speedMin, setSpeedMin] = useState(25);
  const [speedMax, setSpeedMax] = useState(55);
  const [speedStep, setSpeedStep] = useState(5);
  const [speedSingle, setSpeedSingle] = useState(55);

  const [driverMin, setDriverMin] = useState(42.64);
  const [driverMax, setDriverMax] = useState(110.22);
  const [driverPoints, setDriverPoints] = useState(9);

  const [decelMin, setDecelMin] = useState(1.0);
  const [decelMax, setDecelMax] = useState(1.6);
  const [decelStep, setDecelStep] = useState(0.1);

  const [biasMin, setBiasMin] = useState(0.5);
  const [biasMax, setBiasMax] = useState(0.7);
  const [biasStep, setBiasStep] = useState(0.05);
  // Frozen at first mount, like the Python page's `number_input` default:
  // editing the car's actual bias later on Setup does not silently move this
  // sweep's single-value case out from under whatever the user left here.
  const [biasSingle, setBiasSingle] = useState(() => scenario.brakes.front_pressure_fraction);

  const speeds = useMemo(
    () => (sweepSpeed ? rangeValues(speedMin, speedMax, speedStep) : [speedSingle]),
    [sweepSpeed, speedMin, speedMax, speedStep, speedSingle],
  );
  const driverMasses = useMemo(
    () => (sweepDriver ? linspace(driverMin, driverMax, driverPoints) : [scenario.conditions.driver_mass_kg]),
    [sweepDriver, driverMin, driverMax, driverPoints, scenario.conditions.driver_mass_kg],
  );
  const decelerations = useMemo(
    () => (sweepDecel ? rangeValues(decelMin, decelMax, decelStep) : [scenario.conditions.target_deceleration_g]),
    [sweepDecel, decelMin, decelMax, decelStep, scenario.conditions.target_deceleration_g],
  );
  const frontBiases = useMemo(
    () => (sweepBias ? rangeValues(biasMin, biasMax, biasStep) : [biasSingle]),
    [sweepBias, biasMin, biasMax, biasStep, biasSingle],
  );

  const params: SweepParams = { speeds, driverMasses, decelerations, frontBiases };
  const activeLabel = scenarioLabel(scenario);

  const activeRows = useMemo(
    () =>
      runSweep(
        scenario.vehicle,
        scenario.brakes,
        params,
        scenario.conditions.include_aero ? AERO_MAP : null,
        scenario.conditions,
        activeLabel,
      ),
    [scenario, speeds, driverMasses, decelerations, frontBiases, activeLabel, params],
  );

  const overlayRows = useMemo(() => {
    if (!comparing) return [];
    return compared.flatMap((s) =>
      runSweep(
        s.vehicle,
        s.brakes,
        params,
        s.conditions.include_aero ? AERO_MAP : null,
        s.conditions,
        scenarioLabel(s),
      ),
    );
  }, [comparing, compared, speeds, driverMasses, decelerations, frontBiases, params]);

  const chartSource = comparing ? overlayRows : activeRows;
  const vary = computeVary(chartSource, comparing);

  const headlineRows = useMemo(() => {
    if (!comparing) return [];
    return compared.map((s) => {
      const label = scenarioLabel(s);
      const rows = overlayRows.filter((r) => r.scenario === label);
      return headlineFor(s, rows, frontBiases);
    });
  }, [comparing, compared, overlayRows, frontBiases]);
  const baselineHeadline = headlineRows[0];

  // --- answer row ---
  const activeFrontBias0 = frontBiases[0] ?? scenario.brakes.front_pressure_fraction;
  const frontTorqueSplitPct = frontAxleTorqueDistribution(variantBrakes(scenario.brakes, activeFrontBias0)) * 100;
  const idealBiasG = Math.max(...decelerations);
  const idealBiasPct = idealFrontBrakeFraction(scenario.vehicle, idealBiasG) * 100;
  const maxEnergyKJ = activeRows.length ? Math.max(...activeRows.map((r) => r.front_energy_per_rotor_j)) / 1000 : 0;
  const maxStopM = activeRows.length ? Math.max(...activeRows.map((r) => r.stopping_distance_m)) : 0;

  // --- Rotor Energy tab metrics ---
  const maxFrontEnergyKJ = maxEnergyKJ;
  const maxRearEnergyKJ = activeRows.length ? Math.max(...activeRows.map((r) => r.rear_energy_per_rotor_j)) / 1000 : 0;

  // --- Rotor Torque tab metrics ---
  const maxFrontTorque = activeRows.length ? Math.max(...activeRows.map((r) => r.front_rotor_torque_nm)) : 0;
  const maxRearTorque = activeRows.length ? Math.max(...activeRows.map((r) => r.rear_rotor_torque_nm)) : 0;
  const maxFrontAxleTorque = activeRows.length ? Math.max(...activeRows.map((r) => r.front_axle_torque_nm)) : 0;
  const maxRearAxleTorque = activeRows.length ? Math.max(...activeRows.map((r) => r.rear_axle_torque_nm)) : 0;

  const tableRows = chartSource.slice(0, MAX_TABLE_ROWS);

  return (
    <div>
      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">Cases</div>
          <div className="metric-value num">{activeRows.length.toLocaleString()}</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Front Torque Split</div>
          <div className="metric-value num">{frontTorqueSplitPct.toFixed(1)}%</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Ideal Bias @ {idealBiasG.toFixed(2)} g</div>
          <div className="metric-value num">{idealBiasPct.toFixed(1)}%</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Max Energy / Front Rotor</div>
          <div className="metric-value num">{maxEnergyKJ.toFixed(1)} kJ</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Max Stop Distance</div>
          <div className="metric-value num">{maxStopM.toFixed(1)} m</div>
        </div>
      </div>

      {comparing && (
        <div className="panel scroll-x" style={{ padding: 12, marginBottom: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Scenario comparison</h3>
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Cases</th>
                <th>Front split</th>
                <th>&Delta; split</th>
                <th>Max energy / front rotor</th>
                <th>&Delta; energy</th>
                <th>Max stop distance</th>
              </tr>
            </thead>
            <tbody>
              {headlineRows.map((h) => (
                <tr key={h.label}>
                  <td>{h.label}</td>
                  <td className="num">{h.cases.toLocaleString()}</td>
                  <td className="num">{h.frontTorqueSplitPct.toFixed(1)}%</td>
                  <td className="num">
                    {baselineHeadline ? (h.frontTorqueSplitPct - baselineHeadline.frontTorqueSplitPct).toFixed(1) : "—"} pp
                  </td>
                  <td className="num">{h.maxEnergyKJ.toFixed(1)} kJ</td>
                  <td className="num">
                    {baselineHeadline ? (h.maxEnergyKJ - baselineHeadline.maxEnergyKJ).toFixed(1) : "—"} kJ
                  </td>
                  <td className="num">{h.maxStopM.toFixed(1)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="controls panel" style={{ padding: 13 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={sweepSpeed} onChange={(e) => setSweepSpeed(e.target.checked)} style={{ width: 13, height: 13, padding: 0 }} />
            <span style={{ color: "var(--text)" }}>Sweep speed</span>
          </label>
          {sweepSpeed ? (
            <div style={{ display: "flex", gap: 8 }}>
              <NumberField label="Min, mph" value={speedMin} step={5} onChange={setSpeedMin} />
              <NumberField label="Max, mph" value={speedMax} step={5} onChange={setSpeedMax} />
              <NumberField label="Step, mph" value={speedStep} step={1} onChange={setSpeedStep} />
            </div>
          ) : (
            <NumberField label="Speed, mph" value={speedSingle} step={5} onChange={setSpeedSingle} />
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={sweepDriver} onChange={(e) => setSweepDriver(e.target.checked)} style={{ width: 13, height: 13, padding: 0 }} />
            <span style={{ color: "var(--text)" }}>Sweep driver mass</span>
          </label>
          {sweepDriver ? (
            <div style={{ display: "flex", gap: 8 }}>
              <NumberField label="Min, kg" value={driverMin} step={1} onChange={setDriverMin} />
              <NumberField label="Max, kg" value={driverMax} step={1} onChange={setDriverMax} />
              <NumberField label="Points" value={driverPoints} step={1} min={1} onChange={(v) => setDriverPoints(Math.max(1, Math.round(v)))} />
            </div>
          ) : (
            <p className="note" style={{ margin: 0 }}>Uses the conditions bar's driver mass ({scenario.conditions.driver_mass_kg.toFixed(1)} kg).</p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={sweepDecel} onChange={(e) => setSweepDecel(e.target.checked)} style={{ width: 13, height: 13, padding: 0 }} />
            <span style={{ color: "var(--text)" }}>Sweep deceleration</span>
          </label>
          {sweepDecel ? (
            <div style={{ display: "flex", gap: 8 }}>
              <NumberField label="Min, g" value={decelMin} step={0.1} onChange={setDecelMin} />
              <NumberField label="Max, g" value={decelMax} step={0.1} onChange={setDecelMax} />
              <NumberField label="Step, g" value={decelStep} step={0.05} onChange={setDecelStep} />
            </div>
          ) : (
            <p className="note" style={{ margin: 0 }}>
              Uses the conditions bar's target deceleration ({scenario.conditions.target_deceleration_g.toFixed(2)} g).
            </p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={sweepBias} onChange={(e) => setSweepBias(e.target.checked)} style={{ width: 13, height: 13, padding: 0 }} />
            <span style={{ color: "var(--text)" }}>Sweep front bias</span>
          </label>
          {sweepBias ? (
            <div style={{ display: "flex", gap: 8 }}>
              <NumberField label="Min" value={biasMin} step={0.01} onChange={setBiasMin} />
              <NumberField label="Max" value={biasMax} step={0.01} onChange={setBiasMax} />
              <NumberField label="Step" value={biasStep} step={0.01} onChange={setBiasStep} />
            </div>
          ) : (
            <NumberField label="Front pressure bias" value={biasSingle} step={0.01} onChange={setBiasSingle} />
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "setup" && (
        <div>
          <h3 style={{ marginBottom: 10 }}>Sweep Definition</h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Values</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Speed, mph</td>
                  <td className="num">{speeds.map((v) => v.toFixed(0)).join(", ")}</td>
                </tr>
                <tr>
                  <td>Driver mass, kg</td>
                  <td className="num">{driverMasses.map((v) => v.toFixed(2)).join(", ")}</td>
                </tr>
                <tr>
                  <td>Deceleration, g</td>
                  <td className="num">{decelerations.map((v) => v.toFixed(2)).join(", ")}</td>
                </tr>
                <tr>
                  <td>Front pressure bias</td>
                  <td className="num">{frontBiases.map((v) => v.toFixed(2)).join(", ")}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note">
            Solver: direct algebraic hand checks (no iterative convergence) — matches the Python page's Setup tab.
          </p>
          <PadStatus rows={activeRows} conditions={scenario.conditions} />
        </div>
      )}

      {tab === "plots" && (
        <div className="charts">
          <Chart
            title="Stopping Distance vs Speed"
            data={stoppingDistanceTraces(chartSource, vary)}
            layout={{ xaxis: { title: { text: "Initial Speed (mph)" } }, yaxis: { title: { text: "Stopping Distance (m)" } } }}
          />
        </div>
      )}

      {tab === "energy" && (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            Where the kinetic energy goes: KE = ½mv² splits between the axles by the actual torque distribution,
            then halves across each axle's two rotors.
          </p>
          <div className="metrics">
            <div className="metric panel">
              <div className="metric-label">Max Front Rotor Energy</div>
              <div className="metric-value num">{maxFrontEnergyKJ.toFixed(1)} kJ</div>
            </div>
            <div className="metric panel">
              <div className="metric-label">Max Rear Rotor Energy</div>
              <div className="metric-value num">{maxRearEnergyKJ.toFixed(1)} kJ</div>
            </div>
          </div>
          <div className="charts">
            <Chart
              title="Energy Per Rotor vs Speed"
              data={energyTraces(chartSource, vary)}
              layout={{ xaxis: { title: { text: "Initial Speed (mph)" } }, yaxis: { title: { text: "Rotor Energy (kJ)" } } }}
            />
          </div>
        </div>
      )}

      {tab === "torque" && (
        <div>
          <p className="note" style={{ marginTop: 0 }}>
            Per-rotor brake torque required to hit each swept case: T_total = m·a·r_tire, split by the actual
            front/rear torque distribution and divided across the two rotors on each axle. Torque depends on mass,
            deceleration and bias — not on initial speed.
          </p>
          <div className="metrics">
            <div className="metric panel">
              <div className="metric-label">Max Front Rotor Torque</div>
              <div className="metric-value num">{maxFrontTorque.toFixed(0)} N·m</div>
            </div>
            <div className="metric panel">
              <div className="metric-label">Max Rear Rotor Torque</div>
              <div className="metric-value num">{maxRearTorque.toFixed(0)} N·m</div>
            </div>
            <div className="metric panel">
              <div className="metric-label">Max Front Axle Torque</div>
              <div className="metric-value num">{maxFrontAxleTorque.toFixed(0)} N·m</div>
            </div>
            <div className="metric panel">
              <div className="metric-label">Max Rear Axle Torque</div>
              <div className="metric-value num">{maxRearAxleTorque.toFixed(0)} N·m</div>
            </div>
          </div>
          <div className="charts">
            <Chart
              title="Per-Rotor Torque vs Deceleration"
              data={torqueTraces(chartSource, vary)}
              layout={{ xaxis: { title: { text: "Deceleration (g)" } }, yaxis: { title: { text: "Rotor Torque (N·m)" } } }}
            />
          </div>
        </div>
      )}

      {tab === "table" && (
        <div className="scroll-x">
          {chartSource.length > MAX_TABLE_ROWS && (
            <p className="note">
              Showing the first {MAX_TABLE_ROWS.toLocaleString()} of {chartSource.length.toLocaleString()} rows —
              narrow the sweep to see the rest.
            </p>
          )}
          <table>
            <thead>
              <tr>
                {comparing && <th>Scenario</th>}
                <th>Speed (mph)</th>
                <th>Driver (kg)</th>
                <th>Decel (g)</th>
                <th>Front bias</th>
                <th>Front energy (kJ)</th>
                <th>Rear energy (kJ)</th>
                <th>Stop distance (m)</th>
                <th>Front torque (N·m)</th>
                <th>Rear torque (N·m)</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r, i) => (
                <tr key={i}>
                  {comparing && <td>{r.scenario}</td>}
                  <td className="num">{r.initial_speed_mph.toFixed(0)}</td>
                  <td className="num">{r.driver_mass_kg.toFixed(1)}</td>
                  <td className="num">{r.target_deceleration_g.toFixed(2)}</td>
                  <td className="num">{r.front_pressure_fraction.toFixed(2)}</td>
                  <td className="num">{(r.front_energy_per_rotor_j / 1000).toFixed(2)}</td>
                  <td className="num">{(r.rear_energy_per_rotor_j / 1000).toFixed(2)}</td>
                  <td className="num">{r.stopping_distance_m.toFixed(2)}</td>
                  <td className="num">{r.front_rotor_torque_nm.toFixed(1)}</td>
                  <td className="num">{r.rear_rotor_torque_nm.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Where the pad's μ actually sat across the sweep, and whether the run left
 *  the compound's characterized band.
 *
 * A design μ printed on its own hides the thing that matters: μ(T) is only
 * measured over a band, and a stop that runs past the top of it is being
 * extrapolated, not predicted. */
function PadStatus({
  rows,
  conditions,
}: {
  rows: SweepRow[];
  conditions: Scenario["conditions"];
}) {
  const limitC = padLimitC(conditions.pad_label);
  if (limitC === null) {
    return (
      <p className="note">
        <strong>Constant μ:</strong> {conditions.pad_mu.toFixed(2)} (temperature-independent) —
        pick a characterized compound in the conditions bar to couple μ to rotor temperature.
      </p>
    );
  }

  const mus = rows
    .flatMap((r) => [r.front_pad_mu_at_temperature, r.rear_pad_mu_at_temperature])
    .filter((v): v is number => v != null && Number.isFinite(v));
  const peaks = rows
    .flatMap((r) => [r.front_rotor_peak_temperature_c, r.rear_rotor_peak_temperature_c])
    .filter((v): v is number => v != null && Number.isFinite(v));
  const overLimit = rows.some(
    (r) => r.front_pad_over_temperature_limit || r.rear_pad_over_temperature_limit,
  );

  return (
    <>
      <p className="note">
        <strong>{conditions.pad_label}</strong> — μ(T) coupled to rotor peak temperature. Peak
        rotor temp up to {peaks.length ? Math.max(...peaks).toFixed(0) : "n/a"} °C (ambient{" "}
        {conditions.ambient_temperature_c.toFixed(0)} °C). μ(T) range{" "}
        {mus.length ? Math.min(...mus).toFixed(3) : "n/a"}–
        {mus.length ? Math.max(...mus).toFixed(3) : "n/a"}.
      </p>
      {overLimit && (
        <p className="note" style={{ color: "var(--bad)" }}>
          OVER LIMIT: at least one case exceeds the pad's characterized band ({limitC.toFixed(0)} °C).
        </p>
      )}
    </>
  );
}
