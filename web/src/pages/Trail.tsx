/** Trail Braking — quasi-static time history through corner entry.
 *
 * Ports app/pages/10_Trail_Braking.py: the brake is released linearly while
 * lateral acceleration (and steering) build linearly toward the apex, and
 * every sample along that ramp is an independent four-corner combined-slip
 * solution (no transient load-transfer dynamics between samples).
 *
 * This is the only time-domain analysis in the app, which is what makes it
 * the natural landing point for a real lap-sim trace: swap the synthetic
 * makeLinearTrailProfile() ramp below for a recorded (or simulated) corner-
 * entry channel and everything downstream — the per-instant combined-slip
 * solve, the stability/lock-margin summary, the energy integral — keeps
 * working unchanged. The profile here is intentionally synthetic until that
 * trace exists.
 */
import { useMemo, useState } from "react";
import type { PageProps } from "./registry.tsx";
import { Chart, TRACE_COLORS } from "../components/Chart.tsx";
import { scenarioLabel } from "../state/store.ts";
import type { Scenario } from "../state/store.ts";
import type { CombinedBrakingCase } from "@core/solvers/combinedBraking.ts";
import type { TrailBrakingHistoryRow, TrailBrakingSummary } from "@core/solvers/trailBraking.ts";
import { evaluateTrailBraking, makeLinearTrailProfile } from "@core/solvers/trailBraking.ts";
import type { LoadSensitiveTire } from "@core/models/tires.ts";
import type { SuspensionSetup } from "@core/models/suspension.ts";

import tiresFile from "@data/tires/generic_load_sensitive_mu.json";
import suspensionFile from "@data/suspension/baseline_suspension.json";

const TIRE = (tiresFile as unknown as { tires: LoadSensitiveTire[] }).tires[0]!;
const SUSPENSION = (suspensionFile as unknown as { suspension: SuspensionSetup }).suspension;

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const POINTS = 30;
const FLAT_MU_FALLBACK = 1.6;

interface TrailRun {
  scenario: Scenario;
  label: string;
  history: TrailBrakingHistoryRow[];
  summary: TrailBrakingSummary;
}

function fmt(n: number, digits = 0): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

/** One wheel's time-ordered slice — history is built time-major (4 wheel rows
 *  per sample, in order), so filtering by wheel alone preserves time order. */
function seriesFor(run: TrailRun, wheel: string): TrailBrakingHistoryRow[] {
  return run.history.filter((r) => r.wheel === wheel);
}

/** Total instantaneous brake power across all four wheels, one point per
 *  sample time. Grouped by `time_s` (not by array position) so it stays
 *  correct regardless of row order. */
function totalPowerByTime(history: TrailBrakingHistoryRow[]): { time_s: number; power_kw: number }[] {
  const byTime = new Map<number, number>();
  for (const r of history) byTime.set(r.time_s, (byTime.get(r.time_s) ?? 0) + r.brake_power_w);
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time_s, w]) => ({ time_s, power_kw: w / 1000 }));
}

