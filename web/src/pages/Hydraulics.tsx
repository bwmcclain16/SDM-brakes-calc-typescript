/** Hydraulics & Fluid.
 *
 * Dual master-cylinder line pressures, caliper area adequacy, rotor energy and
 * power from pedal force, pedal travel compliance, and fluid boiling margins.
 *
 * Two page-local design points, deliberately NOT shared with the rest of the
 * app:
 *   - "Sizing deceleration, g" defaults to 1.8 -- higher than the shared
 *     nominal target deceleration (1.3 g) on purpose. It is what the caliper
 *     area and line pressure are SIZED against; the shared target is used
 *     elsewhere (straight-line braking) for the nominal stop.
 *   - Pedal FORCE, by contrast, is the shared scenario value
 *     (`scenario.conditions.pedal_force_n`, ~418 N) -- there is only one
 *     design pedal force, set once in the conditions bar.
 */
import { useMemo, useState } from "react";
import type { PageProps } from "./registry.tsx";
import { Chart } from "../components/Chart.tsx";
import type { Scenario } from "../state/store.ts";
import { scenarioLabel } from "../state/store.ts";

import type { AxleBrake } from "@core/models/internal.ts";
import type { BrakeFluid } from "@core/models/fluid.ts";
import { G } from "@core/constants.ts";
import { axleBrakeTorqueFromPedalNm, linePressuresPa } from "@core/solvers/hydraulics.ts";
import {
  caliperAreaCheck,
  linePressureSafetyFactor,
  requiredAxleTorqueNm,
} from "@core/solvers/sizing.ts";
import { pedalTravel } from "@core/solvers/pedal.ts";
import { rankFluidsByWetMargin } from "@core/solvers/fluid.ts";
import { frontAxleTorqueDistribution, rearAxleTorqueDistribution } from "@core/solvers/brakeBias.ts";
import { totalMassKg } from "@core/solvers/vehicle.ts";

import fluidsData from "@data/materials/brake_fluids.json";

import type Plotly from "plotly.js-dist-min";

type Trace = Partial<Plotly.PlotData>;

const LBF_TO_N = 4.4482216153;

// --- fluid data (JSON keys are lower_snake_case already, but bulk_modulus_pa
// is stored as a scientific-notation STRING to survive JSON round-tripping
// without precision loss -- convert it here, once). --------------------------

interface FluidRaw {
  name: string;
  manufacturer?: string | null;
  dot_rating?: string | null;
  dry_boiling_point_c: number;
  wet_boiling_point_c: number | null;
  bulk_modulus_pa?: string | number | null;
  density_kg_m3?: number | null;
  base_fluid?: boolean;
}

const FLUIDS: BrakeFluid[] = (fluidsData as unknown as { fluids: FluidRaw[] }).fluids.map((f) => ({
  name: f.name,
  dry_boiling_point_c: f.dry_boiling_point_c,
  wet_boiling_point_c: f.wet_boiling_point_c ?? null,
  bulk_modulus_pa: f.bulk_modulus_pa != null ? Number(f.bulk_modulus_pa) : null,
  density_kg_m3: f.density_kg_m3 ?? null,
  manufacturer: f.manufacturer ?? null,
  dot_rating: f.dot_rating ?? null,
  base_fluid: f.base_fluid ?? false,
}));

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pad-swept friction-band area on ONE face, mirroring the Python page's
 * `_band_area_per_face_m2` -- falls back to the rotor OD / pad height when
 * the swept-band diameters aren't given. */
function bandAreaPerFaceM2(axle: AxleBrake): number {
  const odMm = axle.pad_swept_outer_diameter_mm ?? axle.rotor_outer_diameter_mm;
  const idMm = axle.pad_swept_inner_diameter_mm ?? axle.rotor_outer_diameter_mm - 2.0 * axle.pad_height_mm;
  return (Math.PI / 4.0) * ((odMm / 1000.0) ** 2 - (idMm / 1000.0) ** 2);
}

type Application = "Full stop" | "Hold for fixed time";

interface RotorEnergyResult {
  front_rotor_energy_j: number;
  rear_rotor_energy_j: number;
  decel_g: number;
  stop_time_s: number;
  stop_distance_m: number;
  front_peak_power_w: number;
  front_axle_nm: number;
  rear_axle_nm: number;
}

