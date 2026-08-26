/** Geometry for the thermal model: the parametric annulus, or a real drawing.
 *
 * Three shapes of geometry reach the solvers, and which one you have decides
 * which solver can answer:
 *
 * - **Parametric annulus** — the rotor as dimensions. Axisymmetric (r, z).
 * - **Uploaded CROSS-SECTION** (closed polyline in the radius/axial plane) —
 *   real hat and flange metal, rasterized onto the grid. Still axisymmetric.
 * - **Uploaded FACE DRAWING** (plan view: OD circle, hole rings, inner
 *   profile) — carries no thickness, but does carry where every hole and slot
 *   actually is, which is what unlocks the face-resolved plate model.
 *
 * Parsing lives in `resolveGeometry` as a pure function of the raw inputs, so
 * the panel below is layout only and the page can re-derive geometry without
 * re-running a file dialog.
 */
import { useMemo, useRef } from "react";
import { Chart } from "../../components/Chart.tsx";
import { circleXY, flattenPaths } from "./field.ts";

import {
  geometryFromUpload,
  scalePlanView,
  transformPolygon,
} from "@core/io/sectionImport.ts";
import type { PlanViewGeometry, HoleRing, Point } from "@core/io/sectionImport.ts";
import type { HoleBand } from "@core/solvers/thermalFdmSection.ts";
import {
  makeRotorSection,
  sectionRInnerMm,
  sectionROuterMm,
  sectionZSpanMm,
} from "@core/solvers/thermalFdmSection.ts";
import type { RotorMaterial } from "@core/models/rotors.ts";

export type GeometrySource = "annulus" | "upload";

export interface GeometryInputs {
  source: GeometrySource;
  padOffsetMm: number;
  padDepthMm: number;
  /** Parametric only: inner edge of the modeled disc. */
  innerDomainMm: number;
  upload: { name: string; data: Uint8Array } | null;
  swapAxes: boolean;
  unitScale: number;
  radialOffsetMm: number;
  axialOffsetMm: number;
  sectionMaterial: string;
  planThicknessMm: number;
  /** null = follow the drawing's suggestion. */
  planInnerMm: number | null;
  includeHoles: boolean;
  includeSlots: boolean;
  useInnerContour: boolean;
  /** null = use the rings the importer detected. */
  holeRings: HoleRing[] | null;
  /** Only meaningful for a face drawing; the other sources force it false. */
  preferFaceModel: boolean;
}

export interface ResolvedGeometry {
  source: GeometrySource;
  /** True when the face-resolved plate model will run. */
  faceMode: boolean;
  padOffsetMm: number;
  padDepthMm: number;
  innerDomainMm: number;
  /** (r, z) polygon in mm — set for BOTH upload flavours (a plan view gets a
   *  rectangular section from its OD, chosen inner diameter and thickness). */
  sectionPointsMm: Point[] | null;
  holeBands: HoleBand[];
  plan: PlanViewGeometry | null;
  planThicknessMm: number;
  planInnerMm: number;
  faceHoles: Array<[number, number, number]>;
  faceSlots: Point[][];
  faceInner: Point[] | null;
  detectedRings: HoleRing[];
  /** Blocking problem — no model can run until it is fixed. */
  error: string | null;
  /** Waiting on a file, which is not an error. */
  pending: boolean;
  /** Non-blocking things the reader should know. */
  warnings: string[];
  /** Import summary, shown when a drawing parsed cleanly. */
  summary: string | null;
  outerDiameterMm: number | null;
  innerDiameterMm: number | null;
  maxThicknessMm: number | null;
}

export function defaultGeometryInputs(
  padOffsetMm: number,
  padDepthMm: number,
  innerDomainMm: number,
  thicknessMm: number,
  materialName: string,
): GeometryInputs {
  return {
    source: "annulus",
    padOffsetMm,
    padDepthMm,
    innerDomainMm,
    upload: null,
    swapAxes: false,
    unitScale: 1.0,
    radialOffsetMm: 0.0,
    axialOffsetMm: 0.0,
    sectionMaterial: materialName,
    planThicknessMm: thicknessMm,
    planInnerMm: null,
    includeHoles: true,
    includeSlots: true,
    useInnerContour: true,
    holeRings: null,
    preferFaceModel: true,
  };
}

