/** Quick sizing: is the rotor big enough, and can the ducting keep up?
 *
 * The lumped answer, ported from the Streamlit thermal-sizing section. Two
 * questions in sequence:
 *
 * 1. **Single stop** — all assigned brake energy into the rotor, `dT = Q/(m cp)`.
 *    Deliberately adiabatic, so it is the conservative bound rather than a
 *    prediction; it is energy-driven, which is why deceleration moves the heat
 *    RATE far more than the temperature rise.
 * 2. **Repeated events** — the same energy every `event_gap_s`, cooling by
 *    convection and radiation in between, run to cyclic convergence. This is
 *    where a rotor that survives one stop fails a run.
 *
 * Then the inverse: the convection coefficient and airflow that WOULD hold the
 * allowable temperature, so "the duct is not good enough" is a number rather
 * than a feeling.
 *
 * Emissivity is an input here, unlike the field models. That is not an
 * oversight: the field models resolve a real surface and take emissivity from
 * the rotor material, while this one lumps the whole radiating area into a
 * single coefficient, so it stays a knob alongside `h` and the vane multiplier.
 */
import { useMemo, useState } from "react";
import { Chart, TRACE_COLORS } from "../../components/Chart.tsx";

import type { AxleBrake, BrakeHardware, CoolingParameters, Vehicle } from "@core/models/internal.ts";
import type { RotorMaterial } from "@core/models/rotors.ts";
import {
  convectiveAreaM2,
  radiationAreaM2,
  rotorGeometryFromSweptBand,
} from "@core/models/rotors.ts";
import { coolingRequirement } from "@core/solvers/coolingRequirements.ts";
import type { CoolingRequirement } from "@core/solvers/coolingRequirements.ts";
import { simulateRepeatedEvents } from "@core/solvers/repeatedEvents.ts";
import type { RepeatedEventResult } from "@core/solvers/repeatedEvents.ts";
import { lumpedTemperatureRiseC } from "@core/solvers/thermal.ts";
import { runParameterizedSweep } from "@core/solvers/straightLineBraking.ts";
import type { AeroMap } from "@core/solvers/aero.ts";

/** Dash cycle for the deceleration dimension — colour is spoken for by axle. */
const DASHES = ["solid", "dot", "dash", "longdash", "dashdot", "longdashdot"] as const;

export interface QuickSizingProps {
  vehicle: Vehicle;
  brakes: BrakeHardware;
  speedSweepMph: number[];
  aeroMap: AeroMap;
  materialFor: (name: string | null | undefined) => RotorMaterial;
  /** Cooling baseline, already carrying the scenario's ambient/allowable. */
  cooling: CoolingParameters;
  eventGapS: number;
  allowableC: number;
}

