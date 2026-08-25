/** Curved Braking — steady-state combined longitudinal/lateral acceleration.
 *
 * One instant, four corners: given a braking-while-cornering state, how much
 * of each tire's friction ellipse is spent, and how much rotor torque margin
 * is left before that wheel locks. Ports app/pages/6_Curved_Braking.py.
 *
 * Inputs are local to this page (the braking/cornering state); driver mass is
 * the one quantity that comes from the shared conditions bar, because it
 * describes the car, not this analysis.
 */
import { useMemo, useState } from "react";
import type { PageProps } from "./registry.tsx";
import { Chart, TRACE_COLORS } from "../components/Chart.tsx";
import { scenarioLabel } from "../state/store.ts";
import type { Scenario } from "../state/store.ts";
import type { CombinedBrakingCase, CombinedBrakingRow } from "@core/solvers/combinedBraking.ts";
import { evaluateCombinedBraking } from "@core/solvers/combinedBraking.ts";
import type { LoadSensitiveTire } from "@core/models/tires.ts";
import type { SuspensionSetup } from "@core/models/suspension.ts";
import { mphToMps } from "@core/units.ts";

import tiresFile from "@data/tires/generic_load_sensitive_mu.json";
import suspensionFile from "@data/suspension/baseline_suspension.json";

// Same load-sensitive-mu and roll-stiffness data the Python page loads from
// data/tires and data/suspension. A page holds no configuration of its own,
// but this is baseline reference data, not user state, so it is a constant.
const TIRE = (tiresFile as unknown as { tires: LoadSensitiveTire[] }).tires[0]!;
const SUSPENSION = (suspensionFile as unknown as { suspension: SuspensionSetup }).suspension;

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const BAD = "#EF5350";
const GOLD = "#FFC627";

interface ScenarioRun {
  scenario: Scenario;
  label: string;
  rows: CombinedBrakingRow[];
}

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

/** Headline metrics per scenario, baseline plain + signed delta for the rest —
 *  mirrors app/compare.py's delta_table. */
