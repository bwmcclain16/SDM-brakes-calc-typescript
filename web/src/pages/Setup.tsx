/** Setup — the car itself, five tabs ordered the way it's built up.
 *
 * Vehicle -> Brake Hardware -> Rotor -> Materials -> Suspension & Aero.
 *
 * Consolidates the five formerly-separate Streamlit pages
 * (`app/setup_sections/{vehicle,hardware,rotor,materials,suspension_aero}.py`),
 * which between them held 33 inputs describing one car, filled in once a
 * season. Operating conditions (driver mass, target deceleration, ambient,
 * allowable rotor temperature, event gap, pedal force) are deliberately NOT
 * here — they describe the stop, not the car, and live in the conditions bar
 * above every page.
 *
 * Vehicle and Brake Hardware edits dispatch `patchVehicle`/`patchBrakes`
 * against the ACTIVE scenario only, which is what makes duplicate-then-change
 * a meaningful comparison. Suspension and aero baselines are NOT part of
 * `Scenario` (there is no `patchSuspension`/`patchAero` action, by design —
 * see `web/src/state/store.ts`), so that tab mirrors the Python page's own
 * treatment of them: bundled reference data plus page-local sweep controls,
 * not editable per-scenario state.
 */
import { useMemo, useState } from "react";
import type { CSSProperties, Dispatch } from "react";
import type Plotly from "plotly.js-dist-min";
import type { PageProps } from "./registry.tsx";
import { Chart, TRACE_COLORS } from "../components/Chart.tsx";
import type { Action, Conditions } from "../state/store.ts";
import type { AxleBrake, BrakeHardware, Caliper, Vehicle } from "@core/models/internal.ts";
import { totalMassKg, staticAxleLoadsN, idealFrontBrakeFraction } from "@core/solvers/vehicle.ts";
import {
  areaRatioFrontToRear,
  pressureRatioFrontToRear,
  frontAxleTorqueDistribution,
  effectiveRotorRadiusM,
} from "@core/solvers/brakeBias.ts";
import {
  parseRotorMaterials,
  parseFastenerMaterials,
  parsePadFrictionModels,
  parseSuspension,
  parseCoefficientAero,
  parseRotorSetup,
  applyRotorSetup,
  type RotorSetupConfig,
} from "@core/config.ts";
import {
  wheelRateNPerM,
  rideRateNPerM,
  axleRollStiffnessNmPerRad,
  lateralLoadTransfer,
  totalN,
} from "@core/models/suspension.ts";
import { coefficientAxleDownforceN, coefficientDragN, cpPositionM } from "@core/solvers/aero.ts";

import rotorMaterialsRaw from "@data/materials/rotor_materials.json";
import fastenerMaterialsRaw from "@data/materials/fastener_materials.json";
import padCompoundsRaw from "@data/materials/pad_compounds.json";
import brakeFluidsRaw from "@data/materials/brake_fluids.json";
import suspensionRaw from "@data/suspension/baseline_suspension.json";
import aeroRaw from "@data/aero/baseline_coefficient_aero.json";
import rotorSetupBaselineRaw from "@data/rotors/fsae_2026_baseline_rotors.json";
import rotorSetupSdm26Raw from "@data/rotors/SDM26_Rotor.json";

// --- bundled reference data, parsed once at module load (same pattern as
// Curved.tsx's TIRE/SUSPENSION constants) --------------------------------

const ROTOR_MATERIALS = parseRotorMaterials(rotorMaterialsRaw);
const FASTENER_MATERIALS = parseFastenerMaterials(fastenerMaterialsRaw);
const PAD_COMPOUNDS = parsePadFrictionModels(padCompoundsRaw);
const SUSPENSION = parseSuspension(suspensionRaw);
const AERO = parseCoefficientAero(aeroRaw);

interface RotorSetupOption {
  label: string;
  setup: RotorSetupConfig;
}

const ROTOR_SETUPS: RotorSetupOption[] = [
  {
    label: "FSAE 2026 baseline rotors (data/rotors/fsae_2026_baseline_rotors.json)",
    setup: parseRotorSetup(rotorSetupBaselineRaw),
  },
  { label: "SDM26 rotor (data/rotors/SDM26_Rotor.json)", setup: parseRotorSetup(rotorSetupSdm26Raw) },
];

// --- raw shapes for the read-only reference tables -------------------------
// The config.ts parse functions (above) keep only what the solvers need;
// these interfaces cover the extra provenance/description columns the
// Python data_editor tables showed, read straight off the bundled JSON.

interface SourceBlock {
  source_title?: string;
  confidence?: string;
}

interface RotorMaterialRow {
  name: string;
  density_kg_m3: number;
  specific_heat_J_kgK: number;
  thermal_conductivity_W_mK?: number | null;
  yield_strength_Pa?: number | null;
  confidence?: string;
}

