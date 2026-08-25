/** Bobbins: floating-rotor drive-button (bobbin) structural checks.
 *
 * Brake torque reacts through the drive buttons as a tangential force at the
 * bolt-circle radius (spec 22.2): F_total = T / r_bobbin, shared across N
 * buttons. This page checks the worst button in shear and bearing, checks
 * both sides of the rotor-mount joint (friction-ring tab and hat/carrier
 * ear), and searches for the minimal button count/size that meets target
 * safety factors.
 *
 * The "structural design pedal force" (default 823 N) is page-local and
 * deliberately NOT the shared scenario pedal force (~418 N,
 * `scenario.conditions.pedal_force_n`): 823 N is the hard-braking load the
 * buttons are sized against, and sharing the two would halve the design
 * load the structure is actually checked at.
 */
import { useState } from "react";
import type { PageProps } from "./registry.tsx";
import { Chart } from "../components/Chart.tsx";
import type { Scenario } from "../state/store.ts";
import { scenarioLabel } from "../state/store.ts";

import type { AxleBrake, BrakeHardware } from "@core/models/internal.ts";
import type { BobbinConfiguration, FastenerMaterial } from "@core/models/bobbins.ts";
import type { RotorMaterial } from "@core/models/rotors.ts";
import {
  bobbinLoads,
  optimizeBobbins,
  rotorMountForces,
  type BobbinCandidateRow,
  type BobbinLoadResult,
  type MountForceResult,
} from "@core/solvers/bobbins.ts";
import { axleBrakeTorqueFromPedalNm, circuitLinePressurePa, padMu, pushrodForceTotalN } from "@core/solvers/hydraulics.ts";
import { caliperActiveAreaMm2, effectiveRotorRadiusM } from "@core/solvers/brakeBias.ts";

import fastenerData from "@data/materials/fastener_materials.json";
import rotorMaterialData from "@data/materials/rotor_materials.json";

import type Plotly from "plotly.js-dist-min";

type Trace = Partial<Plotly.PlotData>;
type AxleName = "front" | "rear";
type AxleChoice = "Front" | "Rear";
type TorqueMode = "From pedal force (hydraulics)" | "Manual override";
type JointType = "Single shear (1 hat ear)" | "Double shear / clevis (2 hat ears)";

// --- material data (JSON keys use Capitalized_Pa units; the internal models
// use lower_snake_case -- adapt once, here). ---------------------------------

interface FastenerRaw {
  name: string;
  yield_strength_Pa: number | null;
  ultimate_strength_Pa?: number | null;
  shear_yield_strength_Pa?: number | null;
  density_kg_m3?: number | null;
}

const FASTENERS: FastenerMaterial[] = (fastenerData as unknown as { materials: FastenerRaw[] }).materials.map(
  (m) => ({
    name: m.name,
    yield_strength_pa: m.yield_strength_Pa,
    ultimate_strength_pa: m.ultimate_strength_Pa ?? null,
    shear_yield_strength_pa: m.shear_yield_strength_Pa ?? null,
    density_kg_m3: m.density_kg_m3 ?? null,
  }),
);
const FASTENERS_BY_NAME = new Map(FASTENERS.map((f) => [f.name, f]));
/** IIFE (not a bare `FASTENERS[0]`) so the non-undefined narrowing survives
 * into closures declared later in the module -- a plain `const x = arr[0]; if
 * (!x) throw` only narrows `x` at its own scope, not inside functions that
 * capture it. */
const FIRST_FASTENER: FastenerMaterial = (() => {
  const f = FASTENERS[0];
  if (!f) throw new Error("fastener_materials.json has no entries");
  return f;
})();

interface RotorMaterialRaw {
  name: string;
  density_kg_m3: number;
  specific_heat_J_kgK: number;
  thermal_conductivity_W_mK?: number | null;
  youngs_modulus_Pa?: number | null;
  poissons_ratio?: number | null;
  thermal_expansion_1_K?: number | null;
  yield_strength_Pa?: number | null;
  emissivity?: number | null;
}