function DeltaTable({ rows, keys }: { rows: { label: string; metrics: Record<string, number> }[]; keys: string[] }) {
  if (rows.length < 2) return null;
  const baseline = rows[0]!;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            {rows.map((r, i) => (
              <th key={r.label} colSpan={i === 0 ? 1 : 2}>
                {r.label}
              </th>
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
                  <>
                    <td className="num" key={`${r.label}-v`}>
                      {fmt(value, 1)}
                    </td>
                    {i > 0 && (
                      <td className="num" key={`${r.label}-d`}>
                        {delta >= 0 ? "+" : ""}
                        {fmt(delta, 1)}
                      </td>
                    )}
                  </>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Curved({ scenario, compared, comparing }: PageProps) {
  const [longG, setLongG] = useState(0.8);
  const [latG, setLatG] = useState(0.8);
  const [tireMu, setTireMu] = useState(1.6);
  const [steeringDeg, setSteeringDeg] = useState(8.0);
  const [frontSlipDeg, setFrontSlipDeg] = useState(4.0);
  const [rearSlipDeg, setRearSlipDeg] = useState(2.0);
  const [slipMuLoss, setSlipMuLoss] = useState(0.015);
  const [useLoadSensitiveTire, setUseLoadSensitiveTire] = useState(true);
  const [useSuspension, setUseSuspension] = useState(true);
  const [speedMph, setSpeedMph] = useState(40.0);

  const scenarios = comparing ? compared : [scenario];

  const perScenario: ScenarioRun[] = useMemo(() => {
    const case_ = (driverMassKg: number): CombinedBrakingCase => ({
      driver_mass_kg: driverMassKg,
      longitudinal_accel_g: longG,
      lateral_accel_g: latG,
      tire_mu: tireMu,
      steering_angle_deg: steeringDeg,
      front_slip_angle_deg: frontSlipDeg,
      rear_slip_angle_deg: rearSlipDeg,
      slip_mu_loss_per_deg: slipMuLoss,
      tire: useLoadSensitiveTire ? TIRE : null,
      suspension: useSuspension ? SUSPENSION : null,
    });
    return scenarios.map((s) => ({
      scenario: s,
      label: scenarioLabel(s),
      rows: evaluateCombinedBraking(s.vehicle, s.brakes, case_(s.conditions.driver_mass_kg)),
    }));
  }, [
    scenarios,
    longG,
    latG,
    tireMu,
    steeringDeg,
    frontSlipDeg,
    rearSlipDeg,
    slipMuLoss,
    useLoadSensitiveTire,
    useSuspension,
  ]);

  // comparedScenarios() always puts the active scenario first, so this is the
  // active-only slice used for the count/sum cards below (summing an
  // independent candidate scenario into another's total isn't physical).
  const active = perScenario[0]!;
  const allRows = useMemo(
    () => perScenario.flatMap((ps) => ps.rows.map((r) => ({ ...r, __scenario: ps.label }))),
    [perScenario],
  );

  const maxUtilization = Math.max(...allRows.map((r) => r.combined_utilization));
  const minLockMargin = Math.min(...allRows.map((r) => r.lock_margin_n));
  const lockedWheelCount = active.rows.filter((r) => r.locks_predicted).length;
  const rollingRadiusMm = scenario.vehicle.tire_rolling_radius_m * 1000;

  const speedMps = mphToMps(speedMph);

  // --- rotor torque: demand vs the lock-limited ceiling -------------------
  const frontTorqueMax = Math.max(
    ...allRows.filter((r) => r.wheel.startsWith("F")).map((r) => r.rotor_torque_demand_nm),
  );
  const rearTorqueMax = Math.max(
    ...allRows.filter((r) => r.wheel.startsWith("R")).map((r) => r.rotor_torque_demand_nm),
  );
  let worstMargin = Infinity;
  let worstMarginLabel = "";
  for (const r of allRows) {
    const margin = r.rotor_torque_available_nm - r.rotor_torque_demand_nm;
    if (margin < worstMargin) {
      worstMargin = margin;
      worstMarginLabel = comparing ? `${r.wheel} · ${r.__scenario}` : r.wheel;
    }
  }

  // --- rotor energy rate: power = tire-frame demand force x speed ---------
  const frontPowerKw = Math.max(
    ...allRows
      .filter((r) => r.wheel.startsWith("F"))
      .map((r) => (r.fx_tire_frame_demand_n * speedMps) / 1000),
  );
  const rearPowerKw = Math.max(
    ...allRows
      .filter((r) => r.wheel.startsWith("R"))
      .map((r) => (r.fx_tire_frame_demand_n * speedMps) / 1000),
  );
  const totalActivePowerKw = active.rows.reduce(
    (sum, r) => sum + (r.fx_tire_frame_demand_n * speedMps) / 1000,
    0,
  );
  const speedSweepMph = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];

  return (
    <div>
      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Max Utilization</div>
          <div className={`metric-value num${maxUtilization > 1 ? " bad" : ""}`}>
            {fmt(maxUtilization, 2)}
          </div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Min Lock Margin</div>
          <div className={`metric-value num${minLockMargin < 0 ? " bad" : ""}`}>
            {fmt(minLockMargin, 0)} N
          </div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Predicted Lock Wheels</div>
          <div className={`metric-value num${lockedWheelCount > 0 ? " warn" : " ok"}`}>
            {lockedWheelCount}
          </div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Tire Rolling Radius</div>
          <div className="metric-value num">{fmt(rollingRadiusMm, 0)} mm</div>
        </div>
      </div>

      {comparing && (
        <>
          <h3>Scenario comparison</h3>
          <DeltaTable
            rows={perScenario.map((ps) => {
              const metrics: Record<string, number> = {};
              for (const r of ps.rows) metrics[`Lock margin ${r.wheel} (N)`] = r.lock_margin_n;
              for (const r of ps.rows)
                metrics[`Rotor torque demand ${r.wheel} (N·m)`] = r.rotor_torque_demand_nm;
              return { label: ps.label, metrics };
            })}
            keys={[
              ...WHEELS.map((w) => `Lock margin ${w} (N)`),
              ...WHEELS.map((w) => `Rotor torque demand ${w} (N·m)`),
            ]}
          />
        </>
      )}

      <div className="controls">
        <div className="field">
          <label htmlFor="curved-long-g">Longitudinal braking, g</label>
          <input
            id="curved-long-g"
            type="number"
            step={0.05}
            value={longG}
            onChange={(e) => setLongG(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-lat-g">Lateral acceleration, g</label>
          <input
            id="curved-lat-g"
            type="number"
            step={0.05}
            value={latG}
            onChange={(e) => setLatG(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-speed">Speed, mph</label>
          <input
            id="curved-speed"
            type="number"
            step={5}
            value={speedMph}
            onChange={(e) => setSpeedMph(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-mu">Tire μ fallback</label>
          <input
            id="curved-mu"
            type="number"
            step={0.05}
            value={tireMu}
            onChange={(e) => setTireMu(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-steer">Front steering, deg</label>
          <input
            id="curved-steer"
            type="number"
            step={0.5}
            value={steeringDeg}
            onChange={(e) => setSteeringDeg(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-fslip">Front slip angle, deg</label>
          <input
            id="curved-fslip"
            type="number"
            step={0.5}
            value={frontSlipDeg}
            onChange={(e) => setFrontSlipDeg(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-rslip">Rear slip angle, deg</label>
          <input
            id="curved-rslip"
            type="number"
            step={0.5}
            value={rearSlipDeg}
            onChange={(e) => setRearSlipDeg(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-muloss">μ loss / slip deg</label>
          <input
            id="curved-muloss"
            type="number"
            step={0.001}
            value={slipMuLoss}
            onChange={(e) => setSlipMuLoss(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="curved-tire-toggle">Load-sensitive μ(Fz)</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="curved-tire-toggle"
              type="checkbox"
              checked={useLoadSensitiveTire}
              onChange={(e) => setUseLoadSensitiveTire(e.target.checked)}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--text)" }}>on</span>
          </label>
        </div>
        <div className="field">
          <label htmlFor="curved-susp-toggle">Roll-stiffness transfer</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="curved-susp-toggle"
              type="checkbox"
              checked={useSuspension}
              onChange={(e) => setUseSuspension(e.target.checked)}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--text)" }}>on</span>
          </label>
        </div>
      </div>

      <div className="charts two">
        <Chart
          title="Combined Slip Utilization"
          data={
            comparing
              ? perScenario.map((ps, i) => ({
                  type: "bar",
                  x: [...WHEELS],
                  y: WHEELS.map((w) => ps.rows.find((r) => r.wheel === w)?.combined_utilization ?? 0),
                  name: ps.label,
                  marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                }))
              : [
                  {
                    type: "bar",
                    x: [...WHEELS],
                    y: WHEELS.map((w) => active.rows.find((r) => r.wheel === w)?.combined_utilization ?? 0),
                    marker: {
                      color: WHEELS.map((w) => (active.rows.find((r) => r.wheel === w)?.locks_predicted ? BAD : GOLD)),
                    },
                    showlegend: false,
                  },
                ]
          }
          layout={{ xaxis: { title: { text: "Wheel" } }, yaxis: { title: { text: "Utilization" } } }}
        />
        <Chart
          title="Longitudinal Lock Margin"
          data={
            comparing
              ? perScenario.map((ps, i) => ({
                  type: "bar",
                  x: [...WHEELS],
                  y: WHEELS.map((w) => ps.rows.find((r) => r.wheel === w)?.lock_margin_n ?? 0),
                  name: ps.label,
                  marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                }))
              : [
                  {
                    type: "bar",
                    x: [...WHEELS],
                    y: WHEELS.map((w) => active.rows.find((r) => r.wheel === w)?.lock_margin_n ?? 0),
                    marker: {
                      color: WHEELS.map((w) => (active.rows.find((r) => r.wheel === w)?.locks_predicted ? BAD : GOLD)),
                    },
                    showlegend: false,
                  },
                ]
          }
          layout={{ xaxis: { title: { text: "Wheel" } }, yaxis: { title: { text: "Lock margin (N)" } } }}
        />
      </div>

      <h2 style={{ marginTop: 22 }}>Rotor Torque</h2>
      <p className="note">
        Per-wheel brake torque for this combined case: the tire-frame longitudinal demand (brake
        share of the deceleration, projected through the steering angle) reacted at the tire
        rolling radius. Available torque is the lock-limited ceiling from the remaining
        longitudinal grip after the lateral demand is taken out of the friction ellipse.
      </p>
      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Max Front Rotor Torque</div>
          <div className="metric-value num">{fmt(frontTorqueMax, 0)} N·m</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Max Rear Rotor Torque</div>
          <div className="metric-value num">{fmt(rearTorqueMax, 0)} N·m</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Min Torque Margin to Lock</div>
          <div className={`metric-value num${worstMargin < 0 ? " bad" : ""}`}>{fmt(worstMargin, 0)} N·m</div>
          <div className="metric-delta">{worstMarginLabel}</div>
        </div>
      </div>
      <div className="charts two">
        <Chart
          title="Rotor Torque Demand vs Lock-Limited Available"
          data={perScenario.flatMap((ps, i) => {
            const color = TRACE_COLORS[i % TRACE_COLORS.length];
            const suffix = comparing ? ` · ${ps.label}` : "";
            return [
              {
                type: "bar" as const,
                x: [...WHEELS],
                y: WHEELS.map((w) => ps.rows.find((r) => r.wheel === w)?.rotor_torque_demand_nm ?? 0),
                name: `Demand${suffix}`,
                marker: { color },
              },
              {
                type: "bar" as const,
                x: [...WHEELS],
                y: WHEELS.map((w) => ps.rows.find((r) => r.wheel === w)?.rotor_torque_available_nm ?? 0),
                name: `Available${suffix}`,
                marker: { color, opacity: 0.4 },
              },
            ];
          })}
          layout={{
            barmode: "group",
            xaxis: { title: { text: "Wheel" } },
            yaxis: { title: { text: "Rotor torque (N·m)" } },
          }}
        />
        <Chart
          title="Rotor Torque Margin to Lock"
          data={
            comparing
              ? perScenario.map((ps, i) => ({
                  type: "bar",
                  x: [...WHEELS],
                  y: WHEELS.map((w) => {
                    const row = ps.rows.find((r) => r.wheel === w);
                    return row ? row.rotor_torque_available_nm - row.rotor_torque_demand_nm : 0;
                  }),
                  name: ps.label,
                  marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                }))
              : [
                  {
                    type: "bar",
                    x: [...WHEELS],
                    y: WHEELS.map((w) => {
                      const row = active.rows.find((r) => r.wheel === w);
                      return row ? row.rotor_torque_available_nm - row.rotor_torque_demand_nm : 0;
                    }),
                    marker: {
                      color: WHEELS.map((w) => (active.rows.find((r) => r.wheel === w)?.locks_predicted ? BAD : GOLD)),
                    },
                    showlegend: false,
                  },
                ]
          }
          layout={{ xaxis: { title: { text: "Wheel" } }, yaxis: { title: { text: "Torque margin (N·m)" } } }}
        />
      </div>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Wheel</th>
              {comparing && <th>Scenario</th>}
              <th>Torque demand (N·m)</th>
              <th>Available before lock (N·m)</th>
              <th>Margin (N·m)</th>
              <th>Lock predicted</th>
            </tr>
          </thead>
          <tbody>
            {perScenario.flatMap((ps) =>
              ps.rows.map((r) => (
                <tr key={`${ps.label}-${r.wheel}`}>
                  <td>{r.wheel}</td>
                  {comparing && <td>{ps.label}</td>}
                  <td className="num">{fmt(r.rotor_torque_demand_nm, 1)}</td>
                  <td className="num">{fmt(r.rotor_torque_available_nm, 1)}</td>
                  <td className="num">{fmt(r.rotor_torque_available_nm - r.rotor_torque_demand_nm, 1)}</td>
                  <td>{r.locks_predicted ? "yes" : "no"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 22 }}>Rotor Energy Rate (Braking Power)</h2>
      <p className="note">
        A curved-braking screen is one instant, so it has a power, not an energy: each rotor
        absorbs its tire-frame braking force times car speed. The full-stop energy picture lives
        on Straight-Line Braking; the corner-entry time integral lives on Trail Braking.
      </p>
      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Max Front Rotor Power</div>
          <div className="metric-value num">{fmt(frontPowerKw, 1)} kW</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Max Rear Rotor Power</div>
          <div className="metric-value num">{fmt(rearPowerKw, 1)} kW</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Total Braking Power</div>
          <div className="metric-value num">{fmt(totalActivePowerKw, 1)} kW</div>
        </div>
      </div>
      <div className="charts two">
        <Chart
          title={`Braking Power per Rotor at ${speedMph} mph`}
          data={
            comparing
              ? perScenario.map((ps, i) => ({
                  type: "bar",
                  x: [...WHEELS],
                  y: WHEELS.map(
                    (w) =>
                      ((ps.rows.find((r) => r.wheel === w)?.fx_tire_frame_demand_n ?? 0) * speedMps) / 1000,
                  ),
                  name: ps.label,
                  marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
                }))
              : [
                  {
                    type: "bar",
                    x: [...WHEELS],
                    y: WHEELS.map(
                      (w) =>
                        ((active.rows.find((r) => r.wheel === w)?.fx_tire_frame_demand_n ?? 0) * speedMps) /
                        1000,
                    ),
                    marker: { color: WHEELS.map((_, i) => TRACE_COLORS[i % TRACE_COLORS.length]) },
                    showlegend: false,
                  },
                ]
          }
          layout={{ xaxis: { title: { text: "Wheel" } }, yaxis: { title: { text: "Power (kW)" } } }}
        />
        <Chart
          title="Braking Power per Rotor vs Speed (this combined state, active scenario)"
          data={WHEELS.map((w, i) => {
            const row = active.rows.find((r) => r.wheel === w);
            const demand = row?.fx_tire_frame_demand_n ?? 0;
            return {
              type: "scatter" as const,
              mode: "lines" as const,
              x: speedSweepMph,
              y: speedSweepMph.map((s) => (demand * mphToMps(s)) / 1000),
              name: w,
              line: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
            };
          })}
          layout={{ xaxis: { title: { text: "Speed (mph)" } }, yaxis: { title: { text: "Power (kW)" } } }}
        />
      </div>
    </div>
  );
}