function DeltaTable({ rows, keys }: { rows: { label: string; metrics: Record<string, number> }[]; keys: string[] }) {
  if (rows.length < 2) return null;
  const baseline = rows[0]!;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            {rows.map((r) => (
              <th key={r.label}>{r.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key}>
              <td>{key}</td>
              {rows.map((r, i) => {
                const value = r.metrics[key] ?? 0;
                const baseValue = baseline.metrics[key] ?? 0;
                const delta = value - baseValue;
                return (
                  <td className="num" key={r.label}>
                    {fmt(value, 2)}
                    {i > 0 && (
                      <span style={{ color: "var(--dim)" }}> ({delta >= 0 ? "+" : ""}{fmt(delta, 2)})</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Trail({ scenario, compared, comparing }: PageProps) {
  const [entrySpeedMps, setEntrySpeedMps] = useState(22.0);
  const [durationS, setDurationS] = useState(1.5);
  const [peakAxG, setPeakAxG] = useState(1.4);
  const [peakAyG, setPeakAyG] = useState(1.4);
  const [peakSteerDeg, setPeakSteerDeg] = useState(10.0);
  const [tab, setTab] = useState<"history" | "energy" | "raw">("history");

  const scenarios = comparing ? compared : [scenario];

  const profile = useMemo(
    () => makeLinearTrailProfile(entrySpeedMps, durationS, peakAxG, peakAyG, POINTS, peakSteerDeg),
    [entrySpeedMps, durationS, peakAxG, peakAyG, peakSteerDeg],
  );

  const perScenario: TrailRun[] = useMemo(() => {
    const baseCase = (driverMassKg: number): CombinedBrakingCase => ({
      driver_mass_kg: driverMassKg,
      longitudinal_accel_g: 0.0,
      lateral_accel_g: 0.0,
      tire_mu: FLAT_MU_FALLBACK,
      tire: TIRE,
      suspension: SUSPENSION,
    });
    return scenarios.map((s) => {
      const [history, summary] = evaluateTrailBraking(
        s.vehicle,
        s.brakes,
        baseCase(s.conditions.driver_mass_kg),
        profile,
      );
      return { scenario: s, label: scenarioLabel(s), history, summary };
    });
  }, [scenarios, profile]);

  // comparedScenarios() always puts the active scenario first.
  const active = perScenario[0]!;
  const summary = active.summary;

  return (
    <div>
      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Stability</div>
          <div className={`metric-value${summary.stable ? " ok" : " bad"}`}>
            {summary.stable ? "stable" : "REAR LOCK RISK"}
          </div>
          <div className="metric-delta">inside rear: {summary.inside_rear_wheel}</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Min Inside-Rear Lock Margin</div>
          <div className={`metric-value num${summary.min_inside_rear_lock_margin_n < 0 ? " bad" : ""}`}>
            {fmt(summary.min_inside_rear_lock_margin_n, 0)} N
          </div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Peak Combined Utilization</div>
          <div className={`metric-value num${summary.peak_combined_utilization > 1 ? " bad" : ""}`}>
            {fmt(summary.peak_combined_utilization, 2)}
          </div>
        </div>
        <div className="panel metric">
          <div className="metric-label">First Lock</div>
          <div className="metric-value num">
            {summary.first_lock_time_s == null ? "none" : `${fmt(summary.first_lock_time_s, 2)} s`}
          </div>
          <div className="metric-delta">{summary.first_lock_wheel ?? ""}</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Recommended Front Bias</div>
          <div className="metric-value num">
            {Number.isNaN(summary.recommended_front_brake_fraction)
              ? "n/a"
              : `${fmt(summary.recommended_front_brake_fraction * 100, 1)} %`}
          </div>
          <div className="metric-delta">decel-weighted ideal</div>
        </div>
      </div>

      {comparing && (
        <>
          <h3>Scenario comparison</h3>
          <DeltaTable
            rows={perScenario.map((ps) => ({
              label: ps.label,
              metrics: {
                "Min inside-rear lock margin (N)": ps.summary.min_inside_rear_lock_margin_n,
                "Peak combined utilization": ps.summary.peak_combined_utilization,
                "Recommended front bias": ps.summary.recommended_front_brake_fraction,
              },
            }))}
            keys={["Min inside-rear lock margin (N)", "Peak combined utilization", "Recommended front bias"]}
          />
        </>
      )}

      <div className="controls">
        <div className="field">
          <label htmlFor="trail-entry-speed">Entry speed, m/s</label>
          <input
            id="trail-entry-speed"
            type="number"
            step={0.5}
            value={entrySpeedMps}
            onChange={(e) => setEntrySpeedMps(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="trail-duration">Entry duration, s</label>
          <input
            id="trail-duration"
            type="number"
            step={0.1}
            value={durationS}
            onChange={(e) => setDurationS(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="trail-peak-ax">Peak braking, g</label>
          <input
            id="trail-peak-ax"
            type="number"
            step={0.05}
            value={peakAxG}
            onChange={(e) => setPeakAxG(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="trail-peak-ay">Peak lateral at apex, g</label>
          <input
            id="trail-peak-ay"
            type="number"
            step={0.05}
            value={peakAyG}
            onChange={(e) => setPeakAyG(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="trail-peak-steer">Peak steering angle, deg</label>
          <input
            id="trail-peak-steer"
            type="number"
            step={0.5}
            value={peakSteerDeg}
            onChange={(e) => setPeakSteerDeg(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="tabs">
        <button className={`tab${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
          Time History
        </button>
        <button className={`tab${tab === "energy" ? " active" : ""}`} onClick={() => setTab("energy")}>
          Wheel Energy
        </button>
        <button className={`tab${tab === "raw" ? " active" : ""}`} onClick={() => setTab("raw")}>
          Raw Data
        </button>
      </div>

      {tab === "history" && (
        <div className="charts two">
          <Chart
            title="Wheel Loads vs Time"
            data={
              comparing
                ? perScenario.map((ps, i) => {
                    const wheel = ps.summary.inside_rear_wheel;
                    const rows = seriesFor(ps, wheel);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.fz_n),
                      name: `${ps.label} (${wheel})`,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
                : WHEELS.map((w, i) => {
                    const rows = seriesFor(active, w);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.fz_n),
                      name: w,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
            }
            layout={{ xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Normal load (N)" } } }}
          />
          <Chart
            title="Lock Margin vs Time"
            data={
              comparing
                ? perScenario.map((ps, i) => {
                    const wheel = ps.summary.inside_rear_wheel;
                    const rows = seriesFor(ps, wheel);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.lock_margin_n),
                      name: `${ps.label} (${wheel})`,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
                : WHEELS.map((w, i) => {
                    const rows = seriesFor(active, w);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.lock_margin_n),
                      name: w,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
            }
            layout={{ xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Lock margin (N)" } } }}
          />
          <Chart
            title="Combined-Slip Utilization vs Time"
            data={
              comparing
                ? perScenario.map((ps, i) => {
                    const wheel = ps.summary.inside_rear_wheel;
                    const rows = seriesFor(ps, wheel);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.combined_utilization),
                      name: `${ps.label} (${wheel})`,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
                : WHEELS.map((w, i) => {
                    const rows = seriesFor(active, w);
                    return {
                      type: "scatter" as const,
                      mode: "lines" as const,
                      x: rows.map((r) => r.time_s),
                      y: rows.map((r) => r.combined_utilization),
                      name: w,
                      line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    };
                  })
            }
            layout={{ xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Utilization" } } }}
          />
          <Chart
            title="Integrated Speed Trace"
            data={perScenario.map((ps, i) => {
              // Speed does not vary by wheel, so any single wheel's rows give
              // one point per sample time -- computed from THIS scenario's own
              // history, never from a flattened cross-scenario array. The
              // Python page's speed-trace chart de-duplicated on time alone
              // (history.drop_duplicates(["time_s"])), which in compare mode
              // silently collapsed every scenario onto the first one's curve;
              // keying the source data by scenario like this avoids that bug
              // instead of trying to de-duplicate around it.
              const rows = seriesFor(ps, "FL");
              return {
                type: "scatter" as const,
                mode: "lines" as const,
                x: rows.map((r) => r.time_s),
                y: rows.map((r) => r.speed_mps),
                name: ps.label,
                line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
              };
            })}
            layout={{ xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Speed (m/s)" } } }}
          />
        </div>
      )}

      {tab === "energy" && (
        <>
          {(() => {
            const frontKj = ((summary.wheel_energy_j.FL ?? 0) + (summary.wheel_energy_j.FR ?? 0)) / 1000;
            const rearKj = ((summary.wheel_energy_j.RL ?? 0) + (summary.wheel_energy_j.RR ?? 0)) / 1000;
            const totalKj = frontKj + rearKj;
            return (
              <div className="metrics">
                <div className="panel metric">
                  <div className="metric-label">Total Energy (all brakes)</div>
                  <div className="metric-value num">{fmt(totalKj, 1)} kJ</div>
                </div>
                <div className="panel metric">
                  <div className="metric-label">Front Axle</div>
                  <div className="metric-value num">{fmt(frontKj, 1)} kJ</div>
                </div>
                <div className="panel metric">
                  <div className="metric-label">Rear Axle</div>
                  <div className="metric-value num">{fmt(rearKj, 1)} kJ</div>
                </div>
                <div className="panel metric">
                  <div className="metric-label">Front Share</div>
                  <div className="metric-value num">{totalKj > 0 ? `${fmt((100 * frontKj) / totalKj, 1)} %` : "n/a"}</div>
                </div>
              </div>
            );
          })()}
          <div className="charts two">
            <Chart
              title="Friction Energy per Wheel over Corner Entry"
              data={
                comparing
                  ? perScenario.map((ps, i) => ({
                      type: "bar",
                      x: [...WHEELS],
                      y: WHEELS.map((w) => (ps.summary.wheel_energy_j[w] ?? 0) / 1000),
                      name: ps.label,
                      marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                    }))
                  : [
                      {
                        type: "bar",
                        x: [...WHEELS],
                        y: WHEELS.map((w) => (active.summary.wheel_energy_j[w] ?? 0) / 1000),
                        marker: { color: WHEELS.map((_, i) => TRACE_COLORS[i % TRACE_COLORS.length]) },
                        showlegend: false,
                      },
                    ]
              }
              layout={{ xaxis: { title: { text: "Wheel" } }, yaxis: { title: { text: "Energy (kJ)" } } }}
            />
            <Chart
              title="Braking Power per Wheel vs Time"
              data={
                comparing
                  ? // One physical total per scenario rather than per-wheel: with
                    // four wheels already spread across the x-axis in the chart
                    // above, overlaying every (scenario x wheel) pair here would
                    // be unreadable, and total dissipation is what is actually
                    // comparable between candidate scenarios.
                    perScenario.map((ps, i) => {
                      const totals = totalPowerByTime(ps.history);
                      return {
                        type: "scatter" as const,
                        mode: "lines" as const,
                        x: totals.map((t) => t.time_s),
                        y: totals.map((t) => t.power_kw),
                        name: `${ps.label} (total)`,
                        line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                      };
                    })
                  : WHEELS.map((w, i) => {
                      const rows = seriesFor(active, w);
                      return {
                        type: "scatter" as const,
                        mode: "lines" as const,
                        x: rows.map((r) => r.time_s),
                        y: rows.map((r) => r.brake_power_w / 1000),
                        name: w,
                        line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                      };
                    })
              }
              layout={{ xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Power (kW)" } } }}
            />
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Wheel</th>
                  {comparing && <th>Scenario</th>}
                  <th>Energy (kJ)</th>
                </tr>
              </thead>
              <tbody>
                {perScenario.flatMap((ps) =>
                  WHEELS.map((w) => (
                    <tr key={`${ps.label}-${w}`}>
                      <td>{w}</td>
                      {comparing && <td>{ps.label}</td>}
                      <td className="num">{fmt((ps.summary.wheel_energy_j[w] ?? 0) / 1000, 2)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "raw" && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time (s)</th>
                <th>Wheel</th>
                {comparing && <th>Scenario</th>}
                <th>Speed (m/s)</th>
                <th>Fz (N)</th>
                <th>Utilization</th>
                <th>Lock margin (N)</th>
                <th>Locks predicted</th>
                <th>Power (W)</th>
              </tr>
            </thead>
            <tbody>
              {perScenario.flatMap((ps) =>
                ps.history.map((r, idx) => (
                  <tr key={`${ps.label}-${idx}`}>
                    <td className="num">{fmt(r.time_s, 3)}</td>
                    <td>{r.wheel}</td>
                    {comparing && <td>{ps.label}</td>}
                    <td className="num">{fmt(r.speed_mps, 2)}</td>
                    <td className="num">{fmt(r.fz_n, 1)}</td>
                    <td className="num">{fmt(r.combined_utilization, 3)}</td>
                    <td className="num">{fmt(r.lock_margin_n, 1)}</td>
                    <td>{r.locks_predicted ? "yes" : "no"}</td>
                    <td className="num">{fmt(r.brake_power_w, 0)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