const ROTOR_MATERIALS: RotorMaterial[] = (
  rotorMaterialData as unknown as { materials: RotorMaterialRaw[] }
).materials.map((m) => ({
  name: m.name,
  density_kg_m3: m.density_kg_m3,
  specific_heat_j_kgk: m.specific_heat_J_kgK,
  thermal_conductivity_w_mk: m.thermal_conductivity_W_mK ?? null,
  youngs_modulus_pa: m.youngs_modulus_Pa ?? null,
  poissons_ratio: m.poissons_ratio ?? null,
  thermal_expansion_1_k: m.thermal_expansion_1_K ?? null,
  yield_strength_pa: m.yield_strength_Pa ?? null,
  emissivity: m.emissivity ?? null,
}));
const ROTOR_MATERIALS_BY_NAME = new Map(ROTOR_MATERIALS.map((m) => [m.name, m]));

/** Mount-side material choices: any rotor OR fastener material with a published
 * yield strength (the hat/carrier is often a different, softer alloy than the
 * rotor). Fastener names are suffixed to disambiguate from rotor materials of
 * the same underlying alloy. */
interface MountMaterialOption {
  key: string;
  yieldPa: number;
}
const MOUNT_MATERIAL_OPTIONS: MountMaterialOption[] = [
  ...ROTOR_MATERIALS.filter((m): m is RotorMaterial & { yield_strength_pa: number } => m.yield_strength_pa != null).map(
    (m) => ({ key: m.name, yieldPa: m.yield_strength_pa }),
  ),
  ...FASTENERS.filter((f): f is FastenerMaterial & { yield_strength_pa: number } => f.yield_strength_pa != null).map(
    (f) => ({ key: `${f.name} (fastener)`, yieldPa: f.yield_strength_pa }),
  ),
];
const FIRST_MOUNT_OPTION: MountMaterialOption = (() => {
  const o = MOUNT_MATERIAL_OPTIONS[0];
  if (!o) throw new Error("no mount-material candidates (no material has a published yield)");
  return o;
})();
const DEFAULT_MOUNT_INDEX = Math.max(
  0,
  MOUNT_MATERIAL_OPTIONS.findIndex((o) => o.key.includes("7075")),
);

function axleOf(brakes: BrakeHardware, axle: AxleChoice): AxleBrake {
  return axle === "Front" ? brakes.front : brakes.rear;
}

function defaultsFor(axle: AxleBrake): {
  count: number;
  circleMm: number;
  buttonMm: number;
  materialName: string;
  tabMm: number;
} {
  const materialName =
    axle.bobbin_material != null && FASTENERS_BY_NAME.has(axle.bobbin_material) ? axle.bobbin_material : FIRST_FASTENER.name;
  return {
    count: axle.bobbin_count ?? 6,
    circleMm: axle.bobbin_circle_diameter_mm ?? 145.0,
    buttonMm: axle.bobbin_button_diameter_mm ?? 8.0,
    materialName,
    tabMm: axle.rotor_thickness_mm,
  };
}