interface FastenerMaterialRow {
  name: string;
  yield_strength_Pa: number;
  ultimate_strength_Pa?: number | null;
  density_kg_m3?: number | null;
  confidence?: string;
}

interface PadCompoundRow {
  name: string;
  manufacturer?: string;
  compound?: string;
  friction_coefficient?: number;
  mu_range?: [number, number];
  max_recommended_temperature_C?: number;
  source?: SourceBlock;
}

interface BrakeFluidRow {
  name: string;
  manufacturer?: string;
  dot_rating?: string;
  dry_boiling_point_c: number;
  wet_boiling_point_c?: number | null;
  source?: SourceBlock;
}

const ROTOR_MATERIAL_ROWS = (rotorMaterialsRaw as unknown as { materials: RotorMaterialRow[] }).materials;
const FASTENER_MATERIAL_ROWS = (fastenerMaterialsRaw as unknown as { materials: FastenerMaterialRow[] })
  .materials;
const PAD_COMPOUND_ROWS = (padCompoundsRaw as unknown as { pads: PadCompoundRow[] }).pads;
const BRAKE_FLUID_ROWS = (brakeFluidsRaw as unknown as { fluids: BrakeFluidRow[] }).fluids;

// --- small shared helpers ----------------------------------------------------

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function firstKey(record: Record<string, unknown>): string {
  return Object.keys(record)[0] ?? "";
}

/** Patches one axle of `brakes`, merging `patch` over its current fields.
 * Written as an explicit if/else (rather than a computed `{ [axleKey]: ... }`
 * literal) so the result is unambiguously `Partial<BrakeHardware>`. */
function patchAxle(
  dispatch: Dispatch<Action>,
  brakes: BrakeHardware,
  axleKey: "front" | "rear",
  patch: Partial<AxleBrake>,
): void {
  const updated: AxleBrake = { ...brakes[axleKey], ...patch };
  const brakesPatch: Partial<BrakeHardware> = axleKey === "front" ? { front: updated } : { rear: updated };
  dispatch({ type: "patchBrakes", patch: brakesPatch });
}

function patchCaliper(
  dispatch: Dispatch<Action>,
  brakes: BrakeHardware,
  axleKey: "front" | "rear",
  patch: Partial<Caliper>,
): void {
  patchAxle(dispatch, brakes, axleKey, { caliper: { ...brakes[axleKey].caliper, ...patch } });
}

// --- small form controls ------------------------------------------------------

function NumField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          // Unbounded by design: physically impossible values are caught at
          // the solver with a clear error rather than clamped silently here.
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

const gridTwo: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
  gap: 14,
};

// --- Vehicle tab ----------------------------------------------------------

function VehicleTab({
  vehicle,
  conditions,
  dispatch,
}: {
  vehicle: Vehicle;
  conditions: Conditions;
  dispatch: Dispatch<Action>;
}) {
  const patch = (p: Partial<Vehicle>) => dispatch({ type: "patchVehicle", patch: p });

  const totalMass = totalMassKg(vehicle, conditions.driver_mass_kg);
  const [frontStaticN, rearStaticN] = staticAxleLoadsN(vehicle, conditions.driver_mass_kg);
  const idealBiasPct = idealFrontBrakeFraction(vehicle, conditions.target_deceleration_g) * 100;

  return (
    <div>
      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">Total Mass (w/ driver)</div>
          <div className="metric-value num">{fmt(totalMass, 1)} kg</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Static Front Load</div>
          <div className="metric-value num">{fmt(frontStaticN, 0)} N</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Static Rear Load</div>
          <div className="metric-value num">{fmt(rearStaticN, 0)} N</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">CG Height / Wheelbase</div>
          <div className="metric-value num">{fmt(vehicle.cg_height_m / vehicle.wheelbase_m, 3)}</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Ideal Bias @ {fmt(conditions.target_deceleration_g, 2)} g</div>
          <div className="metric-value num">{fmt(idealBiasPct, 1)}%</div>
        </div>
      </div>

      <div className="controls panel" style={{ padding: 13 }}>
        <NumField
          label="Vehicle mass w/o driver, kg"
          value={vehicle.mass_without_driver_kg}
          step={0.5}
          onChange={(v) => patch({ mass_without_driver_kg: v })}
        />
        <NumField
          label="Static front weight fraction"
          value={vehicle.static_front_weight_fraction}
          step={0.001}
          onChange={(v) => patch({ static_front_weight_fraction: v })}
        />
        <NumField
          label="Wheelbase, m"
          value={vehicle.wheelbase_m}
          step={0.001}
          onChange={(v) => patch({ wheelbase_m: v })}
        />
        <NumField
          label="CG height, m"
          value={vehicle.cg_height_m}
          step={0.001}
          onChange={(v) => patch({ cg_height_m: v })}
        />
        <NumField
          label="Front track, m"
          value={vehicle.front_track_m}
          step={0.001}
          onChange={(v) => patch({ front_track_m: v })}
        />
        <NumField
          label="Rear track, m"
          value={vehicle.rear_track_m}
          step={0.001}
          onChange={(v) => patch({ rear_track_m: v })}
        />
        <NumField
          label="Tire rolling radius, m"
          value={vehicle.tire_rolling_radius_m}
          step={0.001}
          onChange={(v) => patch({ tire_rolling_radius_m: v })}
        />
      </div>

      <p className="note">
        Driver mass ({fmt(conditions.driver_mass_kg, 1)} kg) and target deceleration (
        {fmt(conditions.target_deceleration_g, 2)} g) come from the conditions bar above — they describe the
        stop, not the car.
      </p>
    </div>
  );
}