export function QuickSizing({
  vehicle,
  brakes,
  speedSweepMph,
  aeroMap,
  materialFor,
  cooling,
  eventGapS,
  allowableC,
}: QuickSizingProps) {
  const [specificHeat, setSpecificHeat] = useState(486);
  const [driverLo, setDriverLo] = useState(42.64);
  const [driverHi, setDriverHi] = useState(110.22);
  const [decelLo, setDecelLo] = useState(1.0);
  const [decelHi, setDecelHi] = useState(1.6);
  const [includeAero, setIncludeAero] = useState(true);
  const [tab, setTab] = useState<"plots" | "raw">("plots");

  const [hConv, setHConv] = useState(cooling.convection_coefficient_w_m2k);
  const [emissivity, setEmissivity] = useState(cooling.emissivity);
  const [vaneMultiplier, setVaneMultiplier] = useState(cooling.vane_area_multiplier ?? 1.0);

  const sweep = useMemo(() => {
    const driverMasses = [driverLo, (driverLo + driverHi) / 2, driverHi];
    const steps = Math.max(Math.round((decelHi - decelLo) / 0.1), 0) + 1;
    const decelerations = Array.from({ length: steps }, (_, i) =>
      Number((decelLo + 0.1 * i).toFixed(3)),
    );
    const rows = runParameterizedSweep(
      vehicle,
      brakes,
      driverMasses,
      speedSweepMph,
      decelerations,
      includeAero ? aeroMap : null,
    );
    const frontMass = brakes.front.rotor_mass_kg;
    const rearMass = brakes.rear.rotor_mass_kg;
    const derived = rows.map((row) => ({
      row,
      case: `${row.target_deceleration_g.toFixed(1)} g, ${row.driver_mass_kg.toFixed(0)} kg`,
      frontDeltaTC: lumpedTemperatureRiseC(row.front_energy_per_rotor_j, frontMass, specificHeat),
      rearDeltaTC: lumpedTemperatureRiseC(row.rear_energy_per_rotor_j, rearMass, specificHeat),
      frontHeatRateW: row.front_energy_per_rotor_j / row.braking_duration_s,
      rearHeatRateW: row.rear_energy_per_rotor_j / row.braking_duration_s,
    }));
    return {
      derived,
      decelerations,
      driverMasses,
      frontMass,
      rearMass,
      maxFrontRise: Math.max(...derived.map((d) => d.frontDeltaTC)),
      maxRearRise: Math.max(...derived.map((d) => d.rearDeltaTC)),
      worstFrontEnergyJ: Math.max(...rows.map((r) => r.front_energy_per_rotor_j)),
      worstRearEnergyJ: Math.max(...rows.map((r) => r.rear_energy_per_rotor_j)),
    };
  }, [
    vehicle, brakes, speedSweepMph, aeroMap, includeAero,
    driverLo, driverHi, decelLo, decelHi, specificHeat,
  ]);

  /** One trace per (axle, driver mass, deceleration): colour says which axle,
   *  dash says which deceleration, and each line walks the speed sweep. */
  const seriesFor = (pick: "delta" | "rate") =>
    (["front", "rear"] as const).flatMap((axle, axleIndex) =>
      sweep.decelerations.flatMap((decel, decelIndex) =>
        sweep.driverMasses.map((mass, massIndex) => {
          const points = sweep.derived.filter(
            (d) =>
              Math.abs(d.row.target_deceleration_g - decel) < 1e-9 &&
              Math.abs(d.row.driver_mass_kg - mass) < 1e-9,
          );
          const value = (d: (typeof sweep.derived)[number]) =>
            pick === "delta"
              ? axle === "front" ? d.frontDeltaTC : d.rearDeltaTC
              : axle === "front" ? d.frontHeatRateW : d.rearHeatRateW;
          return {
            x: points.map((d) => d.row.initial_speed_mph),
            y: points.map(value),
            type: "scatter" as const,
            mode: "lines+markers" as const,
            name: `${axle} · ${decel.toFixed(1)} g`,
            legendgroup: `${axle}-${decel}`,
            // One legend entry per (axle, deceleration); the three driver
            // masses share it rather than tripling the legend.
            showlegend: massIndex === 0,
            line: {
              color: TRACE_COLORS[axleIndex === 0 ? 0 : 1],
              dash: DASHES[decelIndex % DASHES.length],
              width: 1.4,
            },
            marker: { size: 4 },
            opacity: 0.45 + 0.25 * massIndex,
          };
        }),
      ),
    );

  const deltaSeries = useMemo(() => seriesFor("delta"), [sweep]);
  const rateSeries = useMemo(() => seriesFor("rate"), [sweep]);

  // --- repeated events, per axle ---------------------------------------------
  const repeated = useMemo(() => {
    const runCooling: CoolingParameters = {
      ...cooling,
      convection_coefficient_w_m2k: hConv,
      emissivity,
      vane_area_multiplier: vaneMultiplier,
    };
    const forAxle = (axle: AxleBrake, eventEnergyJ: number) => {
      const material = materialFor(axle.rotor_material);
      const geometry = rotorGeometryFromSweptBand(
        axle.rotor_outer_diameter_mm,
        axle.pad_height_mm,
        axle.rotor_thickness_mm,
        material,
      );
      const areaConv = convectiveAreaM2(geometry, vaneMultiplier);
      const areaRad = radiationAreaM2(geometry);
      // Capacity from the MEASURED rotor mass and the material's own cp — the
      // specific-heat input above only drives the single-stop sweep.
      const capacity = axle.rotor_mass_kg * material.specific_heat_j_kgk;
      return {
        result: simulateRepeatedEvents(
          eventEnergyJ, eventGapS, runCooling, areaConv, areaRad, capacity, null, 400,
        ),
        // Duration fixed at 2 s: this is the steady-state estimate, so what
        // matters is the average heat rate a duct has to carry, not one stop's
        // exact length.
        requirement: coolingRequirement(eventEnergyJ, 2.0, areaConv, runCooling),
        areaConv,
        eventEnergyJ,
      };
    };
    return {
      front: forAxle(brakes.front, sweep.worstFrontEnergyJ),
      rear: forAxle(brakes.rear, sweep.worstRearEnergyJ),
    };
  }, [brakes, sweep, cooling, hConv, emissivity, vaneMultiplier, materialFor, eventGapS]);

  const maxEvents = Math.max(
    repeated.front.result.peak_temperatures_c.length,
    repeated.rear.result.peak_temperatures_c.length,
  );

  return (
    <>
      <div className="controls panel" style={{ padding: 12 }}>
        <div className="field">
          <label htmlFor="qs-cp">Rotor specific heat, J/kg·K</label>
          <input
            id="qs-cp" type="number" step={1} value={specificHeat}
            onChange={(e) => setSpecificHeat(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-dlo">Driver mass min, kg</label>
          <input
            id="qs-dlo" type="number" step={1} value={driverLo}
            onChange={(e) => setDriverLo(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-dhi">Driver mass max, kg</label>
          <input
            id="qs-dhi" type="number" step={1} value={driverHi}
            onChange={(e) => setDriverHi(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-glo">Deceleration min, g</label>
          <input
            id="qs-glo" type="number" step={0.1} value={decelLo}
            onChange={(e) => setDecelLo(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-ghi">Deceleration max, g</label>
          <input
            id="qs-ghi" type="number" step={0.1} value={decelHi}
            onChange={(e) => setDecelHi(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-aero">Aero</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="qs-aero" type="checkbox" checked={includeAero}
              onChange={(e) => setIncludeAero(e.target.checked)}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--dim)", fontSize: 12 }}>include downforce</span>
          </label>
        </div>
      </div>

      <div className="metrics">
        <Metric label="Front rotor mass" value={`${sweep.frontMass.toFixed(3)} kg`} />
        <Metric label="Rear rotor mass" value={`${sweep.rearMass.toFixed(3)} kg`} />
        <Metric label="Max front rise" value={`${sweep.maxFrontRise.toFixed(1)} °C`} />
        <Metric label="Max rear rise" value={`${sweep.maxRearRise.toFixed(1)} °C`} />
      </div>

      <div className="tabs" role="tablist" aria-label="Sweep detail">
        {(
          [
            ["plots", "Plots"],
            ["raw", "Raw data"],
          ] as Array<["plots" | "raw", string]>
        ).map(([id, label]) => (
          <button
            key={id} className={`tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)} role="tab" aria-selected={tab === id}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "plots" ? (
        <>
          <Chart
            title="Conservative lumped rotor temperature rise"
            height={380}
            data={deltaSeries as never[]}
            layout={{
              xaxis: { title: { text: "Initial speed (mph)" } },
              yaxis: { title: { text: "Temperature rise (°C)" } },
            }}
          />
          <Chart
            title="Average heat input rate during the stop"
            height={380}
            data={rateSeries as never[]}
            layout={{
              xaxis: { title: { text: "Initial speed (mph)" } },
              yaxis: { title: { text: "Average heat rate (W)" } },
            }}
          />
          <p className="note">
            Single-stop adiabatic temperature rise is primarily energy-driven, so deceleration
            changes the heat rate and stop duration far more than the total temperature rise.
            Colour is the axle, dash the deceleration, and the three lines of each style are the
            three driver masses.
          </p>
        </>
      ) : (
        <div className="panel" style={{ padding: 12, overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Driver, kg</th><th>Speed, mph</th><th>Decel, g</th>
                <th>Front E/rotor, J</th><th>Rear E/rotor, J</th>
                <th>Duration, s</th><th>Distance, m</th>
                <th>Front ΔT, °C</th><th>Rear ΔT, °C</th>
                <th>Front heat rate, W</th><th>Rear heat rate, W</th>
              </tr>
            </thead>
            <tbody>
              {sweep.derived.map((d, i) => (
                <tr key={i}>
                  <td>{d.row.driver_mass_kg.toFixed(2)}</td>
                  <td>{d.row.initial_speed_mph.toFixed(0)}</td>
                  <td>{d.row.target_deceleration_g.toFixed(1)}</td>
                  <td>{d.row.front_energy_per_rotor_j.toFixed(0)}</td>
                  <td>{d.row.rear_energy_per_rotor_j.toFixed(0)}</td>
                  <td>{d.row.braking_duration_s.toFixed(2)}</td>
                  <td>{d.row.stopping_distance_m.toFixed(1)}</td>
                  <td>{d.frontDeltaTC.toFixed(1)}</td>
                  <td>{d.rearDeltaTC.toFixed(1)}</td>
                  <td>{d.frontHeatRateW.toFixed(0)}</td>
                  <td>{d.rearHeatRateW.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ margin: "26px 0 6px", fontSize: 15 }}>Repeated-event thermal (autocross)</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Each braking event dumps its assigned energy into the rotor; between events the rotor cools
        by convection and radiation. The model runs to cyclic convergence. The cooling coefficient
        and emissivity are editable, low-confidence assumptions — confirm with CFD or test before
        trusting the pass/fail.
      </p>

      <div className="controls panel" style={{ padding: 12 }}>
        <div className="field">
          <label htmlFor="qs-h">Convection coeff h, W/m²·K</label>
          <input
            id="qs-h" type="number" step={5} value={hConv}
            onChange={(e) => setHConv(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-eps">Emissivity</label>
          <input
            id="qs-eps" type="number" step={0.05} value={emissivity}
            onChange={(e) => setEmissivity(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="qs-vane">Vane area multiplier</label>
          <input
            id="qs-vane" type="number" step={0.1} value={vaneMultiplier}
            onChange={(e) => setVaneMultiplier(Number(e.target.value))}
          />
        </div>
        <p className="note" style={{ margin: 0, maxWidth: "44ch" }}>
          Events are {eventGapS} s apart (from the conditions bar) and carry each axle's worst-case
          energy from the sweep above.
        </p>
      </div>

      <div className="charts two">
        <AxlePanel label="Front" run={repeated.front.result} allowable={allowableC} />
        <AxlePanel label="Rear" run={repeated.rear.result} allowable={allowableC} />
      </div>

      <Chart
        title="Peak rotor temperature vs event (to cyclic convergence)"
        height={340}
        data={[
          {
            x: repeated.front.result.peak_temperatures_c.map((_, i) => i + 1),
            y: repeated.front.result.peak_temperatures_c,
            type: "scatter", mode: "lines+markers", name: "front",
          },
          {
            x: repeated.rear.result.peak_temperatures_c.map((_, i) => i + 1),
            y: repeated.rear.result.peak_temperatures_c,
            type: "scatter", mode: "lines+markers", name: "rear",
          },
          {
            x: [1, Math.max(maxEvents, 2)],
            y: [allowableC, allowableC],
            type: "scatter", mode: "lines", name: "allowable",
            line: { dash: "dash", color: "#EF5350" },
          },
        ]}
        layout={{
          xaxis: { title: { text: "Event #" } },
          yaxis: { title: { text: "Peak temperature (°C)" } },
        }}
      />

      <h3 style={{ margin: "22px 0 6px", fontSize: 14 }}>Required cooling (steady-state target)</h3>
      <div className="panel" style={{ padding: 12, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Rotor</th><th>Event energy, J</th><th>Convective area, m²</th>
              <th>Required h, W/m²·K</th><th>Required hA, W/K</th><th>Required airflow, m³/s</th>
            </tr>
          </thead>
          <tbody>
            <CoolingRow label="front" area={repeated.front.areaConv} energyJ={repeated.front.eventEnergyJ} req={repeated.front.requirement} />
            <CoolingRow label="rear" area={repeated.rear.areaConv} energyJ={repeated.rear.eventEnergyJ} req={repeated.rear.requirement} />
          </tbody>
        </table>
      </div>
      <p className="note">
        A required h above the assumed {hConv.toFixed(0)} W/m²·K means the duct or airflow must be
        improved, or the rotor enlarged, to hold the allowable temperature. Event energy uses the
        worst case from the sweep above; the duration is taken as 2 s for the steady-state estimate.
      </p>
    </>
  );
}

function AxlePanel({
  label,
  run,
  allowable,
}: {
  label: string;
  run: RepeatedEventResult;
  allowable: number;
}) {
  return (
    <div>
      <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>{label} rotor</h4>
      <div className="metrics">
        <Metric
          label="Cyclic peak temp"
          value={`${run.cyclic_peak_temperature_c.toFixed(1)} °C`}
          delta={run.limit_exceeded ? "EXCEEDS LIMIT" : "within limit"}
          tone={run.cyclic_peak_temperature_c > allowable ? "bad" : "ok"}
        />
        <Metric
          label="Events to converge"
          value={run.converged && run.events_to_convergence != null ? String(run.events_to_convergence) : "no conv."}
          tone={run.converged ? undefined : "warn"}
        />
        <Metric label="Cyclic min" value={`${run.cyclic_min_temperature_c.toFixed(1)} °C`} />
        <Metric label="Cyclic avg" value={`${run.cyclic_average_temperature_c.toFixed(1)} °C`} />
      </div>
    </div>
  );
}

function CoolingRow({
  label,
  area,
  energyJ,
  req,
}: {
  label: string;
  area: number;
  energyJ: number;
  req: CoolingRequirement;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td>{energyJ.toFixed(0)}</td>
      <td>{area.toFixed(5)}</td>
      <td>{req.required_convection_coefficient_w_m2k.toFixed(1)}</td>
      <td>{req.required_conductance_w_k.toFixed(2)}</td>
      <td>{req.required_air_volume_flow_m3_s.toFixed(4)}</td>
    </tr>
  );
}

function Metric({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className="metric panel">
      <div className="metric-label">{label}</div>
      <div className={`metric-value${tone ? ` ${tone}` : ""}`} style={{ fontSize: "1.2rem" }}>
        {value}
      </div>
      {delta && <div className="metric-delta">{delta}</div>}
    </div>
  );
}