/** Energy/power into each rotor for one stop scenario at a pedal force.
 * Capacity torque -> total brake force at the tires -> commanded
 * deceleration; energy into one rotor is that wheel's brake force times the
 * distance braked. Mirrors the Python page's `_rotor_energy_from_pedal`. */
function rotorEnergyFromPedal(
  pedalN: number,
  v0: number,
  brakes: Scenario["brakes"],
  totalMassKgValue: number,
  rTireM: number,
  application: Application,
  holdTimeS: number,
): RotorEnergyResult {
  const frontAxle = axleBrakeTorqueFromPedalNm(pedalN, brakes, "front");
  const rearAxle = axleBrakeTorqueFromPedalNm(pedalN, brakes, "rear");
  const frontWheelForce = frontAxle / 2.0 / rTireM;
  const rearWheelForce = rearAxle / 2.0 / rTireM;
  const totalForce = 2.0 * frontWheelForce + 2.0 * rearWheelForce;

  if (totalForce <= 0.0 || v0 <= 0.0) {
    return {
      front_rotor_energy_j: 0,
      rear_rotor_energy_j: 0,
      decel_g: 0,
      stop_time_s: 0,
      stop_distance_m: 0,
      front_peak_power_w: 0,
      front_axle_nm: frontAxle,
      rear_axle_nm: rearAxle,
    };
  }

  const accel = totalForce / totalMassKgValue;
  const stopTime = v0 / accel;
  let distance: number;
  if (application === "Full stop") {
    distance = v0 ** 2 / (2.0 * accel);
  } else {
    const duration = Math.min(holdTimeS, stopTime);
    distance = v0 * duration - 0.5 * accel * duration ** 2;
  }

  return {
    front_rotor_energy_j: frontWheelForce * distance,
    rear_rotor_energy_j: rearWheelForce * distance,
    decel_g: accel / G,
    stop_time_s: stopTime,
    stop_distance_m: distance,
    front_peak_power_w: frontWheelForce * v0,
    front_axle_nm: frontAxle,
    rear_axle_nm: rearAxle,
  };
}

/** 40-point pedal-force grid (5%-200% of that scenario's own design pedal
 * force) with the rotor-energy result at each point. */
function energySweep(
  s: Scenario,
  v0: number,
  application: Application,
  holdTimeS: number,
): Array<RotorEnergyResult & { pedal_force_n: number }> {
  const totalMass = totalMassKg(s.vehicle, s.conditions.driver_mass_kg);
  const rTire = s.vehicle.tire_rolling_radius_m;
  const pf = s.conditions.pedal_force_n;
  return Array.from({ length: 40 }, (_, i) => pf * ((i + 1) / 20)).map((p) => ({
    ...rotorEnergyFromPedal(p, v0, s.brakes, totalMass, rTire, application, holdTimeS),
    pedal_force_n: p,
  }));
}

// --- per-scenario hydraulics bundle (line pressure/SF, caliper area, pedal
// travel) -- computed once per compared scenario so every section below
// (headline metrics, tables, comparison table) reads from the same numbers.

interface AreaRow {
  axle: "front" | "rear";
  row: ReturnType<typeof caliperAreaCheck> | null;
  error: string | null;
}

interface TravelRow {
  axle: "front" | "rear";
  row: ReturnType<typeof pedalTravel> | null;
  error: string | null;
}

interface HydraulicsResult {
  scenario: Scenario;
  frontPressurePa: number;
  rearPressurePa: number;
  safetyFactor: ReturnType<typeof linePressureSafetyFactor> | null;
  safetyFactorError: string | null;
  areaRows: AreaRow[];
  travelRows: TravelRow[];
}