// --- Brake Hardware tab -----------------------------------------------------

function AxleHardwareEditor({
  label,
  axle,
  axleKey,
  brakes,
  dispatch,
}: {
  label: string;
  axle: AxleBrake;
  axleKey: "front" | "rear";
  brakes: BrakeHardware;
  dispatch: Dispatch<Action>;
}) {
  const patch = (p: Partial<AxleBrake>) => patchAxle(dispatch, brakes, axleKey, p);
  const patchCal = (p: Partial<Caliper>) => patchCaliper(dispatch, brakes, axleKey, p);

  return (
    <div className="panel" style={{ padding: 13 }}>
      <h3 style={{ marginBottom: 10 }}>{label}</h3>
      <div className="controls" style={{ marginBottom: 10 }}>
        <NumField
          label="Rotor OD, mm"
          value={axle.rotor_outer_diameter_mm}
          step={1}
          onChange={(v) => patch({ rotor_outer_diameter_mm: v })}
        />
        <NumField
          label="Rotor thickness, mm"
          value={axle.rotor_thickness_mm}
          step={0.1}
          onChange={(v) => patch({ rotor_thickness_mm: v })}
        />
        <NumField
          label="Rotor mass, kg"
          value={axle.rotor_mass_kg}
          step={0.01}
          onChange={(v) => patch({ rotor_mass_kg: v })}
        />
        <NumField
          label="Pad height, mm"
          value={axle.pad_height_mm}
          step={0.5}
          onChange={(v) => patch({ pad_height_mm: v })}
        />
        <NumField
          label="Pad swept OD, mm"
          value={axle.pad_swept_outer_diameter_mm ?? axle.rotor_outer_diameter_mm}
          step={1}
          onChange={(v) => patch({ pad_swept_outer_diameter_mm: v })}
        />
        <NumField
          label="Pad swept ID, mm"
          value={axle.pad_swept_inner_diameter_mm ?? axle.rotor_outer_diameter_mm - 2 * axle.pad_height_mm}
          step={1}
          onChange={(v) => patch({ pad_swept_inner_diameter_mm: v })}
        />
      </div>
      <div className="controls" style={{ marginBottom: 0 }}>
        <TextField label="Caliper name" value={axle.caliper.name} onChange={(v) => patchCal({ name: v })} />
        <NumField
          label="Piston count"
          value={axle.caliper.piston_count}
          step={1}
          onChange={(v) => patchCal({ piston_count: Math.round(v) })}
        />
        <NumField
          label="Piston diameter, mm"
          value={axle.caliper.piston_diameter_mm}
          step={0.5}
          onChange={(v) => patchCal({ piston_diameter_mm: v })}
        />
      </div>
    </div>
  );
}

