/** Rotor temperature, at two fidelities and on three geometries.
 *
 * The Streamlit original was 2,364 lines with nine sections on one scroll and
 * opened with a form rather than an answer. This is the result of re-layering
 * it: the answer first, the field second, everything else behind tabs, and the
 * inputs docked above rather than interleaved through the results. Nothing was
 * dropped — the parametric annulus, the uploaded cross-section, the
 * face-resolved plate model, the fixed-band steady solve, the multi-stop
 * simulator, both animations and the growth overlay are all here.
 *
 * The field models run in a Web Worker. That is not an optimisation — a
 * face-resolved multi-stop run takes about a minute, and on the main thread
 * that is a frozen tab with no way to cancel. Streamlit hid this behind a
 * server round trip; a browser has to be explicit about it, which is why the
 * field never runs on a keystroke and always waits for the Run button.
 */
import { useEffect, useMemo, useState } from "react";
import { AnimatedChart, Chart, HEAT_SCALE } from "../components/Chart.tsx";
import { useSolver, useSolverQueue } from "../state/useSolver.ts";
import type { SolveInput } from "../state/useSolver.ts";
import type { SolverOk } from "../worker/solver.worker.ts";
import type { PageProps } from "./registry.tsx";
import type { Scenario } from "../state/store.ts";
import { scenarioLabel } from "../state/store.ts";

import { GeometryPanel, defaultGeometryInputs, resolveGeometry } from "./thermal/geometry.tsx";
import type { GeometryInputs, ResolvedGeometry } from "./thermal/geometry.tsx";
import { GrowthTab, sweepGrowthMm } from "./thermal/growth.tsx";
import {
  circleXY,
  flattenPaths,
  hottestSnapshot,
  mirrorAnnulus,
  nearestSnapshot,
  mirrorAxisMm,
  snapshotGrid,
  surfaceProfile,
  sweepProfileToFace,
} from "./thermal/field.ts";
import type { Grid } from "./thermal/field.ts";

import rotorMaterialData from "@data/materials/rotor_materials.json";
import coolingData from "@data/thermal/cooling_baseline.json";
import baselineAeroRaw from "@data/aero/baseline_aero.json";
import baselineVehicleRaw from "@data/vehicles/fsae_2026_baseline.json";

import type { AxleBrake, CoolingParameters } from "@core/models/internal.ts";
import type { RotorGeometry, RotorMaterial } from "@core/models/rotors.ts";
import { convectiveAreaM2, radiationAreaM2, thermalMassJK } from "@core/models/rotors.ts";
import { lumpedTemperatureRiseC } from "@core/solvers/thermal.ts";
import { simulateRepeatedEvents } from "@core/solvers/repeatedEvents.ts";
import type { RepeatedEventResult } from "@core/solvers/repeatedEvents.ts";
import { loadAeroMap } from "@core/solvers/aero.ts";
import { runParameterizedSweep } from "@core/solvers/straightLineBraking.ts";
import type { StraightLineResult } from "@core/solvers/straightLineBraking.ts";

const AERO_MAP = loadAeroMap(baselineAeroRaw);
const SPEED_SWEEP_MPH = (
  baselineVehicleRaw as unknown as { vehicle: { speed_sweep_mph: number[] } }
).vehicle.speed_sweep_mph;
/** The driver masses and decelerations the Python page seeded its worst case
 *  from — min, mid and max of the config sweep, at three deceleration levels. */
const DRIVER_MASSES = [42.64, 76.4, 110.22];
const DECELERATIONS = [1.0, 1.3, 1.6];

// --- material lookup ----------------------------------------------------------

interface RawMaterial {
  name: string;
  density_kg_m3: number;
  specific_heat_J_kgK: number;
  thermal_conductivity_W_mK?: number;
  youngs_modulus_Pa?: number;
  poissons_ratio?: number;
  thermal_expansion_1_K?: number;
  yield_strength_Pa?: number;
  emissivity?: number;
}

const MATERIALS = (rotorMaterialData as { materials: RawMaterial[] }).materials;
const MATERIAL_NAMES = MATERIALS.map((m) => m.name);

function materialByName(name: string | null | undefined): RotorMaterial {
  const raw = MATERIALS.find((m) => m.name === name) ?? MATERIALS[0]!;
  return {
    name: raw.name,
    density_kg_m3: raw.density_kg_m3,
    specific_heat_j_kgk: raw.specific_heat_J_kgK,
    thermal_conductivity_w_mk: raw.thermal_conductivity_W_mK ?? null,
    youngs_modulus_pa: raw.youngs_modulus_Pa ?? null,
    poissons_ratio: raw.poissons_ratio ?? null,
    thermal_expansion_1_k: raw.thermal_expansion_1_K ?? null,
    yield_strength_pa: raw.yield_strength_Pa ?? null,
    emissivity: raw.emissivity ?? null,
  };
}

const COOLING_DEFAULTS = (
  coolingData as {
    cooling: {
      convection_coefficient_W_m2K: number;
      emissivity: number;
      vane_area_multiplier: number;
      rotor_heat_fraction: number;
      air_specific_heat_J_kgK: number;
      air_density_kg_m3: number;
      cooling_air_delta_T_C: number;
    };
  }
).cooling;

type Axle = "front" | "rear";
type Fidelity = "quick" | "field";
type ThermalInput = "energy" | "band";
type RunMode = "single" | "repeated" | "multi";
type FieldView = "face" | "xsec";
type DetailTab = "profiles" | "growth" | "energy";

/** Worst case of the standard sweep for one axle.
 *
 * Deliberately NOT the nominal driver in the conditions bar: a rotor is sized
 * against the worst stop it will see, and seeding from the 75 kg nominal
 * understates the load by about 11% (30.3 kJ against 34.2 kJ on the baseline
 * car). Matches how the Python page seeds.
 */
function worstCaseEvent(scenario: Scenario, axle: Axle): StraightLineResult {
  const rows = runParameterizedSweep(
    scenario.vehicle,
    scenario.brakes,
    DRIVER_MASSES,
    SPEED_SWEEP_MPH,
    DECELERATIONS,
    AERO_MAP,
  );
  const key = axle === "front" ? "front_energy_per_rotor_j" : "rear_energy_per_rotor_j";
  return rows.reduce((worst, row) => (row[key] > worst[key] ? row : worst), rows[0]!);
}

function axleOf(scenario: Scenario, axle: Axle): AxleBrake {
  return axle === "front" ? scenario.brakes.front : scenario.brakes.rear;
}

function coolingFor(
  scenario: Scenario,
  h: number,
  emissivity: number,
  heatFraction: number,
): CoolingParameters {
  // Only the five fields the field solvers read. `vane_area_multiplier` is a
  // lumped-model area fudge the FD models deliberately do not apply, so leaving
  // it out here is not an omission — passing it would silently change nothing
  // while implying it did.
  return {
    convection_coefficient_w_m2k: h,
    emissivity,
    ambient_temperature_c: scenario.conditions.ambient_temperature_c,
    allowable_rotor_temperature_c: scenario.conditions.allowable_rotor_temperature_c,
    rotor_heat_fraction: heatFraction,
  };
}