function computeHydraulics(
  s: Scenario,
  sizingDecelG: number,
  padTempC: number,
  fluid: BrakeFluid | undefined,
  circuitMl: number,
  lineCompliance: number,
): HydraulicsResult {
  const totalMass = totalMassKg(s.vehicle, s.conditions.driver_mass_kg);
  const frontDist = frontAxleTorqueDistribution(s.brakes);
  const rearDist = rearAxleTorqueDistribution(s.brakes);
  const frontT = requiredAxleTorqueNm(totalMass, sizingDecelG, s.vehicle.tire_rolling_radius_m, frontDist);
  const rearT = requiredAxleTorqueNm(totalMass, sizingDecelG, s.vehicle.tire_rolling_radius_m, rearDist);
  const [frontPressurePa, rearPressurePa] = linePressuresPa(s.conditions.pedal_force_n, s.brakes);

  let safetyFactor: ReturnType<typeof linePressureSafetyFactor> | null = null;
  let safetyFactorError: string | null = null;
  try {
    safetyFactor = linePressureSafetyFactor(s.brakes, s.conditions.pedal_force_n);
  } catch (e) {
    safetyFactorError = errorMessage(e);
  }

  const areaRows: AreaRow[] = (["front", "rear"] as const).map((axle) => {
    const T = axle === "front" ? frontT : rearT;
    try {
      return { axle, row: caliperAreaCheck(s.brakes, axle, T, s.conditions.pedal_force_n, padTempC), error: null };
    } catch (e) {
      return { axle, row: null, error: errorMessage(e) };
    }
  });

  const travelRows: TravelRow[] = (["front", "rear"] as const).map((axle) => {
    if (!fluid) return { axle, row: null, error: "no fluid selected" };
    try {
      return {
        axle,
        row: pedalTravel(s.brakes, axle, s.conditions.pedal_force_n, fluid, circuitMl, lineCompliance),
        error: null,
      };
    } catch (e) {
      return { axle, row: null, error: errorMessage(e) };
    }
  });

  return { scenario: s, frontPressurePa, rearPressurePa, safetyFactor, safetyFactorError, areaRows, travelRows };
}