function HardwareTab({ brakes, dispatch }: { brakes: BrakeHardware; dispatch: Dispatch<Action> }) {
  const patchBrakes = (p: Partial<BrakeHardware>) => dispatch({ type: "patchBrakes", patch: p });

  const frontSplitPct = frontAxleTorqueDistribution(brakes) * 100;
  const areaRatio = areaRatioFrontToRear(brakes);
  const pressureRatio = pressureRatioFrontToRear(brakes);
  const rotorMassTotalKg = 2 * (brakes.front.rotor_mass_kg + brakes.rear.rotor_mass_kg);

  return (
    <div>
      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">Front Torque Distribution</div>
          <div className="metric-value num">{fmt(frontSplitPct, 1)}%</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Area Ratio F/R</div>
          <div className="metric-value num">{fmt(areaRatio, 3)}</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Pressure Ratio F/R</div>
          <div className="metric-value num">{fmt(pressureRatio, 3)}</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Rotor Mass Total (all 4)</div>
          <div className="metric-value num">{fmt(rotorMassTotalKg, 2)} kg</div>
        </div>
      </div>

      <div style={{ ...gridTwo, marginBottom: 16 }}>
        <AxleHardwareEditor label="Front Axle" axle={brakes.front} axleKey="front" brakes={brakes} dispatch={dispatch} />
        <AxleHardwareEditor label="Rear Axle" axle={brakes.rear} axleKey="rear" brakes={brakes} dispatch={dispatch} />
      </div>

      <div className="controls panel" style={{ padding: 13 }}>
        <NumField
          label="Front pressure bias"
          value={brakes.front_pressure_fraction}
          step={0.01}
          onChange={(v) => patchBrakes({ front_pressure_fraction: v, rear_pressure_fraction: 1 - v })}
        />
        <NumField
          label="Front MC bore, mm"
          value={brakes.front_master_cylinder_bore_mm}
          step={0.1}
          onChange={(v) => patchBrakes({ front_master_cylinder_bore_mm: v })}
        />
        <NumField
          label="Rear MC bore, mm"
          value={brakes.rear_master_cylinder_bore_mm}
          step={0.1}
          onChange={(v) => patchBrakes({ rear_master_cylinder_bore_mm: v })}
        />
        <NumField
          label="Pedal ratio"
          value={brakes.pedal_ratio}
          step={0.1}
          onChange={(v) => patchBrakes({ pedal_ratio: v })}
        />
        <NumField
          label="Pedal efficiency"
          value={brakes.pedal_efficiency}
          step={0.01}
          onChange={(v) => patchBrakes({ pedal_efficiency: v })}
        />
        <NumField
          label="Max pedal travel, deg"
          value={brakes.max_pedal_travel_deg}
          step={0.5}
          onChange={(v) => patchBrakes({ max_pedal_travel_deg: v })}
        />
      </div>
      <p className="note">
        Rear pressure fraction auto-balances to 1 − front bias. The two circuits are hydraulically
        independent (dual master cylinders) — the front/rear bore fields above carry the actual hydraulic
        split; pedal efficiency of 1.0 (a lossless pedal) is rejected at the solver.
      </p>
    </div>
  );
}

// --- Rotor tab ----------------------------------------------------------