/** Comma-separated positive numbers, capped — the sweep compute-time guard. */
function parseSweep(raw: string, limit = 5): number[] {
  const values = raw
    .replace(/;/g, ",")
    .split(",")
    .map((t) => Number(t.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
  return [...new Set(values)].sort((a, b) => a - b).slice(0, limit);
}

// --- page ---------------------------------------------------------------------

export function Thermal({ scenario, compared, comparing }: PageProps) {
  const [fidelity, setFidelity] = useState<Fidelity>("quick");
  const [axle, setAxle] = useState<Axle>("front");
  const hw = axleOf(scenario, axle);

  // --- event ------------------------------------------------------------------
  const worst = useMemo(() => worstCaseEvent(scenario, axle), [scenario, axle]);
  const worstEnergyJ =
    axle === "front" ? worst.front_energy_per_rotor_j : worst.rear_energy_per_rotor_j;

  const [thermalInput, setThermalInput] = useState<ThermalInput>("energy");
  const [overrideEvent, setOverrideEvent] = useState(false);
  const [energyOverrideJ, setEnergyOverrideJ] = useState(worstEnergyJ);
  const [durationOverrideS, setDurationOverrideS] = useState(worst.braking_duration_s);
  const [bandTemperatureC, setBandTemperatureC] = useState(450);
  const [mode, setMode] = useState<RunMode>("single");
  const [nStops, setNStops] = useState(12);
  const [coolDownS, setCoolDownS] = useState(5);

  const eventEnergyJ = overrideEvent ? energyOverrideJ : worstEnergyJ;
  const eventDurationS = overrideEvent ? durationOverrideS : worst.braking_duration_s;

  // --- geometry ---------------------------------------------------------------
  const bandInnerDefaultMm =
    hw.pad_swept_inner_diameter_mm ?? hw.rotor_outer_diameter_mm - 2.0 * hw.pad_height_mm;
  const bandOuterDefaultMm = hw.pad_swept_outer_diameter_mm ?? hw.rotor_outer_diameter_mm;

  const [geometryInputs, setGeometryInputs] = useState<GeometryInputs>(() =>
    defaultGeometryInputs(
      Math.max((hw.rotor_outer_diameter_mm - bandOuterDefaultMm) / 2.0, 0.0),
      (bandOuterDefaultMm - bandInnerDefaultMm) / 2.0,
      bandInnerDefaultMm,
      hw.rotor_thickness_mm,
      hw.rotor_material ?? MATERIAL_NAMES[0]!,
    ),
  );
  const patchGeometry = (patch: Partial<GeometryInputs>) =>
    setGeometryInputs((prev) => ({ ...prev, ...patch }));

  const sectionMaterial = useMemo(
    () => materialByName(geometryInputs.sectionMaterial),
    [geometryInputs.sectionMaterial],
  );
  const geometry = useMemo(
    () => resolveGeometry(geometryInputs, sectionMaterial),
    [geometryInputs, sectionMaterial],
  );

  const annulusMaterial = useMemo(() => materialByName(hw.rotor_material), [hw.rotor_material]);
  const activeMaterial = geometry.source === "annulus" ? annulusMaterial : sectionMaterial;
  // Emissivity is a property of the (oxidized) rotor surface, so it follows the
  // material rather than being a free input.
  const emissivity = activeMaterial.emissivity ?? COOLING_DEFAULTS.emissivity;

  // --- tuning -----------------------------------------------------------------
  const [showTuning, setShowTuning] = useState(false);
  const [nRadial, setNRadial] = useState(41);
  const [nAxial, setNAxial] = useState(9);
  const [nSectionRadial, setNSectionRadial] = useState(81);
  const [nSectionAxial, setNSectionAxial] = useState(33);
  const [nFacePixels, setNFacePixels] = useState(241);
  const [faceFrames, setFaceFrames] = useState(12);
  const [hConv, setHConv] = useState(COOLING_DEFAULTS.convection_coefficient_W_m2K);
  const [heatFraction, setHeatFraction] = useState(COOLING_DEFAULTS.rotor_heat_fraction);
  const [sweepText, setSweepText] = useState("");
  // Quick sizing carries its OWN emissivity input, as the Python thermal-sizing
  // section does: it is a lumped radiating-area assumption alongside h, not the
  // material-surface property the field models read off the rotor material.
  const [quickEmissivity, setQuickEmissivity] = useState(COOLING_DEFAULTS.emissivity);

  const faceMode = geometry.faceMode;
  // The plate model is transient-only: holding the band at a fixed temperature
  // is a steady Dirichlet solve only the axisymmetric models offer.
  const effectiveInput: ThermalInput = faceMode ? "energy" : thermalInput;
  const effectiveMode: RunMode =
    effectiveInput === "band" ? "single" : mode;

  const cooling = useMemo(
    () => coolingFor(scenario, hConv, emissivity, heatFraction),
    [scenario, hConv, emissivity, heatFraction],
  );

  // --- quick sizing: cheap enough to run inline every render -------------------
  // The MEASURED rotor mass from the hardware config, not one derived from
  // geometry. Deriving it needs `hat_interface_diameter_mm`, a CAD value the
  // baseline config does not carry — which is precisely why the solver's
  // thermalMassJK takes an explicit mass: so thermal sizing works before the
  // hat radius is known.
  const quick = useMemo<QuickResult>(() => {
    try {
      const mass = hw.rotor_mass_kg;
      const quickGeometry: RotorGeometry = {
        outer_diameter_mm: hw.rotor_outer_diameter_mm,
        inner_swept_diameter_mm: bandInnerDefaultMm,
        thickness_mm: hw.rotor_thickness_mm,
        material: annulusMaterial,
        hat_interface_diameter_mm: null,
      };
      const capacity = thermalMassJK(quickGeometry, mass);
      const quickCooling: CoolingParameters = {
        ...cooling,
        emissivity: quickEmissivity,
        vane_area_multiplier: COOLING_DEFAULTS.vane_area_multiplier,
        air_specific_heat_j_kgk: COOLING_DEFAULTS.air_specific_heat_J_kgK,
        air_density_kg_m3: COOLING_DEFAULTS.air_density_kg_m3,
        cooling_air_delta_t_c: COOLING_DEFAULTS.cooling_air_delta_T_C,
      };
      const singleRise = lumpedTemperatureRiseC(
        worstEnergyJ * heatFraction,
        mass,
        annulusMaterial.specific_heat_j_kgk,
      );
      const train = simulateRepeatedEvents(
        worstEnergyJ * heatFraction,
        scenario.conditions.event_gap_s,
        quickCooling,
        convectiveAreaM2(quickGeometry, COOLING_DEFAULTS.vane_area_multiplier),
        radiationAreaM2(quickGeometry),
        capacity,
      );
      return { mass, capacity, singleRise, train, error: null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [
    hw, bandInnerDefaultMm, annulusMaterial, cooling, quickEmissivity, worstEnergyJ,
    heatFraction, scenario.conditions.event_gap_s,
  ]);

  // --- the field request ------------------------------------------------------
  const { result, running, error, solve, clear } = useSolver();
  const sweep = useSolverQueue();

  const buildRequest = useMemo(() => {
    return (
      energyJ: number,
      forceSingle = false,
      bandC: number | null = null,
    ): SolveInput | null => {
      const isBand = bandC !== null;
      const runMode: RunMode = forceSingle || isBand ? "single" : effectiveMode;
      const solveMode = isBand ? "steady" : runMode === "single" ? "single" : "train";
      const gapS = scenario.conditions.event_gap_s;
      const fixedCount = runMode === "multi";
      const common = {
        cooling,
        mode: solveMode as SolveInput["mode"],
        energyJ,
        durationS: eventDurationS,
        coolDownS: runMode === "single" ? coolDownS : 0,
        gapS: runMode === "single" ? 0 : gapS,
        maxEvents: fixedCount ? Math.max(nStops, 1) : faceMode ? 30 : 60,
        consecutiveRequired: fixedCount ? Math.max(nStops, 1) + 1 : null,
        snapshots: faceMode && solveMode === "train" ? Math.max(faceFrames, 2) : 25,
        bandTemperatureC: bandC,
      };

      if (geometry.source === "annulus") {
        if (annulusMaterial.thermal_conductivity_w_mk == null) return null;
        const bandInnerMm =
          hw.rotor_outer_diameter_mm - 2.0 * (geometry.padOffsetMm + geometry.padDepthMm);
        return {
          ...common,
          kind: "annulus",
          nRadial,
          nAxial,
          geometry: {
            outer_diameter_mm: hw.rotor_outer_diameter_mm,
            inner_swept_diameter_mm: bandInnerMm,
            thickness_mm: hw.rotor_thickness_mm,
            material: annulusMaterial,
            hat_interface_diameter_mm:
              geometry.innerDomainMm < bandInnerMm ? geometry.innerDomainMm : null,
          },
        };
      }

      if (faceMode && geometry.plan) {
        return {
          ...common,
          kind: "face",
          outerDiameterMm: geometry.plan.outer_diameter_mm,
          innerDiameterMm: geometry.planInnerMm,
          thicknessMm: geometry.planThicknessMm,
          material: sectionMaterial,
          innerBoundaryMm: geometry.faceInner,
          holeCentersMm: geometry.faceHoles,
          slotLoopsMm: geometry.faceSlots,
          bandDepthMm: geometry.padDepthMm,
          bandOffsetMm: geometry.padOffsetMm,
          nPixels: nFacePixels,
        };
      }

      if (!geometry.sectionPointsMm) return null;
      return {
        ...common,
        kind: "section",
        pointsMm: geometry.sectionPointsMm,
        material: sectionMaterial,
        holeBands: geometry.holeBands,
        bandDepthMm: geometry.padDepthMm,
        bandOffsetMm: geometry.padOffsetMm,
        nRadial: nSectionRadial,
        nAxial: nSectionAxial,
      };
    };
  }, [
    effectiveMode, scenario.conditions.event_gap_s, cooling, eventDurationS, coolDownS,
    nStops, faceMode, faceFrames, geometry, annulusMaterial, sectionMaterial, hw,
    nRadial, nAxial, nSectionRadial, nSectionAxial, nFacePixels,
  ]);

  const runField = () => {
    const request = buildRequest(
      eventEnergyJ * heatFraction,
      false,
      effectiveInput === "band" ? bandTemperatureC : null,
    );
    if (request) solve(request);
  };

  const sweepValues = useMemo(() => parseSweep(sweepText), [sweepText]);
  const runSweep = () => {
    const requests = sweepValues
      .map((value) =>
        effectiveInput === "band"
          ? buildRequest(0, true, value)
          : buildRequest(value * 1000 * heatFraction, true, null),
      )
      .filter((r): r is SolveInput => r !== null);
    sweep.runAll(requests);
  };

  // A solved field describes the geometry it was solved on. Changing the
  // geometry underneath it would leave a heatmap of a rotor nobody selected, so
  // the result is dropped rather than left to be misread.
  useEffect(() => {
    clear();
  }, [geometry.source, geometry.faceMode, geometry.plan, geometry.sectionPointsMm, axle, clear]);

  // --- snapshot selection -----------------------------------------------------
  // Open on the interesting frame, not frame zero. For a single stop that is
  // the solver's own peak time; for a whole-run stack the peak of one event is
  // not the peak of the run, so the hottest frame is what to land on.
  const [snapIndex, setSnapIndex] = useState(0);
  useEffect(() => {
    if (!result) return;
    setSnapIndex(
      result.snapSpan === "run" ? hottestSnapshot(result) : nearestSnapshot(result, result.peakTimeS),
    );
  }, [result]);

  const [fieldView, setFieldView] = useState<FieldView>("face");
  const [detailTab, setDetailTab] = useState<DetailTab>("profiles");

  const allowable = scenario.conditions.allowable_rotor_temperature_c;
  const ambient = scenario.conditions.ambient_temperature_c;

  const blocked =
    geometry.error ??
    (geometry.source === "annulus" && annulusMaterial.thermal_conductivity_w_mk == null
      ? `Rotor material '${annulusMaterial.name}' has no thermal conductivity — add it to the material database before running the conduction model.`
      : geometry.source === "upload" && sectionMaterial.thermal_conductivity_w_mk == null
        ? `Material '${sectionMaterial.name}' has no thermal conductivity.`
        : null);

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Model fidelity">
        {(
          [
            ["quick", "Quick sizing (lumped)"],
            ["field", "Field model (finite-difference)"],
          ] as Array<[Fidelity, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={`tab${fidelity === id ? " active" : ""}`}
            onClick={() => setFidelity(id)}
            role="tab"
            aria-selected={fidelity === id}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="controls panel" style={{ padding: 12 }}>
        <div className="field">
          <label htmlFor="th-axle">Axle</label>
          <select id="th-axle" value={axle} onChange={(e) => setAxle(e.target.value as Axle)}>
            <option value="front">Front</option>
            <option value="rear">Rear</option>
          </select>
        </div>
        {fidelity === "field" && (
          <>
            <div className="field">
              <label htmlFor="th-input">Thermal input</label>
              <select
                id="th-input" style={{ width: 240 }} value={thermalInput}
                onChange={(e) => setThermalInput(e.target.value as ThermalInput)}
              >
                <option value="energy">Braking energy</option>
                <option value="band">Fixed swept-band temperature</option>
              </select>
            </div>
            {effectiveInput === "energy" ? (
              <>
                <div className="field">
                  <label htmlFor="th-mode">Mode</label>
                  <select
                    id="th-mode" style={{ width: 250 }} value={effectiveMode}
                    onChange={(e) => setMode(e.target.value as RunMode)}
                  >
                    <option value="single">Single stop</option>
                    <option value="repeated">Repeated events (autocross)</option>
                    <option value="multi">Multi-stop simulator (fixed count)</option>
                  </select>
                </div>
                {effectiveMode === "single" && (
                  <div className="field">
                    <label htmlFor="th-cool">Cool-down after stop, s</label>
                    <input
                      id="th-cool" type="number" step={1} value={coolDownS}
                      onChange={(e) => setCoolDownS(Number(e.target.value))}
                    />
                  </div>
                )}
                {effectiveMode === "multi" && (
                  <div className="field">
                    <label htmlFor="th-stops">Number of stops</label>
                    <input
                      id="th-stops" type="number" step={1} min={1} value={nStops}
                      onChange={(e) => setNStops(Math.max(Number(e.target.value), 1))}
                    />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="th-over">Event</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <input
                      id="th-over" type="checkbox" checked={overrideEvent}
                      onChange={(e) => setOverrideEvent(e.target.checked)}
                      style={{ width: 13, height: 13, padding: 0 }}
                    />
                    <span style={{ color: "var(--dim)", fontSize: 12 }}>override worst case</span>
                  </label>
                </div>
                {overrideEvent && (
                  <>
                    <div className="field">
                      <label htmlFor="th-e">Event energy per rotor, J</label>
                      <input
                        id="th-e" type="number" step={1000} value={energyOverrideJ}
                        onChange={(e) => setEnergyOverrideJ(Number(e.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="th-dur">Stop duration, s</label>
                      <input
                        id="th-dur" type="number" step={0.1} value={durationOverrideS}
                        onChange={(e) => setDurationOverrideS(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="field">
                <label htmlFor="th-band">Swept-band surface temperature, °C</label>
                <input
                  id="th-band" type="number" step={10} value={bandTemperatureC}
                  onChange={(e) => setBandTemperatureC(Number(e.target.value))}
                />
              </div>
            )}
          </>
        )}
        <div className="field">
          <label>&nbsp;</label>
          <button onClick={() => setShowTuning((v) => !v)}>
            {showTuning ? "Hide tuning" : "Tuning…"}
          </button>
        </div>
      </div>

      {fidelity === "field" && effectiveInput === "energy" && !overrideEvent && (
        <p className="note" style={{ marginTop: 0 }}>
          Worst sweep case: {worst.initial_speed_mph.toFixed(0)} mph,{" "}
          {worst.target_deceleration_g.toFixed(1)} g, {worst.driver_mass_kg.toFixed(0)} kg driver —{" "}
          {(worstEnergyJ / 1000).toFixed(1)} kJ per rotor over{" "}
          {worst.braking_duration_s.toFixed(2)} s.
        </p>
      )}
      {fidelity === "field" && effectiveMode !== "single" && effectiveInput === "energy" && (
        <p className="note" style={{ marginTop: 0 }}>
          {effectiveMode === "multi"
            ? `Simulating ${nStops} stops of ${(eventEnergyJ / 1000).toFixed(1)} kJ separated by ${scenario.conditions.event_gap_s} s — ${(nStops * (eventDurationS + scenario.conditions.event_gap_s)).toFixed(0)} s of run time. Every stop is simulated; there is no convergence short-circuit.`
            : `Repeated events run until the per-event peak stops changing, with the shared ${scenario.conditions.event_gap_s} s gap between them.`}
        </p>
      )}
      {faceMode && thermalInput === "band" && (
        <p className="note" style={{ color: "var(--warn)", marginTop: 0 }}>
          Face-resolved mode runs transient braking energy only — the fixed swept-band temperature
          is a steady-state solve the axisymmetric models provide. Running the worst-case stop
          instead; switch to the axisymmetric model for the fixed-temperature soak study.
        </p>
      )}

      {showTuning && (
        <div className="controls panel" style={{ padding: 12 }}>
          {fidelity === "quick" ? null : faceMode ? (
            <>
              <div className="field">
                <label htmlFor="tn-px">Face grid pixels (per axis)</label>
                <input
                  id="tn-px" type="number" step={20} value={nFacePixels}
                  onChange={(e) => setNFacePixels(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="tn-fr">Face frames per event</label>
                <input
                  id="tn-fr" type="number" step={2} value={faceFrames}
                  disabled={effectiveMode === "single"}
                  onChange={(e) => setFaceFrames(Math.max(Number(e.target.value), 2))}
                />
              </div>
            </>
          ) : geometry.source === "annulus" ? (
            <>
              <div className="field">
                <label htmlFor="tn-nr">Radial nodes</label>
                <input
                  id="tn-nr" type="number" step={10} value={nRadial}
                  onChange={(e) => setNRadial(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="tn-nz">Axial nodes (half thickness)</label>
                <input
                  id="tn-nz" type="number" step={2} value={nAxial}
                  onChange={(e) => setNAxial(Number(e.target.value))}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="tn-sr">Radial cells</label>
                <input
                  id="tn-sr" type="number" step={10} value={nSectionRadial}
                  onChange={(e) => setNSectionRadial(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="tn-sz">Axial cells (full thickness)</label>
                <input
                  id="tn-sz" type="number" step={4} value={nSectionAxial}
                  onChange={(e) => setNSectionAxial(Number(e.target.value))}
                />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="tn-h">Convection h, W/m²K</label>
            <input
              id="tn-h" type="number" step={5} value={hConv}
              onChange={(e) => setHConv(Number(e.target.value))}
            />
          </div>
          {fidelity === "quick" && (
            <div className="field">
              <label htmlFor="tn-eps">Emissivity</label>
              <input
                id="tn-eps" type="number" step={0.05} value={quickEmissivity}
                onChange={(e) => setQuickEmissivity(Number(e.target.value))}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="tn-frac">Rotor heat fraction</label>
            <input
              id="tn-frac" type="number" step={0.05} value={heatFraction}
              onChange={(e) => setHeatFraction(Number(e.target.value))}
            />
          </div>
          {fidelity === "field" && (
            <div className="field">
              <label htmlFor="tn-sweep">
                {effectiveInput === "band" ? "Sweep band temperatures, °C" : "Sweep energies, kJ"}
              </label>
              <input
                id="tn-sweep" type="text" style={{ width: 220 }} value={sweepText}
                placeholder={effectiveInput === "band" ? "e.g. 300, 400, 450, 500" : "e.g. 15, 25, 34, 45"}
                onChange={(e) => setSweepText(e.target.value)}
              />
            </div>
          )}
          <p className="note" style={{ width: "100%", margin: 0 }}>
            Convection h and emissivity are low-confidence assumptions; a heat fraction of 1.0
            sends all friction heat into the rotor, which is the conservative choice.
            {fidelity === "field"
              ? ` The field models take emissivity (${emissivity.toFixed(2)}) from the rotor material '${activeMaterial.name}' — it is a property of the oxidized rotor surface, not a free knob. Sweeps are capped at 5 values and run as single stops.`
              : " Quick sizing keeps emissivity as an input because its radiating area is a lumped assumption rather than a resolved surface."}
          </p>
        </div>
      )}

      {fidelity === "quick" ? (
        <QuickSizing
          quick={quick}
          energyJ={worstEnergyJ}
          ambient={ambient}
          allowable={allowable}
          scenario={scenario}
        />
      ) : (
        <>
          <GeometryPanel
            inputs={geometryInputs}
            resolved={geometry}
            materialNames={MATERIAL_NAMES}
            onChange={patchGeometry}
          />

          <div className="controls" style={{ marginBottom: 14 }}>
            <button
              className="primary"
              onClick={runField}
              disabled={running || geometry.pending || blocked !== null}
            >
              {running ? "Solving…" : "Run field model"}
            </button>
            {sweepValues.length > 0 && (
              <button
                onClick={runSweep}
                disabled={sweep.running || geometry.pending || blocked !== null}
              >
                {sweep.running
                  ? `Sweeping ${sweep.done + 1}/${sweep.total}…`
                  : `Run ${sweepValues.length}-point sweep`}
              </button>
            )}
            <p className="note" style={{ margin: 0 }}>
              Runs in a background worker — the page stays usable. A repeated-event train and the
              face-resolved model both take noticeably longer than a single axisymmetric stop.
            </p>
          </div>

          {blocked && (
            <div className="panel" style={{ padding: 16, borderLeft: "2px solid var(--bad)" }}>
              <strong style={{ color: "var(--bad)" }}>Cannot run:</strong> {blocked}
            </div>
          )}
          {error && (
            <div className="panel" style={{ padding: 16, borderLeft: "2px solid var(--bad)" }}>
              <strong style={{ color: "var(--bad)" }}>Solver error:</strong> {error}
            </div>
          )}

          {result && (
            <FieldResults
              field={result}
              running={running}
              geometry={geometry}
              material={activeMaterial}
              scenario={scenario}
              axle={axle}
              isBand={effectiveInput === "band"}
              bandTemperatureC={bandTemperatureC}
              eventDurationS={eventDurationS}
              snapIndex={Math.min(snapIndex, result.snapTimesS.length - 1)}
              setSnapIndex={setSnapIndex}
              fieldView={fieldView}
              setFieldView={setFieldView}
              detailTab={detailTab}
              setDetailTab={setDetailTab}
              sweepResults={sweep.results}
              sweepValues={sweepValues}
              sweepError={sweep.error}
            />
          )}

          {!result && !running && !error && !blocked && (
            <div className="panel" style={{ padding: 18 }}>
              <p style={{ margin: 0, color: "var(--dim)" }}>
                No field solved yet. The finite-difference model resolves the actual temperature
                distribution rather than a single average, and costs real time to run — press
                <strong> Run field model</strong> when the geometry and event above are set.
              </p>
            </div>
          )}
        </>
      )}

      {comparing && (
        <p className="note">
          Comparing {compared.length} scenarios. This page shows the active scenario only: a field
          is a heatmap and cannot be overlaid legibly, and the uploaded-geometry and face-resolved
          paths depend on settings that live on this page rather than in the scenario — comparing
          those would be inventing geometry rather than comparing it.
        </p>
      )}

      <p className="note">
        Assumptions: pad heat is smeared over the full annulus (rotation is fast relative to
        through-thickness diffusion), so instantaneous pad-contact flash temperatures are not
        resolved — the semi-infinite cross-check bounds the surface rise. Uploaded sections are
        rasterized onto the grid (curved edges stair-step at cell size; refine the grid for detail)
        and are axisymmetric, so circumferential features can only be smeared — the face-resolved
        model is what represents them properly.
      </p>
    </>
  );
}

// --- quick sizing -------------------------------------------------------------

interface QuickResult {
  mass?: number;
  capacity?: number;
  singleRise?: number;
  train?: RepeatedEventResult;
  error: string | null;
}

function QuickSizing({
  quick,
  energyJ,
  ambient,
  allowable,
  scenario,
}: {
  quick: QuickResult;
  energyJ: number;
  ambient: number;
  allowable: number;
  scenario: Scenario;
}) {
  if (quick.error || !quick.train) {
    return (
      <div className="panel" style={{ padding: 16, borderLeft: "2px solid var(--bad)" }}>
        <strong style={{ color: "var(--bad)" }}>Needs input:</strong> {quick.error}
      </div>
    );
  }
  const train = quick.train;
  return (
    <>
      <div className="metrics">
        <Metric label="Worst-case event energy" value={`${(energyJ / 1000).toFixed(1)} kJ`} />
        <Metric label="Rotor mass (modelled)" value={`${(quick.mass ?? 0).toFixed(3)} kg`} />
        <Metric
          label="Single-stop rise"
          value={`${(quick.singleRise ?? 0).toFixed(0)} °C`}
          delta={`to ${(ambient + (quick.singleRise ?? 0)).toFixed(0)} °C from ${ambient.toFixed(0)} °C`}
        />
        <Metric
          label="Cyclic peak (repeated)"
          value={`${train.cyclic_peak_temperature_c.toFixed(0)} °C`}
          delta={`${(train.cyclic_peak_temperature_c - allowable).toFixed(0)} °C vs allowable`}
          tone={train.cyclic_peak_temperature_c > allowable ? "bad" : "ok"}
        />
        <Metric
          label="Events to converge"
          value={
            train.events_to_convergence == null
              ? "did not converge"
              : String(train.events_to_convergence)
          }
        />
      </div>
      <Chart
        title="Peak temperature per event (lumped)"
        height={300}
        data={[
          {
            x: train.peak_temperatures_c.map((_, i) => i + 1),
            y: train.peak_temperatures_c,
            type: "scatter", mode: "lines+markers", name: scenarioLabel(scenario),
          },
          {
            x: [1, train.peak_temperatures_c.length],
            y: [allowable, allowable],
            type: "scatter", mode: "lines", name: "allowable",
            line: { dash: "dash", color: "#EF5350" },
          },
        ]}
        layout={{ xaxis: { title: { text: "Event" } }, yaxis: { title: { text: "Peak, °C" } } }}
      />
      <p className="note">
        The lumped model spreads each event's energy evenly through the rotor, so it answers "does
        heat accumulate over a run" but not "where does it get hot". Switch to the field model for
        the distribution, the real geometry, and thermal growth.
      </p>
    </>
  );
}

// --- field results ------------------------------------------------------------

interface FieldResultsProps {
  field: SolverOk;
  running: boolean;
  geometry: ResolvedGeometry;
  material: RotorMaterial;
  scenario: Scenario;
  axle: Axle;
  isBand: boolean;
  bandTemperatureC: number;
  eventDurationS: number;
  snapIndex: number;
  setSnapIndex: (i: number) => void;
  fieldView: FieldView;
  setFieldView: (v: FieldView) => void;
  detailTab: DetailTab;
  setDetailTab: (t: DetailTab) => void;
  sweepResults: SolverOk[];
  sweepValues: number[];
  sweepError: string | null;
}

function FieldResults(props: FieldResultsProps) {
  const {
    field, running, geometry, material, scenario, axle, isBand, bandTemperatureC,
    eventDurationS, snapIndex, setSnapIndex, fieldView, setFieldView,
    detailTab, setDetailTab, sweepResults, sweepValues, sweepError,
  } = props;

  const allowable = scenario.conditions.allowable_rotor_temperature_c;
  const isFace = field.kind === "face";
  const timeS = field.snapTimesS[snapIndex] ?? 0;
  const hw = axleOf(scenario, axle);

  const grid = useMemo(() => snapshotGrid(field, snapIndex), [field, snapIndex]);
  const profile = useMemo(() => surfaceProfile(field, snapIndex), [field, snapIndex]);
  const rMm = useMemo(() => field.colAxisM.map((v) => v * 1000), [field]);

  return (
    <div style={{ opacity: running ? 0.45 : 1 }}>
      {isFace ? (
        <div className="metrics">
          <Metric
            label="Peak temperature (hot spot)"
            value={`${field.peakC.toFixed(0)} °C`}
            delta={`${(field.peakC - allowable).toFixed(0)} °C vs allowable`}
            tone={field.peakC > allowable ? "bad" : "ok"}
          />
          <Metric label="Hot-spot delta" value={`${(field.hotSpotDeltaC ?? 0).toFixed(1)} °C`} />
          <Metric
            label="Peak location"
            value={`(${(field.peakLocationMm?.[0] ?? 0).toFixed(0)}, ${(field.peakLocationMm?.[1] ?? 0).toFixed(0)}) mm`}
          />
          <Metric label="Pad contact area" value={`${((field.fluxAreaM2 ?? 0) * 1e4).toFixed(1)} cm²`} />
          <Metric label="Face mass (modeled)" value={`${(field.sectionMassKg ?? 0).toFixed(3)} kg`} />
          <Metric label="Lumped rise (comparison)" value={`${field.lumpedDeltaTC.toFixed(0)} °C`} />
          <Metric
            label="Energy balance error"
            value={`${(field.energyBalanceErrorFraction * 100).toFixed(2)} %`}
          />
        </div>
      ) : isBand ? (
        <div className="metrics">
          <Metric label="Swept-band temperature (held)" value={`${bandTemperatureC.toFixed(0)} °C`} />
          <Metric label="Time to steady state" value={`${field.peakTimeS.toFixed(0)} s`} />
          <Metric
            label="Steady bulk average"
            value={`${(field.bulkHistoryC[field.bulkHistoryC.length - 1] ?? 0).toFixed(0)} °C`}
          />
          <Metric label="Coolest metal at steady state" value={`${field.coolestMetalC.toFixed(0)} °C`} />
        </div>
      ) : (
        <div className="metrics">
          <Metric
            label="Peak swept-band surface temp"
            value={`${field.peakC.toFixed(0)} °C`}
            delta={`${(field.peakC - allowable).toFixed(0)} °C vs allowable`}
            tone={field.peakC > allowable ? "bad" : "ok"}
          />
          <Metric label="Time of peak" value={`${field.peakTimeS.toFixed(2)} s`} />
          <Metric label="Lumped rise (comparison)" value={`${field.lumpedDeltaTC.toFixed(0)} °C`} />
          <Metric
            label="Semi-infinite cross-check"
            value={`${(field.analyticSurfaceRiseC ?? 0).toFixed(0)} °C`}
          />
          <Metric
            label="Energy balance error"
            value={`${(field.energyBalanceErrorFraction * 100).toFixed(2)} %`}
          />
          {field.sectionMassKg !== null && (
            <Metric label="Section mass (modeled)" value={`${field.sectionMassKg.toFixed(3)} kg`} />
          )}
          {field.fluxAreaM2 !== null && (
            <Metric
              label="Pad contact area (both faces)"
              value={`${(field.fluxAreaM2 * 1e4).toFixed(1)} cm²`}
            />
          )}
        </div>
      )}

      {field.train && (
        <div className="metrics">
          <Metric
            label="Converged"
            value={field.train.converged ? "yes" : "NO"}
            tone={field.train.converged ? "ok" : "warn"}
          />
          <Metric label="Events run" value={String(field.train.eventsRun)} />
          <Metric
            label={isFace ? "Cyclic peak (hot spot)" : "Cyclic peak surface"}
            value={`${field.train.cyclicPeakC.toFixed(0)} °C`}
            tone={field.train.cyclicPeakC > allowable ? "bad" : "ok"}
          />
          {field.train.cyclicHotSpotDeltaC !== null ? (
            <Metric
              label="Cyclic hot-spot delta"
              value={`${field.train.cyclicHotSpotDeltaC.toFixed(1)} °C`}
            />
          ) : (
            <Metric
              label="Surface − bulk at peak"
              value={`${(field.train.surfaceMinusBulkAtPeakC ?? 0).toFixed(0)} °C`}
            />
          )}
        </div>
      )}

      {/* --- snapshot scrubber ------------------------------------------------ */}
      <div className="controls" style={{ marginTop: 6, marginBottom: 8 }}>
        <div className="field" style={{ flex: 1, minWidth: 320 }}>
          <label htmlFor="th-snap">
            Snapshot time — {timeS.toFixed(2)} s of{" "}
            {(field.snapTimesS[field.snapTimesS.length - 1] ?? 0).toFixed(1)} s
            {field.snapSpan === "run" ? " (whole run)" : ""}
          </label>
          <input
            id="th-snap" type="range" min={0} max={Math.max(field.snapTimesS.length - 1, 0)}
            step={1} value={snapIndex} style={{ width: "100%" }}
            onChange={(e) => setSnapIndex(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Field view">
        {(
          [
            ["face", "Rotor face view"],
            ["xsec", "Cross-section T(r, z)"],
          ] as Array<[FieldView, string]>
        ).map(([id, label]) => (
          <button
            key={id} className={`tab${fieldView === id ? " active" : ""}`}
            onClick={() => setFieldView(id)} role="tab" aria-selected={fieldView === id}
          >
            {label}
          </button>
        ))}
      </div>

      {fieldView === "face" ? (
        <FaceView
          field={field} geometry={geometry} grid={grid} profile={profile} rMm={rMm} timeS={timeS}
        />
      ) : isFace ? (
        <p className="note">
          The face-resolved model is a thin plate — it has no through-thickness axis. Switch to the
          axisymmetric model for the T(r, z) cross-section.
        </p>
      ) : (
        <CrossSectionView field={field} grid={grid} rMm={rMm} timeS={timeS} />
      )}

      {!isBand && <HeatAnimation field={field} geometry={geometry} />}

      <div className="tabs" role="tablist" aria-label="Detail" style={{ marginTop: 22 }}>
        {(["profiles", "growth", "energy"] as DetailTab[]).map((id) => (
          <button
            key={id} className={`tab${detailTab === id ? " active" : ""}`}
            onClick={() => setDetailTab(id)} role="tab" aria-selected={detailTab === id}
          >
            {id}
          </button>
        ))}
      </div>

      {detailTab === "profiles" && (
        <ProfilesTab
          field={field} geometry={geometry} allowable={allowable}
          eventDurationS={eventDurationS} gapS={scenario.conditions.event_gap_s}
        />
      )}
      {detailTab === "growth" && (
        <>
          {sweepValues.length > 0 && (
            <SweepComparison
              results={sweepResults} values={sweepValues} isBand={isBand}
              material={material} ambientC={scenario.conditions.ambient_temperature_c}
              bobbinCircleMm={hw.bobbin_circle_diameter_mm ?? 145} allowable={allowable}
              error={sweepError}
            />
          )}
          <GrowthTab
            field={field}
            geometry={geometry}
            material={material}
            ambientC={scenario.conditions.ambient_temperature_c}
            bobbinCircleDefaultMm={hw.bobbin_circle_diameter_mm ?? 145}
            snapIndex={snapIndex}
          />
        </>
      )}
      {detailTab === "energy" && <EnergyTab field={field} isBand={isBand} />}
    </div>
  );
}

// --- field views --------------------------------------------------------------

function FaceView({
  field,
  geometry,
  grid,
  profile,
  rMm,
  timeS,
}: {
  field: SolverOk;
  geometry: ResolvedGeometry;
  grid: Grid;
  profile: Array<number | null>;
  rMm: number[];
  timeS: number;
}) {
  const [showRings, setShowRings] = useState(false);
  const isFace = field.kind === "face";

  const data = useMemo(() => {
    const traces: Array<Record<string, unknown>> = [];
    if (isFace) {
      // Already an in-plane field: voids are NaN where they were drawn.
      traces.push({
        z: grid,
        x: field.colAxisM.map((v) => v * 1000),
        y: field.rowAxisM.map((v) => v * 1000),
        type: "heatmap", colorscale: HEAT_SCALE, colorbar: { title: { text: "°C" } },
      });
    } else {
      const raster = sweepProfileToFace(rMm, profile, geometry.faceHoles);
      if (raster) {
        traces.push({
          z: raster.z, x: raster.axisMm, y: raster.axisMm,
          type: "heatmap", colorscale: HEAT_SCALE, colorbar: { title: { text: "°C" } },
        });
      }
    }
    if (geometry.plan) {
      const paths: Array<Array<[number, number]>> = geometry.plan.outline_paths_mm.map((p) =>
        p.map((q) => [q[0], q[1]] as [number, number]),
      );
      for (const [cx, cy, r] of geometry.plan.hole_centers_mm) {
        const { x, y } = circleXY(r, 25);
        paths.push(x.map((v, i) => [v + cx, y[i]! + cy] as [number, number]));
      }
      const linework = flattenPaths(paths);
      traces.push({
        x: linework.x, y: linework.y, type: "scatter", mode: "lines",
        line: { color: "rgba(255,255,255,0.55)", width: 1 },
        hoverinfo: "skip", showlegend: false,
      });
    } else {
      for (const band of geometry.holeBands) {
        const { x, y } = circleXY(band.center_radius_mm);
        traces.push({
          x, y, type: "scatter", mode: "lines",
          line: { dash: "dot", color: "rgba(255,255,255,0.6)", width: 1 },
          hovertext: `${band.count} × ${band.hole_diameter_mm} mm holes`,
          showlegend: false,
        });
      }
    }
    if (showRings && rMm.length) {
      const rOuter = Math.max(...rMm);
      const rInner = Math.min(...rMm);
      const step = rOuter > 60 ? 10 : 5;
      for (let radius = Math.ceil(rInner / step) * step; radius <= rOuter + 0.1; radius += step) {
        const { x, y } = circleXY(radius);
        traces.push({
          x, y, type: "scatter", mode: "lines",
          line: { dash: "dash", color: "rgba(180,180,180,0.4)", width: 1 },
          hoverinfo: "skip", showlegend: false,
        });
      }
    }
    return traces as never[];
  }, [isFace, grid, field, geometry, rMm, profile, showRings]);

  return (
    <>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <input
          type="checkbox" checked={showRings} onChange={(e) => setShowRings(e.target.checked)}
          style={{ width: 13, height: 13, padding: 0 }}
        />
        <span style={{ color: "var(--dim)", fontSize: 12 }}>Radial grid lines</span>
      </label>
      <Chart
        title={`Friction-face temperature at t = ${timeS.toFixed(2)} s${isFace ? " (face-resolved: real hot spots)" : " (axisymmetric sweep)"}`}
        height={480}
        equalAspect
        data={data}
        layout={{ xaxis: { visible: false }, yaxis: { visible: false }, showlegend: false }}
      />
      <p className="note">
        {isFace
          ? "Face-resolved thin-plate model: every hole, slot and the true inner contour are voids in the conduction domain, so hot spots between features are real solve results — ligaments constricted by voids run hotter, and the reduced contact area raises flux everywhere. Temperature is uniform through the thickness (thin-plate assumption)."
          : geometry.plan
            ? "The model is axisymmetric, so temperature varies with radius only — this view sweeps the friction-face radial profile around the disc, laid onto the uploaded drawing: holes are punched at their drawn positions and the DXF linework is overlaid. Hole cooling is smeared azimuthally in the solver, so discrete hot spots between holes are not resolved."
            : "The model is axisymmetric, so temperature varies with radius only — this view sweeps the friction-face radial profile around the disc. Dotted rings mark cross-drilling bands (their cooling is smeared azimuthally; discrete hot spots between holes are not resolved)."}
      </p>
    </>
  );
}

function CrossSectionView({
  field,
  grid,
  rMm,
  timeS,
}: {
  field: SolverOk;
  grid: Grid;
  rMm: number[];
  timeS: number;
}) {
  // The annulus models a half thickness with an adiabatic mid-plane, so the
  // display mirrors it — showing only half would read as a rotor half as thick.
  const mirrored = field.kind === "annulus";
  const z = mirrored ? mirrorAnnulus(grid) : grid;
  const zAxis = mirrored ? mirrorAxisMm(field.rowAxisM) : field.rowAxisM.map((v) => v * 1000);

  return (
    <Chart
      title={`T(r, z) at t = ${timeS.toFixed(2)} s (pad heat enters the friction faces)`}
      height={380}
      data={[
        {
          z, x: rMm, y: zAxis, type: "heatmap",
          colorscale: HEAT_SCALE, colorbar: { title: { text: "°C" } },
        } as never,
      ]}
      layout={{
        xaxis: { title: { text: "Radius (mm)" } },
        yaxis: { title: { text: "Axial (mm)" } },
      }}
    />
  );
}

// --- heat animation -----------------------------------------------------------

/** Frames × cells the browser will hold for one animation.
 *
 * A face frame is n_px² — 58 k cells at the 241-px default — so a 12-stop face
 * train is millions of cells. The stride defaults high enough to stay inside
 * this budget; the control stays unbounded so typing 1 back in still gets every
 * frame on a machine that can take it. */
const ANIM_CELL_BUDGET = 1_500_000;

function HeatAnimation({ field, geometry }: { field: SolverOk; geometry: ResolvedGeometry }) {
  const [on, setOn] = useState(false);
  const [view, setView] = useState<FieldView>(field.kind === "face" ? "face" : "xsec");

  const cellsPerFrame = field.nRows * field.nCols;
  const autoStride = Math.max(
    1,
    Math.ceil((field.snapTimesS.length * cellsPerFrame) / ANIM_CELL_BUDGET),
  );
  const [stride, setStride] = useState(autoStride);
  useEffect(() => setStride(autoStride), [autoStride]);

  const animation = useMemo(() => {
    if (!on) return null;
    const indices: number[] = [];
    for (let i = 0; i < field.snapTimesS.length; i += Math.max(stride, 1)) indices.push(i);
    if (!indices.length) return null;

    const isFace = field.kind === "face";
    const faceView = view === "face";
    const rMm = field.colAxisM.map((v) => v * 1000);

    // The colour scale is locked across every frame so brightness is comparable
    // frame to frame; autoranging per frame would make a cooling rotor look
    // just as hot as a glowing one.
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const v of field.snapData) {
      if (!Number.isFinite(v)) continue;
      if (v < zmin) zmin = v;
      if (v > zmax) zmax = v;
    }

    let faceAxis: number[] | null = null;
    const frames = indices.map((i) => {
      const label = `${field.snapTimesS[i]!.toFixed(1)} s`;
      if (isFace) return { label, z: snapshotGrid(field, i) };
      if (!faceView) {
        const grid = snapshotGrid(field, i);
        return { label, z: field.kind === "annulus" ? mirrorAnnulus(grid) : grid };
      }
      const raster = sweepProfileToFace(rMm, surfaceProfile(field, i), geometry.faceHoles, 161);
      if (raster && !faceAxis) faceAxis = raster.axisMm;
      return { label, z: raster?.z ?? snapshotGrid(field, i) };
    });

    const polar = isFace || faceView;
    const axes = isFace
      ? { x: rMm, y: field.rowAxisM.map((v) => v * 1000) }
      : faceView
        ? { x: faceAxis ?? rMm, y: faceAxis ?? rMm }
        : {
            x: rMm,
            y:
              field.kind === "annulus"
                ? mirrorAxisMm(field.rowAxisM)
                : field.rowAxisM.map((v) => v * 1000),
          };

    return { frames, axes, zmin, zmax, shown: indices.length, total: field.snapTimesS.length, polar };
  }, [on, stride, view, field, geometry.faceHoles]);

  const across = field.snapSpan === "run" ? "across the run" : "across the stop";

  return (
    <>
      <h3 style={{ margin: "22px 0 6px", fontSize: 14 }}>
        Heat spread animation (real time {across})
      </h3>
      <p className="note" style={{ marginTop: 0 }}>
        Press play to watch heat enter at the friction faces and diffuse{" "}
        {field.kind === "face" ? "outward around the holes and slots" : "inward"}
        {field.snapSpan === "run"
          ? " during each stop, then relax through the gaps between them. "
          : " through the stop and the cool-down that follows it. "}
        The colour scale is locked across all frames so brightness is comparable frame to frame.
      </p>
      <div className="controls">
        <div className="field">
          <label>&nbsp;</label>
          <button className={on ? undefined : "primary"} onClick={() => setOn((v) => !v)}>
            {on ? "Hide animation" : "Build heat animation"}
          </button>
        </div>
        {on && (
          <>
            <div className="field">
              <label htmlFor="an-stride">Frame stride (1 = every frame)</label>
              <input
                id="an-stride" type="number" step={1} min={1} value={stride}
                onChange={(e) => setStride(Math.max(Number(e.target.value), 1))}
              />
            </div>
            {field.kind !== "face" && (
              <div className="field">
                <label htmlFor="an-view">Animate</label>
                <select
                  id="an-view" style={{ width: 200 }} value={view}
                  onChange={(e) => setView(e.target.value as FieldView)}
                >
                  <option value="xsec">Cross-section T(r, z)</option>
                  <option value="face">Rotor face</option>
                </select>
              </div>
            )}
          </>
        )}
      </div>

      {on && animation && (
        <>
          <AnimatedChart
            title={`${animation.polar ? "Friction-face" : "Through-thickness"} heat spread ${across}`}
            height={animation.polar ? 500 : 400}
            equalAspect={animation.polar}
            data={[
              {
                z: animation.frames[0]!.z,
                x: animation.axes.x,
                y: animation.axes.y,
                type: "heatmap",
                colorscale: HEAT_SCALE,
                zmin: animation.zmin,
                zmax: animation.zmax,
                colorbar: { title: { text: "°C" } },
              } as never,
            ]}
            frames={animation.frames.map((f) => ({
              label: f.label,
              traces: [0],
              data: [{ z: f.z, type: "heatmap" } as never],
            }))}
            layout={
              animation.polar
                ? { xaxis: { visible: false }, yaxis: { visible: false }, showlegend: false }
                : {
                    xaxis: { title: { text: "Radius (mm)" } },
                    yaxis: { title: { text: "Axial (mm)" } },
                    showlegend: false,
                  }
            }
          />
          <p className="note">
            {animation.shown} frames of {animation.total} ·{" "}
            {(field.snapTimesS[field.snapTimesS.length - 1] ?? 0).toFixed(0)} s of{" "}
            {field.snapSpan === "run" ? "run time" : "stop + cool-down"}
          </p>
        </>
      )}
    </>
  );
}

// --- profiles -----------------------------------------------------------------

function ProfilesTab({
  field,
  geometry,
  allowable,
  eventDurationS,
  gapS,
}: {
  field: SolverOk;
  geometry: ResolvedGeometry;
  allowable: number;
  eventDurationS: number;
  gapS: number;
}) {
  const isFace = field.kind === "face";
  const rMm = useMemo(() => field.colAxisM.map((v) => v * 1000), [field]);

  // Up to five snapshots spread across the run, so the reader sees the profile
  // build and relax rather than one frozen instant.
  const profileTraces = useMemo(() => {
    if (isFace) {
      const bins = (field.radialBinsM ?? []).map((v) => v * 1000);
      return [
        { x: bins, y: field.radialMaxC ?? [], name: "azimuthal max (hot spots)" },
        { x: bins, y: field.radialMeanC ?? [], name: "azimuthal mean" },
        { x: bins, y: field.radialMinC ?? [], name: "azimuthal min" },
      ].map((t) => ({ ...t, type: "scatter" as const, mode: "lines" as const }));
    }
    const count = Math.min(5, field.snapTimesS.length);
    const picks = new Set<number>();
    for (let k = 0; k < count; k++) {
      picks.add(Math.round(((field.snapTimesS.length - 1) * k) / Math.max(count - 1, 1)));
    }
    return [...picks]
      .sort((a, b) => a - b)
      .map((i) => ({
        x: rMm,
        y: surfaceProfile(field, i),
        type: "scatter" as const,
        mode: "lines" as const,
        name: `${field.snapTimesS[i]!.toFixed(2)} s`,
      }));
  }, [field, isFace, rMm]);

  const bandBounds = useMemo<[number, number]>(() => {
    if (field.sweptRBoundsM) {
      return [field.sweptRBoundsM[0] * 1000, field.sweptRBoundsM[1] * 1000];
    }
    if (geometry.plan) {
      const hi = geometry.plan.outer_diameter_mm / 2 - geometry.padOffsetMm;
      return [hi - geometry.padDepthMm, hi];
    }
    const hi = rMm.length ? Math.max(...rMm) : 0;
    return [hi - geometry.padDepthMm - geometry.padOffsetMm, hi];
  }, [field, geometry, rMm]);

  const bandShape = {
    type: "rect", xref: "x", yref: "paper",
    x0: bandBounds[0], x1: bandBounds[1], y0: 0, y1: 1,
    fillcolor: "rgba(160,160,160,0.13)", line: { width: 0 }, layer: "below",
  };

  return (
    <>
      <Chart
        title={
          isFace
            ? "Azimuthal max / mean / min vs radius (at the peak snapshot) — the max−mean gap is hot-spot severity"
            : "Friction-face radial temperature profile"
        }
        height={340}
        data={profileTraces as never[]}
        layout={{
          xaxis: { title: { text: "Radius (mm)" } },
          yaxis: { title: { text: "Surface temperature (°C)" } },
          shapes: [bandShape] as never,
          annotations: [
            {
              x: bandBounds[0], y: 1, xref: "x", yref: "paper", yanchor: "bottom",
              text: "pad swept band", showarrow: false,
              font: { size: 10, color: "#7B8088" },
            },
          ] as never,
        }}
      />

      <Chart
        title={`Temperature history${field.train ? " (final converged event)" : ""}`}
        height={320}
        data={[
          {
            x: field.historyTimesS, y: field.peakHistoryC,
            type: "scatter", mode: "lines", name: "peak swept-band surface",
          },
          {
            x: field.historyTimesS, y: field.bulkHistoryC,
            type: "scatter", mode: "lines", name: "bulk (metal average)",
          },
          {
            x: [
              field.historyTimesS[0] ?? 0,
              field.historyTimesS[field.historyTimesS.length - 1] ?? 1,
            ],
            y: [allowable, allowable],
            type: "scatter", mode: "lines", name: "allowable",
            line: { dash: "dash", color: "#EF5350" },
          },
        ]}
        layout={{
          xaxis: { title: { text: "Time (s)" } },
          yaxis: { title: { text: "Temperature (°C)" } },
        }}
      />

      {field.train && (
        <>
          <Chart
            title={`Peak temperature per event (${field.train.eventsRun} events)`}
            height={320}
            data={[
              {
                x: field.train.peakPerEventC.map((_, i) => i + 1),
                y: field.train.peakPerEventC,
                type: "scatter", mode: "lines+markers",
                name: isFace ? "peak (hot spot)" : "peak surface",
              },
              {
                x: field.train.bulkPerEventC.map((_, i) => i + 1),
                y: field.train.bulkPerEventC,
                type: "scatter", mode: "lines+markers", name: "peak bulk",
              },
              {
                x: [1, field.train.eventsRun],
                y: [allowable, allowable],
                type: "scatter", mode: "lines", name: "allowable",
                line: { dash: "dash", color: "#EF5350" },
              },
            ]}
            layout={{
              xaxis: { title: { text: "Event #" } },
              yaxis: { title: { text: "Peak temperature (°C)" } },
            }}
          />

          {field.train.hotSpotDeltasC && (
            <>
              <h3 style={{ margin: "20px 0 6px", fontSize: 14 }}>Hot-spot severity per event</h3>
              <p className="note" style={{ marginTop: 0 }}>
                Per-event hot-spot delta: the hottest cell minus the average around its own radius
                ring. This is <em>relative</em> severity, not absolute temperature — a flat line
                means the ligaments between slots and holes stay a fixed amount hotter than their
                surroundings while everything ratchets up together; a rising line means the
                constricted metal is falling further behind on cooling each stop, which is what
                drives thermal cracking at the slot ends.
              </p>
              <Chart
                title="Hot-spot delta per event (peak minus its own radius ring's mean)"
                height={280}
                data={[
                  {
                    x: field.train.hotSpotDeltasC.map((_, i) => i + 1),
                    y: field.train.hotSpotDeltasC,
                    type: "scatter", mode: "lines+markers", name: "hot-spot delta",
                  },
                ]}
                layout={{
                  xaxis: { title: { text: "Event #" } },
                  yaxis: { title: { text: "Hot-spot delta (°C)" } },
                }}
              />
              <div className="metrics">
                <Metric
                  label="Cyclic hot-spot delta"
                  value={`${(field.train.cyclicHotSpotDeltaC ?? 0).toFixed(1)} °C`}
                />
                <Metric
                  label="Worst hot-spot delta"
                  value={`${Math.max(...field.train.hotSpotDeltasC).toFixed(1)} °C`}
                />
                <Metric
                  label="Change first to last"
                  value={`${(
                    field.train.hotSpotDeltasC[field.train.hotSpotDeltasC.length - 1]! -
                    field.train.hotSpotDeltasC[0]!
                  ).toFixed(1)} °C`}
                />
              </div>
            </>
          )}

          {field.train.trainTimesS &&
            field.train.trainPeakSurfaceC &&
            field.train.trainBulkAverageC && (
              <WholeTrainHistory
                timesS={field.train.trainTimesS}
                peakC={field.train.trainPeakSurfaceC}
                bulkC={field.train.trainBulkAverageC}
                eventsRun={field.train.eventsRun}
                allowable={allowable}
                isFace={isFace}
                eventPeriodS={eventDurationS + gapS}
              />
            )}
        </>
      )}
    </>
  );
}

function WholeTrainHistory({
  timesS,
  peakC,
  bulkC,
  eventsRun,
  allowable,
  isFace,
  eventPeriodS,
}: {
  timesS: number[];
  peakC: number[];
  bulkC: number[];
  eventsRun: number;
  allowable: number;
  isFace: boolean;
  eventPeriodS: number;
}) {
  const totalS = timesS[timesS.length - 1] ?? 0;
  return (
    <>
      <h3 style={{ margin: "20px 0 6px", fontSize: 14 }}>Whole-train temperature history</h3>
      <p className="note" style={{ marginTop: 0 }}>
        The continuous trace over the <em>entire</em> run — every stop and every gap end-to-end, not
        one point per event. Each sawtooth tooth is a braking event spiking the swept-band surface,
        followed by the gap cooling it back down. The surface recovers most of each spike between
        events, but the bulk metal keeps ratcheting up until cooling per gap finally balances the
        heat per stop — that convergence is what sets the cyclic peak.
      </p>
      <Chart
        title={`Rotor temperature across all ${eventsRun} events (${totalS.toFixed(0)} s total)`}
        height={360}
        data={[
          {
            x: timesS, y: peakC, type: "scatter", mode: "lines",
            name: isFace ? "peak swept-band (hot spot)" : "peak swept-band surface",
          },
          { x: timesS, y: bulkC, type: "scatter", mode: "lines", name: "bulk (metal average)" },
          {
            x: [0, totalS], y: [allowable, allowable],
            type: "scatter", mode: "lines", name: "allowable",
            line: { dash: "dash", color: "#EF5350" },
          },
        ]}
        layout={{
          xaxis: { title: { text: "Time (s)" } },
          yaxis: { title: { text: "Temperature (°C)" } },
          // Mark where each braking event starts so the sawtooth reads as events.
          shapes: Array.from({ length: eventsRun }, (_, i) => ({
            type: "line", xref: "x", yref: "paper",
            x0: i * eventPeriodS, x1: i * eventPeriodS, y0: 0, y1: 1,
            line: { color: "rgba(150,150,150,0.3)", width: 1, dash: "dot" },
          })) as never,
        }}
      />
      <div className="metrics">
        <Metric label="Total run time" value={`${totalS.toFixed(0)} s`} />
        <Metric
          label={isFace ? "Max hot spot (whole run)" : "Max surface (whole run)"}
          value={`${Math.max(...peakC).toFixed(0)} °C`}
        />
        <Metric label="Max bulk (whole run)" value={`${Math.max(...bulkC).toFixed(0)} °C`} />
        <Metric
          label={isFace ? "Peak swing per event" : "Surface swing per event"}
          value={`${(Math.max(...peakC) - Math.min(...peakC.slice(-200))).toFixed(0)} °C`}
        />
      </div>
    </>
  );
}

// --- energy -------------------------------------------------------------------

function EnergyTab({ field, isBand }: { field: SolverOk; isBand: boolean }) {
  if (isBand) {
    return (
      <p className="note">
        Fixed swept-band temperature mode prescribes the band temperature instead of an event
        energy, so there is no energy budget to account. Switch the thermal input to braking energy
        to see the cooling breakdown in joules.
      </p>
    );
  }

  const conv = field.train ? field.train.totalConvectiveEnergyJ : field.convectiveEnergyJ;
  const rad = field.train ? field.train.totalRadiativeEnergyJ : field.radiativeEnergyJ;
  const dissipated = conv + rad;
  const energyIn = field.train ? field.train.totalEnergyInJ : field.energyInJ;
  const stored = field.train ? energyIn - dissipated : field.storedEnergyJ;
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const convHistory = field.convectiveEnergyHistoryJ;
  const radHistory = field.radiativeEnergyHistoryJ;

  return (
    <>
      {field.train && (
        <p className="note" style={{ marginTop: 0 }}>
          Cumulative cooling over all {field.train.eventsRun} simulated events (braking + gaps). The
          chart below shows the final converged event only.
        </p>
      )}
      <div className="metrics">
        <Metric
          label={field.train ? "Heat into rotor (all events)" : "Heat into rotor"}
          value={`${fmt(energyIn)} J`}
        />
        <Metric label="Dissipated by convection" value={`${fmt(conv)} J`} />
        <Metric label="Dissipated by radiation" value={`${fmt(rad)} J`} />
        <Metric
          label="Radiative share of cooling"
          value={`${((100 * rad) / Math.max(dissipated, 1e-9)).toFixed(1)} %`}
        />
        <Metric label="Still stored at end" value={`${fmt(stored)} J`} />
      </div>

      {convHistory && radHistory && field.energyInHistoryJ && (
        <>
          <Chart
            title={`Cumulative energy vs time${field.train ? " (final converged event)" : ""}`}
            height={320}
            data={[
              {
                x: field.historyTimesS, y: field.energyInHistoryJ,
                type: "scatter", mode: "lines", name: "heat input (cumulative)",
              },
              {
                x: field.historyTimesS, y: convHistory,
                type: "scatter", mode: "lines", name: "convection dissipated",
              },
              {
                x: field.historyTimesS, y: radHistory,
                type: "scatter", mode: "lines", name: "radiation dissipated",
              },
              {
                x: field.historyTimesS,
                y: convHistory.map((v, i) => v + (radHistory[i] ?? 0)),
                type: "scatter", mode: "lines", name: "total dissipated",
              },
            ]}
            layout={{
              xaxis: { title: { text: "Time (s)" } },
              yaxis: { title: { text: "Energy (J)" } },
            }}
          />
          <p className="note">
            The gap between heat input and total dissipated is what the metal is still holding. Over
            one stop most of the energy stays stored — cooling does its work between events, which
            is why the repeated-events mode is the honest test of whether radiation and convection
            keep up.
          </p>
        </>
      )}
    </>
  );
}

// --- sweep comparison ----------------------------------------------------------

function SweepComparison({
  results,
  values,
  isBand,
  material,
  ambientC,
  bobbinCircleMm,
  allowable,
  error,
}: {
  results: SolverOk[];
  values: number[];
  isBand: boolean;
  material: RotorMaterial;
  ambientC: number;
  bobbinCircleMm: number;
  allowable: number;
  error: string | null;
}) {
  const rows = useMemo(
    () =>
      results.map((r, i) => {
        const growth = sweepGrowthMm(r, material, ambientC, bobbinCircleMm);
        return { value: values[i] ?? 0, result: r, ...growth };
      }),
    [results, values, material, ambientC, bobbinCircleMm],
  );

  if (error) {
    return <p className="note" style={{ color: "var(--bad)" }}>Sweep run failed: {error}</p>;
  }
  if (!rows.length) {
    return (
      <p className="note">
        {values.length} sweep {isBand ? "temperatures" : "energies"} entered under Tuning — press{" "}
        <strong>Run {values.length}-point sweep</strong> above to compare them. Each runs as its own
        single stop.
      </p>
    );
  }

  const lastRow = rows[rows.length - 1]!;

  return (
    <>
      <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Sweep comparison</h3>
      <div className="charts two">
        <Chart
          title={
            isBand
              ? "Thermal growth vs swept-band temperature (from ambient)"
              : "Peak swept-band temperature vs time, per event energy"
          }
          height={320}
          data={
            (isBand
              ? [
                  {
                    x: rows.map((r) => r.value), y: rows.map((r) => r.odMm),
                    type: "scatter", mode: "lines+markers", name: "OD growth (mm)",
                  },
                  {
                    x: rows.map((r) => r.value), y: rows.map((r) => r.bobbinMm),
                    type: "scatter", mode: "lines+markers", name: "bobbin growth (mm)",
                  },
                ]
              : [
                  ...rows.map((r) => ({
                    x: r.result.historyTimesS, y: r.result.peakHistoryC,
                    type: "scatter", mode: "lines", name: `${r.value} kJ`,
                  })),
                  {
                    x: [
                      0,
                      Math.max(
                        ...rows.map((r) => r.result.historyTimesS[r.result.historyTimesS.length - 1] ?? 1),
                      ),
                    ],
                    y: [allowable, allowable],
                    type: "scatter", mode: "lines", name: "allowable",
                    line: { dash: "dash", color: "#EF5350" },
                  },
                ]) as never[]
          }
          layout={{
            xaxis: { title: { text: isBand ? "Band temperature (°C)" : "Time (s)" } },
            yaxis: { title: { text: isBand ? "Radial growth (mm)" : "Peak temperature (°C)" } },
          }}
        />
        <Chart
          title={
            isBand
              ? "Steady-state field vs swept-band temperature"
              : "Peak temperature vs event energy"
          }
          height={320}
          data={
            (isBand
              ? [
                  {
                    x: rows.map((r) => r.value),
                    y: rows.map((r) => r.result.bulkHistoryC[r.result.bulkHistoryC.length - 1] ?? 0),
                    type: "scatter", mode: "lines+markers", name: "steady bulk avg",
                  },
                  {
                    x: rows.map((r) => r.value), y: rows.map((r) => r.result.coolestMetalC),
                    type: "scatter", mode: "lines+markers", name: "coolest metal",
                  },
                ]
              : [
                  {
                    x: rows.map((r) => r.value), y: rows.map((r) => r.result.peakC),
                    type: "scatter", mode: "lines+markers", name: "peak temp",
                  },
                  {
                    x: [rows[0]!.value, lastRow.value],
                    y: [allowable, allowable],
                    type: "scatter", mode: "lines", name: "allowable",
                    line: { dash: "dash", color: "#EF5350" },
                  },
                ]) as never[]
          }
          layout={{
            xaxis: { title: { text: isBand ? "Band temperature (°C)" : "Event energy (kJ)" } },
            yaxis: { title: { text: "Temperature (°C)" } },
          }}
        />
      </div>

      <div className="panel" style={{ padding: 12, overflowX: "auto", marginTop: 12 }}>
        <table>
          <thead>
            {isBand ? (
              <tr>
                <th>Band temp (°C)</th><th>Steady bulk avg (°C)</th><th>Coolest metal (°C)</th>
                <th>Time to steady (s)</th><th>OD growth (mm)</th><th>Bobbin growth (mm)</th>
              </tr>
            ) : (
              <tr>
                <th>Energy (kJ)</th><th>Peak temp (°C)</th><th>Time of peak (s)</th>
                <th>Convection loss (J)</th><th>Radiation loss (J)</th><th>Still stored (J)</th>
                <th>OD growth (mm)</th><th>Bobbin growth (mm)</th>
              </tr>
            )}
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.value}>
                <td>{r.value}</td>
                {isBand ? (
                  <>
                    <td>{(r.result.bulkHistoryC[r.result.bulkHistoryC.length - 1] ?? 0).toFixed(1)}</td>
                    <td>{r.result.coolestMetalC.toFixed(1)}</td>
                    <td>{r.result.peakTimeS.toFixed(0)}</td>
                  </>
                ) : (
                  <>
                    <td>{r.result.peakC.toFixed(1)}</td>
                    <td>{r.result.peakTimeS.toFixed(2)}</td>
                    <td>{r.result.convectiveEnergyJ.toFixed(0)}</td>
                    <td>{r.result.radiativeEnergyJ.toFixed(0)}</td>
                    <td>{r.result.storedEnergyJ.toFixed(0)}</td>
                  </>
                )}
                <td>{r.odMm === null ? "—" : r.odMm.toFixed(3)}</td>
                <td>{r.bobbinMm === null ? "—" : r.bobbinMm.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        Growth values are referenced to ambient and taken at each run's peak state (energy sweeps)
        or steady state (temperature sweeps). The detailed views above still show the single primary
        input value.
      </p>
    </>
  );
}

// --- shared -------------------------------------------------------------------

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
      <div className={`metric-value${tone ? ` ${tone}` : ""}`}>{value}</div>
      {delta && <div className="metric-delta">{delta}</div>}
    </div>
  );
}