function NumberField({
  label,
  value,
  onChange,
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div>
      <label>{label}</label>
      <input
        type="number"
        autoComplete="off"
        value={value}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

const mpa = (pa: number): string => (pa / 1e6).toFixed(2);
const psi = (pa: number): string => (pa / 6894.757).toFixed(0);

export function Hydraulics({ scenario, compared, comparing }: PageProps) {
  const [sizingDecelG, setSizingDecelG] = useState(1.8);
  const [padTempC, setPadTempC] = useState(300);
  const [fluidName, setFluidName] = useState(FLUIDS[0]?.name ?? "");
  const [circuitMl, setCircuitMl] = useState(() => (scenario.brakes.system_fluid_volume_ml ?? 500.0) / 2.0);
  const [lineCompliance, setLineCompliance] = useState(0.0);
  const [initSpeedMps, setInitSpeedMps] = useState(30.0);
  const [application, setApplication] = useState<Application>("Full stop");
  const [holdTimeS, setHoldTimeS] = useState(2.0);

  const selectedFluid = FLUIDS.find((f) => f.name === fluidName) ?? FLUIDS[0];
  const pedalForceN = scenario.conditions.pedal_force_n;

  const primary = useMemo(
    () => computeHydraulics(scenario, sizingDecelG, padTempC, selectedFluid, circuitMl, lineCompliance),
    [scenario, sizingDecelG, padTempC, selectedFluid, circuitMl, lineCompliance],
  );
  const results = useMemo(
    () => compared.map((s) => computeHydraulics(s, sizingDecelG, padTempC, selectedFluid, circuitMl, lineCompliance)),
    [compared, sizingDecelG, padTempC, selectedFluid, circuitMl, lineCompliance],
  );

  const totalMass = totalMassKg(scenario.vehicle, scenario.conditions.driver_mass_kg);
  const rTire = scenario.vehicle.tire_rolling_radius_m;
  const now = rotorEnergyFromPedal(pedalForceN, initSpeedMps, scenario.brakes, totalMass, rTire, application, holdTimeS);
  const frontBandM2 = bandAreaPerFaceM2(scenario.brakes.front);
  const frontPeakFluxMwM2 = now.front_peak_power_w / (2.0 * frontBandM2) / 1e6;

  const energyTraces: Trace[] = compared.flatMap((s) => {
    const rows = energySweep(s, initSpeedMps, application, holdTimeS);
    const suffix = comparing ? ` — ${scenarioLabel(s)}` : "";
    return [
      {
        x: rows.map((r) => r.pedal_force_n),
        y: rows.map((r) => r.front_rotor_energy_j / 1000.0),
        type: "scatter",
        mode: "lines",
        name: `Front${suffix}`,
      },
      {
        x: rows.map((r) => r.pedal_force_n),
        y: rows.map((r) => r.rear_rotor_energy_j / 1000.0),
        type: "scatter",
        mode: "lines",
        name: `Rear${suffix}`,
      },
    ];
  });

  const powerTraces: Trace[] = compared.map((s) => {
    const rows = energySweep(s, initSpeedMps, application, holdTimeS);
    return {
      x: rows.map((r) => r.pedal_force_n),
      y: rows.map((r) => r.front_peak_power_w / 1000.0),
      type: "scatter",
      mode: "lines",
      name: comparing ? scenarioLabel(s) : "Front rotor peak power",
    };
  });

  const currentLineShape: Partial<Plotly.Shape> = {
    type: "line",
    xref: "x",
    yref: "paper",
    x0: pedalForceN,
    x1: pedalForceN,
    y0: 0,
    y1: 1,
    line: { color: "#5a5f66", width: 1, dash: "dot" },
  };

  const fluidMargins = rankFluidsByWetMargin(FLUIDS, padTempC);

  return (
    <div>
      <div className="panel" style={{ padding: 14, marginBottom: 18 }}>
        <h3 style={{ marginBottom: 10 }}>Design Point</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Design pedal force (shared): {pedalForceN.toFixed(1)} N = {(pedalForceN / LBF_TO_N).toFixed(1)} lbf. Set
          in the conditions bar above -- this page only reads it.
        </p>
        <div className="controls">
          <NumberField label="Sizing deceleration, g" value={sizingDecelG} step={0.05} onChange={setSizingDecelG} />
          <NumberField label="Pad/rotor operating temp, °C" value={padTempC} step={10} onChange={setPadTempC} />
          <div>
            <label htmlFor="hyd-fluid">Brake fluid</label>
            <select id="hyd-fluid" autoComplete="off" value={fluidName} onChange={(e) => setFluidName(e.target.value)}>
              {FLUIDS.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <NumberField label="Fluid volume per circuit, mL" value={circuitMl} step={10} onChange={setCircuitMl} />
          <NumberField
            label="Line compliance, m³/Pa (0 = rigid)"
            value={lineCompliance}
            step={1e-13}
            onChange={setLineCompliance}
          />
        </div>
        <p className="note">
          Sizing deceleration is page-local and intentionally higher than the shared target deceleration
          ({scenario.conditions.target_deceleration_g.toFixed(2)} g) -- it is the worst-case point the caliper area
          and line pressure are sized for, not the nominal stop.
        </p>
      </div>

      <h3>Line Pressure &amp; Safety Factor</h3>
      {primary.safetyFactorError ? (
        <p className="metric-value bad">Needs input: {primary.safetyFactorError}</p>
      ) : (
        <div className="metrics">
          <div className="panel metric">
            <div className="metric-label">Front circuit</div>
            <div className="metric-value num">{mpa(primary.frontPressurePa)} MPa</div>
            <div className="metric-delta num">{psi(primary.frontPressurePa)} psi</div>
          </div>
          <div className="panel metric">
            <div className="metric-label">Rear circuit</div>
            <div className="metric-value num">{mpa(primary.rearPressurePa)} MPa</div>
            <div className="metric-delta num">{psi(primary.rearPressurePa)} psi</div>
          </div>
          <div className="panel metric">
            <div className="metric-label">Rated ceiling</div>
            <div className="metric-value num">{mpa(primary.safetyFactor!.rated_pressure_pa)} MPa</div>
          </div>
          <div className="panel metric">
            <div className={`metric-value num ${primary.safetyFactor!.within_limit ? "ok" : "bad"}`}>
              {primary.safetyFactor!.safety_factor.toFixed(2)}
            </div>
            <div className="metric-label" style={{ marginTop: 0 }}>
              Safety factor
            </div>
            <div className="metric-delta">{primary.safetyFactor!.within_limit ? "within limit" : "OVER LIMIT"}</div>
          </div>
        </div>
      )}

      <h3>Caliper Area Adequacy</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              {comparing && <th>Scenario</th>}
              <th>Axle</th>
              <th>Required torque, N·m</th>
              <th>Circuit pressure, MPa</th>
              <th>Required area, mm²</th>
              <th>Actual area, mm²</th>
              <th>Margin (actual/req)</th>
              <th>Adequate</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) =>
              r.areaRows.map((a) => (
                <tr key={`${r.scenario.id}-${a.axle}`}>
                  {comparing && <td>{scenarioLabel(r.scenario)}</td>}
                  <td>{a.axle}</td>
                  {a.row ? (
                    <>
                      <td className="num">{a.row.target_axle_torque_nm.toFixed(1)}</td>
                      <td className="num">{mpa(a.row.circuit_pressure_pa)}</td>
                      <td className="num">{a.row.required_active_area_mm2.toFixed(1)}</td>
                      <td className="num">{a.row.actual_active_area_mm2.toFixed(1)}</td>
                      <td className="num">{a.row.area_margin_ratio.toFixed(2)}</td>
                      <td className={a.row.adequate ? "ok" : "bad"}>{a.row.adequate ? "yes" : "NO"}</td>
                    </>
                  ) : (
                    <td colSpan={6}>needs input: {a.error}</td>
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18 }}>Rotor Energy &amp; Power from Pedal Force</h3>
      <p className="note" style={{ marginTop: 0 }}>
        The pedal force sets brake torque (capacity); how much energy lands in each rotor depends on the stop. For a
        full stop the total is fixed by kinetic energy (pressing harder just makes the stop shorter and hotter); for
        a fixed hold time it grows with pedal force. Pedal force directly drives power (heat rate) and peak flux.
      </p>
      <div className="controls">
        <NumberField label="Initial speed, m/s" value={initSpeedMps} step={1} onChange={setInitSpeedMps} />
        <div>
          <label htmlFor="hyd-application">Brake application</label>
          <select
            id="hyd-application"
            autoComplete="off"
            value={application}
            onChange={(e) => setApplication(e.target.value as Application)}
          >
            <option value="Full stop">Full stop</option>
            <option value="Hold for fixed time">Hold for fixed time</option>
          </select>
        </div>
        <NumberField
          label="Hold time, s"
          value={holdTimeS}
          step={0.5}
          onChange={setHoldTimeS}
          disabled={application === "Full stop"}
        />
      </div>

      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Front rotor torque</div>
          <div className="metric-value num">{(now.front_axle_nm / 2.0).toFixed(0)} N·m</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Commanded deceleration</div>
          <div className="metric-value num">{now.decel_g.toFixed(2)} g</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Energy into front rotor</div>
          <div className="metric-value num">{(now.front_rotor_energy_j / 1000.0).toFixed(1)} kJ</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Front rotor peak power</div>
          <div className="metric-value num">{(now.front_peak_power_w / 1000.0).toFixed(1)} kW</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Front rotor peak flux</div>
          <div className="metric-value num">{frontPeakFluxMwM2.toFixed(2)} MW/m²</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Energy into rear rotor</div>
          <div className="metric-value num">{(now.rear_rotor_energy_j / 1000.0).toFixed(1)} kJ</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Stopping time</div>
          <div className="metric-value num">{now.stop_time_s.toFixed(2)} s</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Braking distance</div>
          <div className="metric-value num">{now.stop_distance_m.toFixed(1)} m</div>
        </div>
      </div>

      <div className="charts two">
        <Chart
          title={`Rotor Energy vs Pedal Force (${application.toLowerCase()}, ${initSpeedMps.toFixed(0)} m/s)`}
          data={energyTraces}
          layout={{
            xaxis: { title: { text: "Pedal force (N)" } },
            yaxis: { title: { text: "Energy per rotor (kJ)" } },
            shapes: [currentLineShape],
          }}
        />
        <Chart
          title="Front Rotor Peak Power vs Pedal Force"
          data={powerTraces}
          layout={{
            xaxis: { title: { text: "Pedal force (N)" } },
            yaxis: { title: { text: "Peak power per rotor (kW)" } },
            shapes: [currentLineShape],
          }}
        />
      </div>

      <h3 style={{ marginTop: 18 }}>Pedal Travel (Compliance)</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              {comparing && <th>Scenario</th>}
              <th>Axle</th>
              <th>Fluid ΔV, mL</th>
              <th>Caliper ΔV, mL</th>
              <th>Line ΔV, mL</th>
              <th>MC stroke, mm</th>
              <th>Pedal travel, °</th>
              <th>Limit, °</th>
              <th>Within limit</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) =>
              r.travelRows.map((t) => (
                <tr key={`${r.scenario.id}-${t.axle}`}>
                  {comparing && <td>{scenarioLabel(r.scenario)}</td>}
                  <td>{t.axle}</td>
                  {t.row ? (
                    <>
                      <td className="num">{(t.row.fluid_displaced_volume_m3 * 1e6).toFixed(3)}</td>
                      <td className="num">{(t.row.caliper_displaced_volume_m3 * 1e6).toFixed(3)}</td>
                      <td className="num">{(t.row.line_displaced_volume_m3 * 1e6).toFixed(3)}</td>
                      <td className="num">{(t.row.master_cylinder_stroke_m * 1e3).toFixed(2)}</td>
                      <td className="num">{t.row.pedal_travel_deg.toFixed(2)}</td>
                      <td className="num">{t.row.max_pedal_travel_deg}</td>
                      <td className={t.row.within_limit ? "ok" : "bad"}>{t.row.within_limit ? "yes" : "NO"}</td>
                    </>
                  ) : (
                    <td colSpan={7}>needs input: {t.error}</td>
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18 }}>Fluid Boiling Margins</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Ranked by governing wet margin at {padTempC.toFixed(0)} °C operating temperature.
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Fluid</th>
              <th>Dry BP, °C</th>
              <th>Wet BP, °C</th>
              <th>Dry margin, °C</th>
              <th>Wet margin, °C</th>
              <th>Acceptable</th>
            </tr>
          </thead>
          <tbody>
            {fluidMargins.map((m) => (
              <tr key={m.fluid_name}>
                <td>{m.fluid_name}</td>
                <td className="num">{m.dry_boiling_point_c.toFixed(0)}</td>
                <td className="num">{m.wet_boiling_point_c != null ? m.wet_boiling_point_c.toFixed(0) : "—"}</td>
                <td className="num">{m.dry_margin_c.toFixed(1)}</td>
                <td className="num">{m.wet_margin_c != null ? m.wet_margin_c.toFixed(1) : "unknown"}</td>
                <td className={m.acceptable ? "ok" : "bad"}>{m.acceptable ? "yes" : "NO"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comparing && (
        <>
          <h3 style={{ marginTop: 18 }}>Comparison</h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Front pressure, MPa</th>
                  <th>Rear pressure, MPa</th>
                  <th>Safety factor</th>
                  <th>Front area margin</th>
                  <th>Rear area margin</th>
                  <th>Front travel, °</th>
                  <th>Rear travel, °</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const frontArea = r.areaRows.find((a) => a.axle === "front")?.row ?? null;
                  const rearArea = r.areaRows.find((a) => a.axle === "rear")?.row ?? null;
                  const frontTravel = r.travelRows.find((t) => t.axle === "front")?.row ?? null;
                  const rearTravel = r.travelRows.find((t) => t.axle === "rear")?.row ?? null;
                  return (
                    <tr key={r.scenario.id}>
                      <td>{scenarioLabel(r.scenario)}</td>
                      <td className="num">{mpa(r.frontPressurePa)}</td>
                      <td className="num">{mpa(r.rearPressurePa)}</td>
                      <td className="num">{r.safetyFactor ? r.safetyFactor.safety_factor.toFixed(2) : "—"}</td>
                      <td className="num">{frontArea ? frontArea.area_margin_ratio.toFixed(2) : "—"}</td>
                      <td className="num">{rearArea ? rearArea.area_margin_ratio.toFixed(2) : "—"}</td>
                      <td className="num">{frontTravel ? frontTravel.pedal_travel_deg.toFixed(2) : "—"}</td>
                      <td className="num">{rearTravel ? rearTravel.pedal_travel_deg.toFixed(2) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