const EMPTY: Omit<ResolvedGeometry, "source" | "padOffsetMm" | "padDepthMm" | "innerDomainMm"> = {
  faceMode: false,
  sectionPointsMm: null,
  holeBands: [],
  plan: null,
  planThicknessMm: 0,
  planInnerMm: 0,
  faceHoles: [],
  faceSlots: [],
  faceInner: null,
  detectedRings: [],
  error: null,
  pending: false,
  warnings: [],
  summary: null,
  outerDiameterMm: null,
  innerDiameterMm: null,
  maxThicknessMm: null,
};

export function resolveGeometry(
  inputs: GeometryInputs,
  material: RotorMaterial,
): ResolvedGeometry {
  const common = {
    source: inputs.source,
    padOffsetMm: inputs.padOffsetMm,
    padDepthMm: inputs.padDepthMm,
    innerDomainMm: inputs.innerDomainMm,
  };
  if (inputs.source === "annulus") {
    return { ...EMPTY, ...common };
  }
  if (!inputs.upload) {
    return { ...EMPTY, ...common, pending: true };
  }

  let imported: ReturnType<typeof geometryFromUpload>;
  try {
    imported = geometryFromUpload(inputs.upload.name, inputs.upload.data);
  } catch (e) {
    return { ...EMPTY, ...common, error: e instanceof Error ? e.message : String(e) };
  }

  if (imported[0] === "section") {
    try {
      const points = transformPolygon(
        imported[1],
        inputs.swapAxes,
        inputs.unitScale,
        inputs.radialOffsetMm,
        inputs.axialOffsetMm,
      );
      const preview = makeRotorSection(points, material);
      const [zLo, zHi] = sectionZSpanMm(preview);
      return {
        ...EMPTY,
        ...common,
        sectionPointsMm: points,
        outerDiameterMm: 2.0 * sectionROuterMm(preview),
        innerDiameterMm: 2.0 * sectionRInnerMm(preview),
        maxThicknessMm: zHi - zLo,
        summary: `Cross-section detected: ${points.length} vertices.`,
      };
    } catch (e) {
      return { ...EMPTY, ...common, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Plan view (rotor face). Units are auto-converted from the DXF header; the
  // manual scale is the override for drawings whose header is wrong or missing.
  let plan: PlanViewGeometry;
  try {
    plan = scalePlanView(imported[1], inputs.unitScale);
  } catch (e) {
    return { ...EMPTY, ...common, error: e instanceof Error ? e.message : String(e) };
  }

  const warnings: string[] = [];
  if (plan.outer_diameter_mm < 40.0) {
    warnings.push(
      `The detected OD is only ${plan.outer_diameter_mm.toFixed(1)} mm — that is tiny for a ` +
        "brake rotor. If the drawing was made in inches without declaring units, set " +
        "'Unit scale to mm' to 25.4 above.",
    );
  }

  const rings = inputs.holeRings ?? plan.hole_rings;
  const holeBands: HoleBand[] = inputs.includeHoles
    ? rings
        .filter((r) => r.count >= 1 && r.hole_diameter_mm > 0 && r.center_radius_mm > r.hole_diameter_mm / 2)
        .map((r) => ({
          count: r.count,
          hole_diameter_mm: r.hole_diameter_mm,
          center_radius_mm: r.center_radius_mm,
        }))
    : [];

  const planInnerMm =
    inputs.planInnerMm ??
    Math.min(plan.suggested_inner_diameter_mm ?? plan.outer_diameter_mm * 0.5, plan.outer_diameter_mm * 0.98);

  const faceMode = inputs.preferFaceModel;
  if (!faceMode && plan.slot_loops_mm.length) {
    warnings.push(
      `${plan.slot_loops_mm.length} slots detected, but the axisymmetric model smears drilled ` +
        "holes only — switch to the face-resolved model to include slots, J-hooks, and the true " +
        "inner contour.",
    );
  }

  const rOuter = plan.outer_diameter_mm / 2.0;
  const rInner = planInnerMm / 2.0;
  const halfT = inputs.planThicknessMm / 2.0;
  const sectionPointsMm: Point[] = [
    [rInner, -halfT],
    [rOuter, -halfT],
    [rOuter, halfT],
    [rInner, halfT],
  ];

  const totalHoles = plan.hole_rings.reduce((n, r) => n + r.count, 0);
  const bits = [`${totalHoles} cooling holes in ${plan.hole_rings.length} rings`];
  if (plan.slot_loops_mm.length) bits.push(`${plan.slot_loops_mm.length} slots (closed loops)`);
  if (plan.inner_boundary_mm) bits.push("inner mounting contour");

  return {
    ...EMPTY,
    ...common,
    faceMode,
    sectionPointsMm,
    holeBands,
    plan,
    planThicknessMm: inputs.planThicknessMm,
    planInnerMm,
    faceHoles: inputs.includeHoles ? plan.hole_centers_mm : [],
    faceSlots: inputs.includeSlots ? plan.slot_loops_mm : [],
    faceInner: inputs.useInnerContour ? plan.inner_boundary_mm : null,
    detectedRings: plan.hole_rings,
    warnings,
    outerDiameterMm: plan.outer_diameter_mm,
    innerDiameterMm: planInnerMm,
    maxThicknessMm: inputs.planThicknessMm,
    summary:
      `Rotor face drawing detected: OD ${plan.outer_diameter_mm.toFixed(1)} mm, ` +
      bits.join(", ") +
      `. Drawing units: ${plan.detected_units}. A face view carries no thickness, so confirm ` +
      "the section inputs below.",
  };
}

// --- panel --------------------------------------------------------------------

export interface GeometryPanelProps {
  inputs: GeometryInputs;
  resolved: ResolvedGeometry;
  materialNames: string[];
  onChange: (patch: Partial<GeometryInputs>) => void;
}

export function GeometryPanel({ inputs, resolved, materialNames, onChange }: GeometryPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    onChange({ upload: { name: file.name, data: new Uint8Array(buffer) }, holeRings: null, planInnerMm: null });
  };

  return (
    <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>Pad swept band (measured from the outer edge)</h3>
      <div className="controls" style={{ marginBottom: 14 }}>
        <div className="field">
          <label htmlFor="geo-offset">Pad outer edge offset from OD, mm</label>
          <input
            id="geo-offset" type="number" step={0.5} value={inputs.padOffsetMm}
            onChange={(e) => onChange({ padOffsetMm: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="geo-depth">Pad radial depth, mm</label>
          <input
            id="geo-depth" type="number" step={0.5} value={inputs.padDepthMm}
            onChange={(e) => onChange({ padDepthMm: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="geo-src">Geometry source</label>
          <select
            id="geo-src" value={inputs.source} style={{ width: 268 }}
            onChange={(e) => onChange({ source: e.target.value as GeometrySource })}
          >
            <option value="annulus">Parametric annulus</option>
            <option value="upload">Uploaded rotor drawing (DXF / CSV)</option>
          </select>
        </div>
      </div>

      {inputs.source === "annulus" ? (
        <div className="controls" style={{ marginBottom: 0 }}>
          <div className="field">
            <label htmlFor="geo-inner">Model inboard metal to diameter, mm</label>
            <input
              id="geo-inner" type="number" step={2} value={inputs.innerDomainMm}
              onChange={(e) => onChange({ innerDomainMm: Number(e.target.value) })}
            />
          </div>
          <p className="note" style={{ margin: 0, maxWidth: "52ch" }}>
            Inner edge of the modeled disc. Default = the swept-band inner edge (friction ring
            only, conservative). Reduce toward the hat interface diameter to credit inboard metal
            as a heat sink; for real hat/flange geometry upload the cross-section.
          </p>
        </div>
      ) : (
        <>
          <div className="controls">
            <div className="field">
              <label htmlFor="geo-file">Rotor drawing</label>
              <input
                id="geo-file" ref={fileInput} type="file" accept=".dxf,.csv,.txt"
                style={{ width: 260 }}
                onChange={(e) => void pickFile(e.target.files?.[0])}
              />
            </div>
            <div className="field">
              <label htmlFor="geo-mat">Section material</label>
              <select
                id="geo-mat" value={inputs.sectionMaterial}
                onChange={(e) => onChange({ sectionMaterial: e.target.value })}
              >
                {materialNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            {inputs.upload && (
              <div className="field">
                <label>&nbsp;</label>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--dim)" }}>
                  {inputs.upload.name}
                </span>
              </div>
            )}
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            Two DXF flavours are accepted (mm): a CROSS-SECTION (closed polyline in the
            radius/axial plane) or a FACE DRAWING (OD circle centred on the origin, rings of
            cross-drilled holes, inner profile from arcs and lines). CSV/TXT: two columns
            r_mm, z_mm. DWG cannot be read — export DXF from your CAD package first.
          </p>

          <h3 style={{ margin: "12px 0 8px", fontSize: 13 }}>Import fix-ups (axes / units / origin)</h3>
          <div className="controls">
            <div className="field">
              <label htmlFor="geo-swap">Swap X/Y</label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <input
                  id="geo-swap" type="checkbox" checked={inputs.swapAxes}
                  onChange={(e) => onChange({ swapAxes: e.target.checked })}
                  style={{ width: 13, height: 13, padding: 0 }}
                />
                <span style={{ color: "var(--dim)", fontSize: 12 }}>radius on Y (sections only)</span>
              </label>
            </div>
            <div className="field">
              <label htmlFor="geo-scale">Unit scale to mm</label>
              <input
                id="geo-scale" type="number" step={0.1} value={inputs.unitScale}
                onChange={(e) => onChange({ unitScale: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="geo-roff">Radial offset, mm</label>
              <input
                id="geo-roff" type="number" step={1} value={inputs.radialOffsetMm}
                onChange={(e) => onChange({ radialOffsetMm: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="geo-zoff">Axial offset, mm</label>
              <input
                id="geo-zoff" type="number" step={0.5} value={inputs.axialOffsetMm}
                onChange={(e) => onChange({ axialOffsetMm: Number(e.target.value) })}
              />
            </div>
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            Units are auto-detected from the DXF <code>$INSUNITS</code> header. Only set the scale
            when the header is wrong or absent (e.g. 25.4 for an inch drawing that imports 25×
            too small).
          </p>

          {resolved.pending && (
            <p className="note">Upload a rotor drawing to run the conduction model on it.</p>
          )}
          {resolved.error && (
            <p style={{ color: "var(--bad)", fontSize: 12 }}>{resolved.error}</p>
          )}
          {resolved.summary && !resolved.error && (
            <p className="note" style={{ color: "var(--ok)" }}>{resolved.summary}</p>
          )}
          {resolved.warnings.map((w) => (
            <p key={w} className="note" style={{ color: "var(--warn)" }}>{w}</p>
          ))}

          {resolved.plan && <PlanControls inputs={inputs} resolved={resolved} onChange={onChange} />}
          {resolved.sectionPointsMm && !resolved.plan && (
            <SectionPreview resolved={resolved} />
          )}
          {resolved.plan && <FacePreview resolved={resolved} />}
        </>
      )}
    </div>
  );
}

function PlanControls({
  inputs,
  resolved,
  onChange,
}: {
  inputs: GeometryInputs;
  resolved: ResolvedGeometry;
  onChange: (patch: Partial<GeometryInputs>) => void;
}) {
  const plan = resolved.plan!;
  const rings = inputs.holeRings ?? resolved.detectedRings;

  const patchRing = (index: number, patch: Partial<HoleRing>) => {
    onChange({ holeRings: rings.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  };

  return (
    <>
      <div className="controls" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="plan-t">Rotor thickness, mm</label>
          <input
            id="plan-t" type="number" step={0.5} value={inputs.planThicknessMm}
            onChange={(e) => onChange({ planThicknessMm: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="plan-inner">Model inboard to diameter, mm</label>
          <input
            id="plan-inner" type="number" step={1} value={resolved.planInnerMm.toFixed(1)}
            onChange={(e) => onChange({ planInnerMm: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="plan-holes">Cross-drilling</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="plan-holes" type="checkbox" checked={inputs.includeHoles}
              onChange={(e) => onChange({ includeHoles: e.target.checked })}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--dim)", fontSize: 12 }}>include</span>
          </label>
        </div>
        <div className="field">
          <label htmlFor="plan-slots">Slots</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="plan-slots" type="checkbox" checked={inputs.includeSlots}
              disabled={!plan.slot_loops_mm.length}
              onChange={(e) => onChange({ includeSlots: e.target.checked })}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--dim)", fontSize: 12 }}>face model only</span>
          </label>
        </div>
        <div className="field">
          <label htmlFor="plan-contour">Drawn inner contour</label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <input
              id="plan-contour" type="checkbox" checked={inputs.useInnerContour}
              disabled={plan.inner_boundary_mm === null}
              onChange={(e) => onChange({ useInnerContour: e.target.checked })}
              style={{ width: 13, height: 13, padding: 0 }}
            />
            <span style={{ color: "var(--dim)", fontSize: 12 }}>conform to drawing</span>
          </label>
        </div>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        The inner diameter is detected from the innermost drawing geometry (drive-tab profile) —
        confirm it against CAD. It is the inner edge of the modeled disc.
      </p>

      <div className="controls">
        <div className="field">
          <label htmlFor="plan-model">Thermal model</label>
          <select
            id="plan-model" style={{ width: 420 }}
            value={inputs.preferFaceModel ? "face" : "axi"}
            onChange={(e) => onChange({ preferFaceModel: e.target.value === "face" })}
          >
            <option value="face">Face-resolved (2D in-plane — hot spots, slots, true inner contour)</option>
            <option value="axi">Axisymmetric (r–z — smeared features, fast, repeated events)</option>
          </select>
        </div>
      </div>

      {rings.length > 0 && (
        <table style={{ marginTop: 8, maxWidth: 520 }}>
          <thead>
            <tr><th>Holes</th><th>Hole ø, mm</th><th>Centre radius, mm</th></tr>
          </thead>
          <tbody>
            {rings.map((ring, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="number" step={1} value={ring.count} disabled={!inputs.includeHoles}
                    style={{ width: 80 }}
                    onChange={(e) => patchRing(i, { count: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number" step={0.5} value={ring.hole_diameter_mm} disabled={!inputs.includeHoles}
                    style={{ width: 96 }}
                    onChange={(e) => patchRing(i, { hole_diameter_mm: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number" step={0.5} value={ring.center_radius_mm} disabled={!inputs.includeHoles}
                    style={{ width: 96 }}
                    onChange={(e) => patchRing(i, { center_radius_mm: Number(e.target.value) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function SectionPreview({ resolved }: { resolved: ResolvedGeometry }) {
  const points = resolved.sectionPointsMm!;
  const closed = [...points, points[0]!];
  const bandHi = (resolved.outerDiameterMm ?? 0) / 2.0 - resolved.padOffsetMm;
  const bandLo = bandHi - resolved.padDepthMm;
  const zs = points.map((p) => p[1]);
  const data = useMemo(
    () => [
      {
        x: closed.map((p) => p[0]),
        y: closed.map((p) => p[1]),
        type: "scatter" as const,
        mode: "lines" as const,
        name: "section",
      },
      {
        x: [bandLo, bandHi, bandHi, bandLo, bandLo],
        y: [Math.min(...zs), Math.min(...zs), Math.max(...zs), Math.max(...zs), Math.min(...zs)],
        type: "scatter" as const,
        mode: "lines" as const,
        fill: "toself" as const,
        fillcolor: "rgba(255,184,0,0.16)",
        line: { width: 0 },
        name: "pad swept band",
        hoverinfo: "skip" as const,
      },
    ],
    [resolved],
  );

  return (
    <>
      <div className="metrics" style={{ marginTop: 12 }}>
        <Readout label="Outer diameter" value={`${(resolved.outerDiameterMm ?? 0).toFixed(1)} mm`} />
        <Readout label="Inner diameter" value={`${(resolved.innerDiameterMm ?? 0).toFixed(1)} mm`} />
        <Readout label="Max thickness" value={`${(resolved.maxThicknessMm ?? 0).toFixed(2)} mm`} />
      </div>
      <Chart
        title="Imported cross-section (rotation axis at r = 0)"
        height={280}
        equalAspect
        data={data}
        layout={{
          xaxis: { title: { text: "Radius (mm)" } },
          yaxis: { title: { text: "Axial (mm)" } },
        }}
      />
    </>
  );
}

function FacePreview({ resolved }: { resolved: ResolvedGeometry }) {
  const plan = resolved.plan!;
  const data = useMemo(() => {
    const paths: Point[][] = [...plan.outline_paths_mm];
    for (const [cx, cy, r] of plan.hole_centers_mm) {
      const { x, y } = circleXY(r, 25);
      paths.push(x.map((v, i) => [v + cx, y[i]! + cy] as Point));
    }
    const linework = flattenPaths(paths);
    const inner = circleXY(resolved.planInnerMm / 2.0);
    return [
      {
        x: linework.x, y: linework.y,
        type: "scatter" as const, mode: "lines" as const,
        line: { width: 1, color: "rgba(216,220,226,0.55)" },
        hoverinfo: "skip" as const, name: "drawing linework",
      },
      {
        x: inner.x, y: inner.y,
        type: "scatter" as const, mode: "lines" as const,
        line: { dash: "dash" as const, width: 1 },
        name: "modeled inner edge", hoverinfo: "skip" as const,
      },
    ];
  }, [plan, resolved.planInnerMm]);

  return (
    <Chart
      title="Imported rotor face (drawing linework)"
      height={420}
      equalAspect
      data={data}
      layout={{
        xaxis: { title: { text: "x (mm)" } },
        yaxis: { title: { text: "y (mm)" } },
      }}
    />
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric panel">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: "1.15rem" }}>{value}</div>
    </div>
  );
}