function tryEffectiveRadiusMm(axle: AxleBrake): { valueMm: number | null; error: string | null } {
  try {
    return { valueMm: effectiveRotorRadiusM(axle) * 1000, error: null };
  } catch (err) {
    return { valueMm: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function sweptBandDepthMm(axle: AxleBrake): number {
  const od = axle.pad_swept_outer_diameter_mm ?? axle.rotor_outer_diameter_mm;
  const id = axle.pad_swept_inner_diameter_mm ?? axle.rotor_outer_diameter_mm - 2 * axle.pad_height_mm;
  return (od - id) / 2;
}

function AxleRotorEditor({
  label,
  axle,
  axleKey,
  brakes,
  dispatch,
}: {
  label: string;
  axle: AxleBrake;
  axleKey: "front" | "rear";
  brakes: BrakeHardware;
  dispatch: Dispatch<Action>;
}) {
  const patch = (p: Partial<AxleBrake>) => patchAxle(dispatch, brakes, axleKey, p);
  const fastenerNames = Object.keys(FASTENER_MATERIALS);

  return (
    <div className="panel" style={{ padding: 13 }}>
      <h3 style={{ marginBottom: 10 }}>{label}</h3>
      <div className="controls" style={{ marginBottom: 10 }}>
        <NumField
          label="Rotor OD, mm"
          value={axle.rotor_outer_diameter_mm}
          step={1}
          onChange={(v) => patch({ rotor_outer_diameter_mm: v })}
        />
        <NumField
          label="Rotor thickness, mm"
          value={axle.rotor_thickness_mm}
          step={0.5}
          onChange={(v) => patch({ rotor_thickness_mm: v })}
        />
        <NumField
          label="Rotor mass, kg"
          value={axle.rotor_mass_kg}
          step={0.001}
          onChange={(v) => patch({ rotor_mass_kg: v })}
        />
        <NumField
          label="Pad height, mm"
          value={axle.pad_height_mm}
          step={0.5}
          onChange={(v) => patch({ pad_height_mm: v })}
        />
        <NumField
          label="Swept OD, mm"
          value={axle.pad_swept_outer_diameter_mm ?? axle.rotor_outer_diameter_mm}
          step={1}
          onChange={(v) => patch({ pad_swept_outer_diameter_mm: v })}
        />
        <NumField
          label="Swept ID, mm"
          value={axle.pad_swept_inner_diameter_mm ?? axle.rotor_outer_diameter_mm - 2 * axle.pad_height_mm}
          step={1}
          onChange={(v) => patch({ pad_swept_inner_diameter_mm: v })}
        />
      </div>

      <p className="note" style={{ marginTop: 0, marginBottom: 10 }}>
        Rotor material: <strong style={{ color: "var(--text)" }}>{axle.rotor_material ?? "—"}</strong> — set
        on the Materials tab, where it applies to both this page and every thermal/expansion calculator.
      </p>

      <span className="eyebrow">Drive buttons (bobbins)</span>
      <div className="controls" style={{ marginTop: 7, marginBottom: 0 }}>
        <NumField
          label="Button count"
          value={axle.bobbin_count ?? 6}
          step={1}
          onChange={(v) => patch({ bobbin_count: Math.round(v) })}
        />
        <NumField
          label="Bolt circle, mm"
          value={axle.bobbin_circle_diameter_mm ?? 145}
          step={1}
          onChange={(v) => patch({ bobbin_circle_diameter_mm: v })}
        />
        <NumField
          label="Button diameter, mm"
          value={axle.bobbin_button_diameter_mm ?? 8}
          step={0.5}
          onChange={(v) => patch({ bobbin_button_diameter_mm: v })}
        />
        <SelectField
          label="Button material"
          value={axle.bobbin_material ?? firstKey(FASTENER_MATERIALS)}
          options={fastenerNames}
          onChange={(v) => patch({ bobbin_material: v })}
        />
      </div>
    </div>
  );
}

function RotorTab({ brakes, dispatch }: { brakes: BrakeHardware; dispatch: Dispatch<Action> }) {
  const [setupIdx, setSetupIdx] = useState(0);

  const applySetup = () => {
    const option = ROTOR_SETUPS[setupIdx];
    if (!option) return;
    // applyRotorSetup overlays only the fields the file sets — any field left
    // null/undefined in the config deliberately keeps the scenario's existing
    // value (see `applyRotorSpecToAxle` in src/config.ts), so applying a
    // partial rotor file never blanks out geometry it doesn't mention.
    const merged = applyRotorSetup(brakes, option.setup);
    dispatch({ type: "patchBrakes", patch: { front: merged.front, rear: merged.rear } });
  };

  const front = tryEffectiveRadiusMm(brakes.front);
  const rear = tryEffectiveRadiusMm(brakes.rear);

  return (
    <div>
      <div className="panel" style={{ padding: 13, marginBottom: 16 }}>
        <h3 style={{ marginBottom: 6 }}>Load a saved rotor configuration</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Overlays rotor geometry and bobbin data onto the active scenario. Fields the file doesn't set keep
          whatever the scenario already has — this never blanks a value the file is silent on.
        </p>
        <div className="controls" style={{ marginBottom: 0 }}>
          <div className="field" style={{ minWidth: 340 }}>
            <label>Rotor config file</label>
            <select value={setupIdx} onChange={(e) => setSetupIdx(Number(e.target.value))}>
              {ROTOR_SETUPS.map((opt, i) => (
                <option key={opt.label} value={i}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <button className="primary" onClick={applySetup} style={{ alignSelf: "flex-end" }}>
            Apply to active scenario
          </button>
        </div>
      </div>

      <div style={{ ...gridTwo, marginBottom: 16 }}>
        <AxleRotorEditor label="Front Rotor" axle={brakes.front} axleKey="front" brakes={brakes} dispatch={dispatch} />
        <AxleRotorEditor label="Rear Rotor" axle={brakes.rear} axleKey="rear" brakes={brakes} dispatch={dispatch} />
      </div>

      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">Front Effective Radius</div>
          <div className={`metric-value num${front.error ? " warn" : ""}`}>
            {front.valueMm != null ? `${fmt(front.valueMm, 1)} mm` : "—"}
          </div>
          {front.error && <div className="metric-delta">{front.error}</div>}
        </div>
        <div className="metric panel">
          <div className="metric-label">Rear Effective Radius</div>
          <div className={`metric-value num${rear.error ? " warn" : ""}`}>
            {rear.valueMm != null ? `${fmt(rear.valueMm, 1)} mm` : "—"}
          </div>
          {rear.error && <div className="metric-delta">{rear.error}</div>}
        </div>
        <div className="metric panel">
          <div className="metric-label">Front Swept Band Depth</div>
          <div className="metric-value num">{fmt(sweptBandDepthMm(brakes.front), 1)} mm</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Rear Swept Band Depth</div>
          <div className="metric-value num">{fmt(sweptBandDepthMm(brakes.rear), 1)} mm</div>
        </div>
      </div>
      <p className="note">
        Effective radius uses the uniform-pressure method over the pad swept band:
        r_eff = (2/3)(r_o&sup3;−r_i&sup3;)/(r_o&sup2;−r_i&sup2;). It needs both swept diameters set — if
        either is missing the card above names the gap instead of guessing.
      </p>
    </div>
  );
}

// --- Materials tab ----------------------------------------------------------

function MaterialsTab({
  brakes,
  conditions,
  dispatch,
}: {
  brakes: BrakeHardware;
  conditions: Conditions;
  dispatch: Dispatch<Action>;
}) {
  const rotorMaterialNames = Object.keys(ROTOR_MATERIALS);
  const padNames = Object.keys(PAD_COMPOUNDS);

  const setPad = (name: string) => {
    const model = PAD_COMPOUNDS[name];
    dispatch({
      type: "patchConditions",
      patch: { pad_label: name, pad_mu: model?.design_mu ?? conditions.pad_mu },
    });
  };

  return (
    <div>
      <div className="panel" style={{ padding: 13, marginBottom: 16 }}>
        <h3 style={{ marginBottom: 6 }}>Active selection</h3>
        <p className="note" style={{ marginTop: 0 }}>
          Applied immediately across every calculator: rotor material feeds the thermal, expansion and
          bobbin-bearing checks; the pad compound sets the conditions bar's design &mu; (
          {fmt(conditions.pad_mu, 2)} today, from &ldquo;{conditions.pad_label}&rdquo;).
        </p>
        <div className="controls" style={{ marginBottom: 0 }}>
          <SelectField
            label="Front rotor material"
            value={brakes.front.rotor_material ?? firstKey(ROTOR_MATERIALS)}
            options={rotorMaterialNames}
            onChange={(v) => patchAxle(dispatch, brakes, "front", { rotor_material: v })}
          />
          <SelectField
            label="Rear rotor material"
            value={brakes.rear.rotor_material ?? firstKey(ROTOR_MATERIALS)}
            options={rotorMaterialNames}
            onChange={(v) => patchAxle(dispatch, brakes, "rear", { rotor_material: v })}
          />
          <SelectField label="Pad compound" value={conditions.pad_label} options={padNames} onChange={setPad} />
        </div>
      </div>

      <p className="note">
        Editing the material database itself (adding an alloy, changing a property) is out of scope for
        this static build — the Python app rewrote its YAML files on disk, which has no equivalent without
        a filesystem. The tables below are bundled, read-only reference data.
      </p>

      <h3 style={{ marginTop: 18, marginBottom: 8 }}>Rotor Materials</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Density (kg/m&sup3;)</th>
              <th>Specific Heat (J/kg&middot;K)</th>
              <th>Conductivity (W/m&middot;K)</th>
              <th>Yield (MPa)</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {ROTOR_MATERIAL_ROWS.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td className="num">{m.density_kg_m3}</td>
                <td className="num">{m.specific_heat_J_kgK}</td>
                <td className="num">{m.thermal_conductivity_W_mK != null ? fmt(m.thermal_conductivity_W_mK, 1) : "—"}</td>
                <td className="num">{m.yield_strength_Pa != null ? fmt(m.yield_strength_Pa / 1e6, 0) : "—"}</td>
                <td>{m.confidence ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 8 }}>Pad Compounds</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Manufacturer</th>
              <th>Compound</th>
              <th>Design &mu;</th>
              <th>&mu; range</th>
              <th>Max temp (&deg;C)</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {PAD_COMPOUND_ROWS.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.manufacturer ?? "—"}</td>
                <td>{p.compound ?? "—"}</td>
                <td className="num">{p.friction_coefficient != null ? fmt(p.friction_coefficient, 2) : "—"}</td>
                <td className="num">{p.mu_range ? `${fmt(p.mu_range[0], 2)}–${fmt(p.mu_range[1], 2)}` : "—"}</td>
                <td className="num">{p.max_recommended_temperature_C ?? "—"}</td>
                <td>{p.source?.confidence ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 8 }}>Fastener / Bobbin Materials</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Yield (MPa)</th>
              <th>Ultimate (MPa)</th>
              <th>Density (kg/m&sup3;)</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {FASTENER_MATERIAL_ROWS.map((f) => (
              <tr key={f.name}>
                <td>{f.name}</td>
                <td className="num">{fmt(f.yield_strength_Pa / 1e6, 0)}</td>
                <td className="num">{f.ultimate_strength_Pa != null ? fmt(f.ultimate_strength_Pa / 1e6, 0) : "—"}</td>
                <td className="num">{f.density_kg_m3 ?? "—"}</td>
                <td>{f.confidence ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 8 }}>Brake Fluids</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Manufacturer</th>
              <th>DOT</th>
              <th>Dry BP (&deg;C)</th>
              <th>Wet BP (&deg;C)</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {BRAKE_FLUID_ROWS.map((f) => (
              <tr key={f.name}>
                <td>{f.name}</td>
                <td>{f.manufacturer ?? "—"}</td>
                <td>{f.dot_rating ?? "—"}</td>
                <td className="num">{fmt(f.dry_boiling_point_c, 0)}</td>
                <td className="num">{f.wet_boiling_point_c != null ? fmt(f.wet_boiling_point_c, 0) : "—"}</td>
                <td>{f.source?.confidence ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Suspension & Aero tab ---------------------------------------------------

interface TransferSweepRow {
  ay: number;
  axle: "front" | "rear";
  component: "geometric" | "elastic" | "unsprung";
  value: number;
}

const COMPONENTS: Array<TransferSweepRow["component"]> = ["geometric", "elastic", "unsprung"];

function transferTraces(rows: TransferSweepRow[], axle: "front" | "rear"): Partial<Plotly.PlotData>[] {
  return COMPONENTS.map((component, i) => {
    const filtered = rows.filter((r) => r.axle === axle && r.component === component);
    const color = TRACE_COLORS[i % TRACE_COLORS.length];
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      stackgroup: "one",
      x: filtered.map((r) => r.ay),
      y: filtered.map((r) => r.value),
      name: component,
      line: { color },
    };
  });
}

function SuspensionAeroTab({ vehicle, conditions }: { vehicle: Vehicle; conditions: Conditions }) {
  const [latGMax, setLatGMax] = useState(1.8);
  const [speedMax, setSpeedMax] = useState(30.0);
  const [pitchDeg, setPitchDeg] = useState(1.0);

  const rateRows = (["front", "rear"] as const).map((name) => {
    const axle = SUSPENSION[name];
    const trackM = name === "front" ? vehicle.front_track_m : vehicle.rear_track_m;
    const wheelRate = wheelRateNPerM(axle.spring_rate_n_per_m, axle.motion_ratio);
    const rideRate = rideRateNPerM(wheelRate, axle.tire_vertical_rate_n_per_m);
    return {
      name,
      springRateNPerMm: axle.spring_rate_n_per_m / 1e3,
      motionRatio: axle.motion_ratio,
      wheelRateNPerMm: wheelRate / 1e3,
      rideRateNPerMm: rideRate / 1e3,
      arb: axle.arb_roll_stiffness_nm_per_rad,
      axleRollStiffness: axleRollStiffnessNmPerRad(axle, trackM),
    };
  });

  const transferRows: TransferSweepRow[] = useMemo(() => {
    const n = 18;
    const rows: TransferSweepRow[] = [];
    for (let i = 0; i < n; i++) {
      const ay = 0.1 + (i * (latGMax - 0.1)) / (n - 1);
      const result = lateralLoadTransfer(vehicle, SUSPENSION, conditions.driver_mass_kg, ay);
      for (const axleResult of [result.front, result.rear]) {
        const axle = axleResult.axle_name as "front" | "rear";
        rows.push({ ay, axle, component: "geometric", value: axleResult.geometric_n });
        rows.push({ ay, axle, component: "elastic", value: axleResult.elastic_n });
        rows.push({ ay, axle, component: "unsprung", value: axleResult.unsprung_n });
      }
    }
    return rows;
  }, [vehicle, conditions.driver_mass_kg, latGMax]);

  const point = useMemo(
    () => lateralLoadTransfer(vehicle, SUSPENSION, conditions.driver_mass_kg, latGMax),
    [vehicle, conditions.driver_mass_kg, latGMax],
  );

  const aeroRows = useMemo(() => {
    const n = 30;
    const rows: { v: number; frontDf: number; rearDf: number; drag: number; cpX: number }[] = [];
    for (let i = 0; i < n; i++) {
      const v = 1.0 + (i * (speedMax - 1.0)) / (n - 1);
      const [frontDf, rearDf] = coefficientAxleDownforceN(AERO, v, vehicle.wheelbase_m, pitchDeg);
      rows.push({
        v,
        frontDf,
        rearDf,
        drag: coefficientDragN(AERO, v),
        cpX: cpPositionM(AERO, v, pitchDeg, vehicle.wheelbase_m),
      });
    }
    return rows;
  }, [vehicle.wheelbase_m, speedMax, pitchDeg]);

  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        Baseline suspension and aero values are documented ASSUMPTIONS pending sub-team data (see
        data/suspension/baseline_suspension.json and data/aero/baseline_coefficient_aero.json). Unlike
        Vehicle and Brake Hardware, these are not per-scenario state — the scenario store has no
        suspension/aero patch action, matching how the Python app itself never varied them per session.
      </p>

      <h3 style={{ marginBottom: 8 }}>Wheel Rates & Roll Stiffness</h3>
      <div className="scroll-x" style={{ marginBottom: 18 }}>
        <table>
          <thead>
            <tr>
              <th>Axle</th>
              <th>Spring rate (N/mm)</th>
              <th>Motion ratio</th>
              <th>Wheel rate (N/mm)</th>
              <th>Ride rate w/ tire (N/mm)</th>
              <th>ARB (N&middot;m/rad)</th>
              <th>Axle roll stiffness (N&middot;m/rad)</th>
            </tr>
          </thead>
          <tbody>
            {rateRows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{fmt(r.springRateNPerMm, 1)}</td>
                <td className="num">{fmt(r.motionRatio, 2)}</td>
                <td className="num">{fmt(r.wheelRateNPerMm, 1)}</td>
                <td className="num">{fmt(r.rideRateNPerMm, 1)}</td>
                <td className="num">{fmt(r.arb, 0)}</td>
                <td className="num">{fmt(r.axleRollStiffness, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginBottom: 8 }}>Lateral Load Transfer Decomposition</h3>
      <div className="controls">
        <NumField label="Sweep lateral accel to, g" value={latGMax} step={0.1} onChange={setLatGMax} />
      </div>
      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">Front Roll Stiffness Share</div>
          <div className="metric-value num">{fmt(point.front_roll_stiffness_fraction * 100, 1)}%</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Roll Angle @ {fmt(latGMax, 1)} g</div>
          <div className="metric-value num">{fmt((point.roll_angle_rad * 180) / Math.PI, 2)}&deg;</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Sprung CG Height</div>
          <div className="metric-value num">{fmt(point.sprung_cg_height_m * 1e3, 0)} mm</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Front Total Transfer @ {fmt(latGMax, 1)} g</div>
          <div className="metric-value num">{fmt(totalN(point.front), 0)} N</div>
        </div>
      </div>
      <div className="charts two" style={{ marginBottom: 18 }}>
        <Chart
          title="Front Transfer: Geometric + Elastic + Unsprung"
          data={transferTraces(transferRows, "front")}
          layout={{ xaxis: { title: { text: "Lateral accel (g)" } }, yaxis: { title: { text: "Load transfer (N)" } } }}
        />
        <Chart
          title="Rear Transfer: Geometric + Elastic + Unsprung"
          data={transferTraces(transferRows, "rear")}
          layout={{ xaxis: { title: { text: "Lateral accel (g)" } }, yaxis: { title: { text: "Load transfer (N)" } } }}
        />
      </div>

      <h3 style={{ marginBottom: 8 }}>Coefficient Aero & CP Migration</h3>
      <div className="controls">
        <NumField label="Sweep speed to, m/s" value={speedMax} step={1} onChange={setSpeedMax} />
        <NumField label="Brake pitch (nose-down +), deg" value={pitchDeg} step={0.1} onChange={setPitchDeg} />
      </div>
      <div className="metrics">
        <div className="metric panel">
          <div className="metric-label">CL / CD</div>
          <div className="metric-value num">
            {fmt(AERO.cl, 2)} / {fmt(AERO.cd, 2)}
          </div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Frontal Area</div>
          <div className="metric-value num">{fmt(AERO.frontal_area_m2, 2)} m&sup2;</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Static CP (aft of front axle)</div>
          <div className="metric-value num">{fmt(AERO.x_cp0_m * 1e3, 0)} mm</div>
        </div>
        <div className="metric panel">
          <div className="metric-label">Air Density</div>
          <div className="metric-value num">{fmt(AERO.air_density_kg_m3, 2)} kg/m&sup3;</div>
        </div>
      </div>
      <div className="charts two">
        <Chart
          title="Downforce Split & Drag vs Speed"
          data={[
            { type: "scatter", mode: "lines", x: aeroRows.map((r) => r.v), y: aeroRows.map((r) => r.frontDf), name: "Front downforce" },
            { type: "scatter", mode: "lines", x: aeroRows.map((r) => r.v), y: aeroRows.map((r) => r.rearDf), name: "Rear downforce" },
            { type: "scatter", mode: "lines", x: aeroRows.map((r) => r.v), y: aeroRows.map((r) => r.drag), name: "Drag" },
          ]}
          layout={{ xaxis: { title: { text: "Speed (m/s)" } }, yaxis: { title: { text: "Force (N)" } } }}
        />
        <Chart
          title={`CP Position vs Speed (pitch ${fmt(pitchDeg, 1)}°)`}
          data={[
            {
              type: "scatter",
              mode: "lines",
              x: aeroRows.map((r) => r.v),
              y: aeroRows.map((r) => r.cpX),
              name: "CP x",
              showlegend: false,
            },
          ]}
          layout={{
            xaxis: { title: { text: "Speed (m/s)" } },
            yaxis: { title: { text: "CP aft of front axle (m)" } },
          }}
        />
      </div>
    </div>
  );
}

// --- page ---------------------------------------------------------------

type TabId = "vehicle" | "hardware" | "rotor" | "materials" | "suspension";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "vehicle", label: "Vehicle" },
  { id: "hardware", label: "Brake Hardware" },
  { id: "rotor", label: "Rotor" },
  { id: "materials", label: "Materials" },
  { id: "suspension", label: "Suspension & Aero" },
];

export function Setup({ scenario, dispatch }: PageProps) {
  const [tab, setTab] = useState<TabId>("vehicle");
  const { vehicle, brakes, conditions } = scenario;

  return (
    <div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "vehicle" && <VehicleTab vehicle={vehicle} conditions={conditions} dispatch={dispatch} />}
      {tab === "hardware" && <HardwareTab brakes={brakes} dispatch={dispatch} />}
      {tab === "rotor" && <RotorTab brakes={brakes} dispatch={dispatch} />}
      {tab === "materials" && <MaterialsTab brakes={brakes} conditions={conditions} dispatch={dispatch} />}
      {tab === "suspension" && <SuspensionAeroTab vehicle={vehicle} conditions={conditions} />}
    </div>
  );
}