function parseDiameters(text: string): { values: number[]; invalid: string[] } {
  const invalid: string[] = [];
  const values: number[] = [];
  for (const raw of text.replace(/;/g, ",").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const value = Number(token);
    if (!Number.isFinite(value) || value <= 0) invalid.push(token);
    else values.push(value);
  }
  return { values: [...new Set(values)].sort((a, b) => a - b), invalid };
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div>
      <label>{label}</label>
      <input
        type="number"
        autoComplete="off"
        value={value}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
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
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label>{label}</label>
      <select value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Bobbins({ scenario, compared, comparing }: PageProps) {
  const brakes = scenario.brakes;

  // --- Design torque ---------------------------------------------------------
  const [torqueMode, setTorqueMode] = useState<TorqueMode>("From pedal force (hydraulics)");
  const [structuralPedalForceN, setStructuralPedalForceN] = useState(823.0);
  const [frontManualTorqueNm, setFrontManualTorqueNm] = useState(250.0);
  const [rearManualTorqueNm, setRearManualTorqueNm] = useState(150.0);

  // --- Current design ----------------------------------------------------------
  const [axleChoice, setAxleChoice] = useState<AxleChoice>("Front");
  const initial = defaultsFor(brakes.front);
  const [count, setCount] = useState(initial.count);
  const [circleMm, setCircleMm] = useState(initial.circleMm);
  const [buttonMm, setButtonMm] = useState(initial.buttonMm);
  const [materialName, setMaterialName] = useState(initial.materialName);
  const [shearPlanes, setShearPlanes] = useState(1);
  const [kShare, setKShare] = useState(0.75);
  const [kt, setKt] = useState(1.5);
  const [tabMm, setTabMm] = useState(initial.tabMm);

  // --- Rotor mount forces --------------------------------------------------
  const [mountThicknessMm, setMountThicknessMm] = useState(brakes.front.rotor_thickness_mm);
  const [mountMaterialKey, setMountMaterialKey] = useState(MOUNT_MATERIAL_OPTIONS[DEFAULT_MOUNT_INDEX]?.key ?? FIRST_MOUNT_OPTION.key);
  const [jointType, setJointType] = useState<JointType>("Single shear (1 hat ear)");

  // --- Optimization ----------------------------------------------------------
  const [targetShearSf, setTargetShearSf] = useState(2.0);
  const [targetBearingSf, setTargetBearingSf] = useState(1.5);
  const [countMin, setCountMin] = useState(3);
  const [countMax, setCountMax] = useState(12);
  const [diametersText, setDiametersText] = useState("5, 6, 7, 8, 9, 10, 12");

  const material = FASTENERS_BY_NAME.get(materialName) ?? FIRST_FASTENER;
  const mountOption = MOUNT_MATERIAL_OPTIONS.find((o) => o.key === mountMaterialKey) ?? FIRST_MOUNT_OPTION;
  const mountEarCount = jointType.startsWith("Double") ? 2 : 1;

  const config: BobbinConfiguration = {
    count,
    bolt_circle_diameter_mm: circleMm,
    button_diameter_mm: buttonMm,
    material,
    shear_plane_count: shearPlanes,
    load_sharing_factor: kShare,
    stress_concentration_factor: kt,
    rotor_tab_thickness_mm: tabMm,
  };

  function rotorTorqueFor(s: Scenario, axleName: AxleName): number {
    if (torqueMode === "From pedal force (hydraulics)") {
      return axleBrakeTorqueFromPedalNm(structuralPedalForceN, s.brakes, axleName) / 2.0;
    }
    return axleName === "front" ? frontManualTorqueNm : rearManualTorqueNm;
  }

  interface CurrentDesign {
    axle: AxleBrake;
    rotorTorqueNm: number;
    rotorMaterial: RotorMaterial | undefined;
    loads: BobbinLoadResult;
  }

  function currentDesignFor(s: Scenario): CurrentDesign {
    const axle = axleOf(s.brakes, axleChoice);
    const rotorTorqueNm = rotorTorqueFor(s, axleChoice === "Front" ? "front" : "rear");
    const rotorMaterial = ROTOR_MATERIALS_BY_NAME.get(axle.rotor_material ?? "");
    const loads = bobbinLoads(rotorTorqueNm, config, rotorMaterial ?? null, axle.rotor_thickness_mm);
    return { axle, rotorTorqueNm, rotorMaterial, loads };
  }

  function mountForcesFor(s: Scenario): MountForceResult | null {
    const cd = currentDesignFor(s);
    if (cd.rotorMaterial?.yield_strength_pa == null) return null;
    return rotorMountForces(
      cd.loads.per_button_design_force_n,
      count,
      buttonMm,
      tabMm,
      cd.rotorMaterial.yield_strength_pa,
      mountThicknessMm,
      mountOption.yieldPa,
      mountEarCount,
    );
  }

  const frontRotorTorqueNm = rotorTorqueFor(scenario, "front");
  const rearRotorTorqueNm = rotorTorqueFor(scenario, "rear");
  const primary = currentDesignFor(scenario);
  const primaryMount = mountForcesFor(scenario);

  const buttonLabels = Array.from({ length: count }, (_, i) => `button ${i + 1}`);
  const forceBarTraces: Trace[] = compared.flatMap((s) => {
    const cd = currentDesignFor(s);
    const suffix = comparing ? ` — ${scenarioLabel(s)}` : "";
    return [
      {
        x: buttonLabels,
        y: Array(count).fill(cd.loads.per_button_nominal_force_n),
        type: "bar",
        name: `nominal (even share)${suffix}`,
      },
      {
        x: ["worst button (design)"],
        y: [cd.loads.per_button_design_force_n],
        type: "bar",
        name: `design (Kt / K_share applied)${suffix}`,
      },
    ];
  });

  const mountBarTraces: Trace[] = compared.flatMap((s) => {
    const m = mountForcesFor(s);
    if (!m) return [];
    return [
      {
        x: ["Friction-ring tab", `Hat ear (×${mountEarCount})`],
        y: [m.friction_ring_bearing_stress_pa / 1e6, m.mount_bearing_stress_pa / 1e6],
        type: "bar",
        name: comparing ? scenarioLabel(s) : "Bearing stress (MPa)",
      },
    ];
  });

  const { values: diametersMm, invalid: invalidDiameters } = parseDiameters(diametersText);
  const optimization =
    diametersMm.length > 0 && primary.rotorMaterial
      ? optimizeBobbins(
          primary.rotorTorqueNm,
          circleMm,
          material,
          primary.rotorMaterial,
          primary.axle.rotor_thickness_mm,
          Array.from({ length: Math.max(countMax - countMin + 1, 0) }, (_, i) => countMin + i),
          diametersMm,
          targetShearSf,
          targetBearingSf,
          shearPlanes,
          kShare,
          kt,
          tabMm,
        )
      : null;

  let heatmap: { diameters: number[]; counts: number[]; z: Array<Array<number | null>>; text: string[][] } | null = null;
  if (optimization) {
    const candidates: BobbinCandidateRow[] = optimization.candidates;
    const diameters = [...new Set(candidates.map((c) => c.button_diameter_mm))].sort((a, b) => a - b);
    const counts = [...new Set(candidates.map((c) => c.count))].sort((a, b) => a - b);
    const byKey = new Map(candidates.map((c) => [`${c.count}|${c.button_diameter_mm}`, c]));
    const z = diameters.map((d) =>
      counts.map((n) => {
        const c = byKey.get(`${n}|${d}`);
        if (!c) return null;
        const bearing = c.bearing_safety_factor ?? Infinity;
        return Math.min(c.shear_safety_factor, bearing);
      }),
    );
    const text = diameters.map((d, di) =>
      counts.map((n, ni) => {
        const c = byKey.get(`${n}|${d}`);
        if (!c) return "";
        const val = z[di]?.[ni] ?? null;
        const base = val != null && Number.isFinite(val) ? val.toFixed(1) : "inf";
        return c.passes ? `${base} *` : base;
      }),
    );
    heatmap = { diameters, counts, z, text };
  }

  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        Brake torque reacts through the floating-rotor drive buttons as a tangential force at the bolt circle: F_total
        = T / r_bobbin, shared across N buttons (spec 22.2). The worst button carries Kt × F_total / (K_share × N).
      </p>

      <h3>Design Torque</h3>
      <div className="controls">
        <SelectField
          label="Torque source"
          value={torqueMode}
          options={["From pedal force (hydraulics)", "Manual override"]}
          onChange={(v) => setTorqueMode(v as TorqueMode)}
        />
        {torqueMode === "From pedal force (hydraulics)" ? (
          <NumberField
            label="Structural design pedal force, N"
            value={structuralPedalForceN}
            step={10}
            onChange={setStructuralPedalForceN}
          />
        ) : (
          <>
            <NumberField label="Front per-rotor torque, N·m" value={frontManualTorqueNm} step={10} onChange={setFrontManualTorqueNm} />
            <NumberField label="Rear per-rotor torque, N·m" value={rearManualTorqueNm} step={10} onChange={setRearManualTorqueNm} />
          </>
        )}
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        823 N is the customary hard-braking design pedal force for sizing the buttons -- page-local, and distinct
        from the shared nominal pedal force ({scenario.conditions.pedal_force_n.toFixed(0)} N) used on the Hydraulics
        page.
      </p>

      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Front per-rotor torque</div>
          <div className="metric-value num">{frontRotorTorqueNm.toFixed(0)} N·m</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Rear per-rotor torque</div>
          <div className="metric-value num">{rearRotorTorqueNm.toFixed(0)} N·m</div>
        </div>
      </div>

      {torqueMode === "From pedal force (hydraulics)" && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Axle</th>
                <th>Circuit force, N</th>
                <th>Line pressure, MPa</th>
                <th>Piston area total, mm²</th>
                <th>Clamp per face, N</th>
                <th>Friction, N</th>
                <th>Effective radius, mm</th>
                <th>Axle torque, N·m</th>
                <th>Per rotor, N·m</th>
              </tr>
            </thead>
            <tbody>
              {(["front", "rear"] as const).map((axleName) => {
                const axleHw = axleName === "front" ? brakes.front : brakes.rear;
                const fraction = axleName === "front" ? brakes.front_pressure_fraction : brakes.rear_pressure_fraction;
                const mu = padMu(brakes);
                const pushrod = pushrodForceTotalN(structuralPedalForceN, brakes);
                const pressure = circuitLinePressurePa(structuralPedalForceN, brakes, axleName);
                const areaTotal = caliperActiveAreaMm2(axleHw.caliper);
                const clampPerFace = pressure * (areaTotal / 2.0) * 1e-6;
                const friction = 2.0 * mu * clampPerFace;
                const rEff = effectiveRotorRadiusM(axleHw);
                const tAxle = friction * rEff;
                return (
                  <tr key={axleName}>
                    <td>{axleName === "front" ? "Front" : "Rear"}</td>
                    <td className="num">{(fraction * pushrod).toFixed(0)}</td>
                    <td className="num">{(pressure / 1e6).toFixed(2)}</td>
                    <td className="num">{areaTotal.toFixed(0)}</td>
                    <td className="num">{clampPerFace.toFixed(0)}</td>
                    <td className="num">{friction.toFixed(0)}</td>
                    <td className="num">{(rEff * 1000.0).toFixed(1)}</td>
                    <td className="num">{tAxle.toFixed(0)}</td>
                    <td className="num">{(tAxle / 2.0).toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note">
            Hand-check trap: caliper piston area is the TOTAL across both sides of the opposed caliper. Clamp force
            per face is P × (half that area); friction acts on two faces, so torque = 2μ · P · (A/2) · r = μ · P ·
            A_total · r.
          </p>
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Current Design</h3>
      <div className="controls">
        <SelectField label="Axle" value={axleChoice} options={["Front", "Rear"]} onChange={(v) => setAxleChoice(v as AxleChoice)} />
        <NumberField label="Button count N" value={count} step={1} onChange={(v) => setCount(Math.max(1, Math.round(v)))} />
        <NumberField label="Bolt circle diameter, mm" value={circleMm} step={1} onChange={setCircleMm} />
        <NumberField label="Button diameter, mm" value={buttonMm} step={0.5} onChange={setButtonMm} />
        <SelectField
          label="Button material"
          value={materialName}
          options={FASTENERS.map((f) => f.name)}
          onChange={setMaterialName}
        />
      </div>
      <div className="controls">
        <NumberField label="Shear planes" value={shearPlanes} step={1} onChange={(v) => setShearPlanes(Math.max(1, Math.round(v)))} />
        <NumberField label="Load-sharing factor K_share" value={kShare} step={0.05} onChange={setKShare} />
        <NumberField label="Stress concentration Kt" value={kt} step={0.1} onChange={setKt} />
        <NumberField label="Rotor tab thickness, mm" value={tabMm} step={0.5} onChange={setTabMm} />
      </div>

      <div className="metrics">
        <div className="panel metric">
          <div className="metric-label">Total tangential force</div>
          <div className="metric-value num">{primary.loads.total_tangential_force_n.toFixed(0)} N</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Per-button nominal</div>
          <div className="metric-value num">{primary.loads.per_button_nominal_force_n.toFixed(0)} N</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Worst button (design)</div>
          <div className="metric-value num">{primary.loads.per_button_design_force_n.toFixed(0)} N</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Shear SF</div>
          <div className="metric-value num">{primary.loads.shear_safety_factor.toFixed(1)}</div>
          <div className="metric-delta num">tau = {(primary.loads.shear_stress_pa / 1e6).toFixed(1)} MPa</div>
        </div>
        <div className="panel metric">
          <div className="metric-label">Bearing SF (rotor tab)</div>
          <div className="metric-value num">
            {primary.loads.bearing_safety_factor != null ? primary.loads.bearing_safety_factor.toFixed(1) : "n/a"}
          </div>
          <div className="metric-delta num">tau = {((primary.loads.bearing_stress_pa ?? 0) / 1e6).toFixed(1)} MPa</div>
        </div>
      </div>

      <Chart title="Force per button" data={forceBarTraces} layout={{ barmode: "group" }} />

      <h3 style={{ marginTop: 18 }}>Rotor Mount Forces</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Each drive button transmits its tangential force into two structures: the friction-ring (rotor) drive tab on
        one side and the hat/carrier mounting ear on the other. Single shear puts the full per-button force on both
        sides; double shear splits the hat-ear load across two ears while the rotor tab still carries the full force.
      </p>
      <div className="controls">
        <NumberField label="Hat/mount tab thickness, mm" value={mountThicknessMm} step={0.5} onChange={setMountThicknessMm} />
        <SelectField
          label="Hat/mount material"
          value={mountMaterialKey}
          options={MOUNT_MATERIAL_OPTIONS.map((o) => o.key)}
          onChange={setMountMaterialKey}
        />
        <SelectField
          label="Joint type"
          value={jointType}
          options={["Single shear (1 hat ear)", "Double shear / clevis (2 hat ears)"]}
          onChange={(v) => setJointType(v as JointType)}
        />
      </div>

      {primaryMount ? (
        <>
          <div className="metrics">
            <div className="panel metric">
              <div className="metric-label">Force on rotor tab</div>
              <div className="metric-value num">{primaryMount.friction_ring_force_n.toFixed(0)} N</div>
            </div>
            <div className="panel metric">
              <div className="metric-label">Friction-ring bearing SF</div>
              <div className="metric-value num">{primaryMount.friction_ring_bearing_sf.toFixed(1)}</div>
              <div className="metric-delta num">σ = {(primaryMount.friction_ring_bearing_stress_pa / 1e6).toFixed(1)} MPa</div>
            </div>
            <div className="panel metric">
              <div className="metric-label">Force per hat ear</div>
              <div className="metric-value num">{primaryMount.mount_ear_force_n.toFixed(0)} N</div>
            </div>
            <div className="panel metric">
              <div className="metric-label">Hat/mount bearing SF</div>
              <div className="metric-value num">{primaryMount.mount_bearing_sf.toFixed(1)}</div>
              <div className="metric-delta num">σ = {(primaryMount.mount_bearing_stress_pa / 1e6).toFixed(1)} MPa</div>
            </div>
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            Limiting side:{" "}
            <strong>{primaryMount.mount_bearing_sf < primaryMount.friction_ring_bearing_sf ? "hat/mount ear" : "friction-ring tab"}</strong>{" "}
            (lower bearing safety factor). Total reacted over all {count} buttons: ring {primaryMount.total_ring_reaction_n.toFixed(0)} N,
            mount {primaryMount.total_mount_reaction_n.toFixed(0)} N.
          </p>
          <Chart title="Bearing stress on each side of the mount joint" data={mountBarTraces} layout={{ barmode: "group" }} />
        </>
      ) : (
        <p className="metric-value warn">
          Rotor material '{primary.axle.rotor_material ?? "(none)"}' has no yield strength on file -- the mount-joint
          forces are unavailable.
        </p>
      )}

      <h3 style={{ marginTop: 18 }}>Optimization: Minimal Count, Minimal Size</h3>
      <div className="controls">
        <NumberField label="Target shear SF" value={targetShearSf} step={0.25} onChange={setTargetShearSf} />
        <NumberField label="Target bearing SF" value={targetBearingSf} step={0.25} onChange={setTargetBearingSf} />
        <NumberField label="Button count min" value={countMin} step={1} onChange={(v) => setCountMin(Math.round(v))} />
        <NumberField label="Button count max" value={countMax} step={1} onChange={(v) => setCountMax(Math.round(v))} />
      </div>
      <div>
        <label htmlFor="bobbin-diameters">Candidate diameters, mm (comma-separated)</label>
        <input
          id="bobbin-diameters"
          autoComplete="off"
          style={{ width: "100%", maxWidth: 480 }}
          value={diametersText}
          onChange={(e) => setDiametersText(e.target.value)}
        />
      </div>
      {invalidDiameters.length > 0 && (
        <p className="metric-value warn">Ignored invalid diameter entries: {invalidDiameters.join(", ")}</p>
      )}

      {!primary.rotorMaterial ? (
        <p className="metric-value warn">
          Rotor material '{primary.axle.rotor_material ?? "(none)"}' not found in the material database -- the
          optimizer needs a yield strength to check bearing.
        </p>
      ) : optimization === null ? (
        <p className="note">Enter at least one candidate diameter.</p>
      ) : (
        <>
          {optimization.recommended ? (
            <p className="metric-value ok">
              Recommended: {optimization.recommended_count} × {optimization.recommended_diameter_mm?.toFixed(0)} mm{" "}
              {materialName} buttons on a {circleMm.toFixed(0)} mm circle -- shear SF{" "}
              {optimization.recommended.shear_safety_factor.toFixed(1)}, bearing SF{" "}
              {optimization.recommended.bearing_safety_factor != null
                ? optimization.recommended.bearing_safety_factor.toFixed(1)
                : "n/a"}
              .
            </p>
          ) : (
            <p className="metric-value warn">
              No candidate in the grid meets both safety-factor targets. Widen the count/diameter range, pick a
              stronger material, or revisit the targets.
            </p>
          )}

          {heatmap && (
            <Chart
              title="Candidate grid (tile color = limiting safety factor; * = passes both targets)"
              data={[
                {
                  type: "heatmap",
                  x: heatmap.counts,
                  y: heatmap.diameters,
                  z: heatmap.z,
                  text: heatmap.text,
                  texttemplate: "%{text}",
                  hovertemplate: "N=%{x}, d=%{y} mm<br>min SF %{z:.2f}<extra></extra>",
                  zmin: 0,
                  zmax: 2 * Math.max(targetShearSf, targetBearingSf),
                  colorscale: "RdYlGn",
                  colorbar: { title: { text: "Min SF" } },
                } as unknown as Trace,
              ]}
              layout={{
                xaxis: { title: { text: "Button Count" }, dtick: 1 },
                yaxis: { title: { text: "Button Diameter (mm)" } },
              }}
            />
          )}

          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Count</th>
                  <th>Diameter, mm</th>
                  <th>Nominal, N</th>
                  <th>Design, N</th>
                  <th>Shear, MPa</th>
                  <th>Shear SF</th>
                  <th>Bearing, MPa</th>
                  <th>Bearing SF</th>
                  <th>Passes</th>
                </tr>
              </thead>
              <tbody>
                {optimization.candidates.map((c) => (
                  <tr key={`${c.count}-${c.button_diameter_mm}`}>
                    <td className="num">{c.count}</td>
                    <td className="num">{c.button_diameter_mm}</td>
                    <td className="num">{c.per_button_nominal_force_n.toFixed(0)}</td>
                    <td className="num">{c.per_button_design_force_n.toFixed(0)}</td>
                    <td className="num">{c.shear_stress_mpa.toFixed(1)}</td>
                    <td className="num">{c.shear_safety_factor.toFixed(2)}</td>
                    <td className="num">{c.bearing_stress_mpa.toFixed(1)}</td>
                    <td className="num">{c.bearing_safety_factor != null ? c.bearing_safety_factor.toFixed(2) : "n/a"}</td>
                    <td className={c.passes ? "ok" : "bad"}>{c.passes ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {comparing && (
        <>
          <h3 style={{ marginTop: 18 }}>Comparison</h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Rotor torque, N·m</th>
                  <th>Total force, N</th>
                  <th>Worst button, N</th>
                  <th>Shear SF</th>
                  <th>Bearing SF</th>
                  <th>Ring SF</th>
                  <th>Mount SF</th>
                </tr>
              </thead>
              <tbody>
                {compared.map((s) => {
                  const cd = currentDesignFor(s);
                  const m = mountForcesFor(s);
                  return (
                    <tr key={s.id}>
                      <td>{scenarioLabel(s)}</td>
                      <td className="num">{cd.rotorTorqueNm.toFixed(0)}</td>
                      <td className="num">{cd.loads.total_tangential_force_n.toFixed(0)}</td>
                      <td className="num">{cd.loads.per_button_design_force_n.toFixed(0)}</td>
                      <td className="num">{cd.loads.shear_safety_factor.toFixed(1)}</td>
                      <td className="num">{cd.loads.bearing_safety_factor != null ? cd.loads.bearing_safety_factor.toFixed(1) : "—"}</td>
                      <td className="num">{m ? m.friction_ring_bearing_sf.toFixed(1) : "—"}</td>
                      <td className="num">{m ? m.mount_bearing_sf.toFixed(1) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="note" style={{ marginTop: 18 }}>
        Scope: torque-driven tangential loads only (spec 22.2) -- thermal-expansion friction on the floats and
        out-of-plane pad drag moments are not modeled. K_share and Kt are engineering assumptions pending FEA or
        physical test; fastener strengths are room-temperature handbook values, and buttons near the friction ring
        run hot.
      </p>
    </div>
  );
}
