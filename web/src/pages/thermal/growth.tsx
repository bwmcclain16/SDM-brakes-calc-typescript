/** Thermal growth: how much the metal moves, and where.
 *
 * Two answers, in that order. `u(r)` is the number — free-disc thermoelastic
 * displacement from the thickness-averaged temperature profile. The growth
 * outline is the shape: every point of the real drawing mapped through that
 * displacement field individually, so features translate outward AND distort
 * by the local gradient instead of the whole outline being scaled as a picture.
 *
 * Real growth is a few tenths of a millimetre on a ~180 mm rotor — invisible at
 * 1:1 — so the outline exaggerates the MOVEMENT only. Every number stays true
 * scale.
 */
import { useMemo, useState } from "react";
import { AnimatedChart, Chart } from "../../components/Chart.tsx";
import { flattenPaths } from "./field.ts";
import { snapshotRows } from "./field.ts";
import type { ResolvedGeometry } from "./geometry.tsx";
import type { SolverOk } from "../../worker/solver.worker.ts";

import {
  annulusDeltaTProfile,
  axialStrainProfile,
  radialExpansionFreeDisc,
  sectionDeltaTProfile,
} from "@core/solvers/thermalExpansion.ts";
import type { ThermalExpansionResult } from "@core/solvers/thermalExpansion.ts";
import {
  circlePathMm,
  decimatePaths,
  deformFacePaths,
  deformSectionPolygon,
  facePaths,
} from "@core/solvers/thermalGrowthGeometry.ts";
import type { GrowthOverlay, Point } from "@core/solvers/thermalGrowthGeometry.ts";
import type { RotorMaterial } from "@core/models/rotors.ts";

// --- dT(r) for any snapshot, whichever solver produced the field --------------

interface FaceBinning {
  centersM: number[];
  binOf: Int32Array;
  activeIndices: Int32Array;
  nBins: number;
}

/** Radius bins over the face model's active cells.
 *
 * The plate model resolves hot spots in-plane, but the free-disc solution is
 * axisymmetric — so growth takes the azimuthal mean of each radius ring.
 * Binned per snapshot rather than read off the solver's peak-snapshot
 * `radial_mean_c`, so growth tracks the selected time and every frame.
 */
function faceBinning(field: SolverOk, nBins = 40): FaceBinning | null {
  const mask = field.activeMask;
  if (!mask) return null;
  const { nRows, nCols, colAxisM, rowAxisM } = field;
  const indices: number[] = [];
  const radii: number[] = [];
  for (let j = 0; j < nRows; j++) {
    const y = rowAxisM[j]!;
    for (let i = 0; i < nCols; i++) {
      const k = j * nCols + i;
      if (mask[k] !== 1) continue;
      const x = colAxisM[i]!;
      indices.push(k);
      radii.push(Math.sqrt(x * x + y * y));
    }
  }
  if (!radii.length) return null;
  const rMin = Math.min(...radii);
  const rMax = Math.max(...radii);
  const width = (rMax - rMin) / nBins;
  const centersM: number[] = new Array(nBins);
  for (let b = 0; b < nBins; b++) centersM[b] = rMin + width * (b + 0.5);
  const binOf = new Int32Array(radii.length);
  for (let n = 0; n < radii.length; n++) {
    const raw = width > 0 ? Math.floor((radii[n]! - rMin) / width) : 0;
    binOf[n] = Math.min(Math.max(raw, 0), nBins - 1);
  }
  return { centersM, binOf, activeIndices: Int32Array.from(indices), nBins };
}

export interface DeltaTProfile {
  rM: number[];
  deltaTC: number[];
}

function deltaTProfile(
  field: SolverOk,
  snapIndex: number,
  referenceC: number,
  bins: FaceBinning | null,
): DeltaTProfile | null {
  if (field.kind === "face") {
    if (!bins) return null;
    const base = snapIndex * field.nRows * field.nCols;
    const sums = new Float64Array(bins.nBins);
    const counts = new Int32Array(bins.nBins);
    for (let n = 0; n < bins.activeIndices.length; n++) {
      const v = field.snapData[base + bins.activeIndices[n]!]!;
      if (!Number.isFinite(v)) continue;
      const b = bins.binOf[n]!;
      sums[b]! += v;
      counts[b]! += 1;
    }
    const rM: number[] = [];
    const deltaTC: number[] = [];
    for (let b = 0; b < bins.nBins; b++) {
      if (counts[b]! === 0) continue;
      rM.push(bins.centersM[b]!);
      deltaTC.push(sums[b]! / counts[b]! - referenceC);
    }
    return rM.length >= 2 ? { rM, deltaTC } : null;
  }

  const rows = snapshotRows(field, snapIndex);
  if (field.kind === "annulus") {
    return { rM: field.colAxisM, deltaTC: annulusDeltaTProfile(rows, field.rowAxisM, referenceC) };
  }
  const [all, valid] = sectionDeltaTProfile(rows, referenceC);
  const rM: number[] = [];
  const deltaTC: number[] = [];
  valid.forEach((ok, i) => {
    if (!ok) return;
    rM.push(field.colAxisM[i]!);
    deltaTC.push(all[i]!);
  });
  return rM.length >= 2 ? { rM, deltaTC } : null;
}

/** OD and bobbin-circle radial growth (mm) at a run's peak state.
 *
 * Referenced to ambient, and used by the sweep comparison where the question is
 * "how much more does the metal move as the event gets bigger" rather than
 * "what does it look like". Null when the material lacks expansion data.
 */
export function sweepGrowthMm(
  field: SolverOk,
  material: RotorMaterial,
  ambientC: number,
  bobbinCircleMm: number,
): { odMm: number | null; bobbinMm: number | null } {
  if (material.thermal_expansion_1_k == null || material.poissons_ratio == null) {
    return { odMm: null, bobbinMm: null };
  }
  let rM: number[];
  let deltaTC: number[];
  if (field.kind === "face") {
    // The solver already reports the azimuthal mean per radius ring at its own
    // peak snapshot, which is exactly the profile the free-disc solution wants.
    rM = [];
    deltaTC = [];
    (field.radialBinsM ?? []).forEach((r, i) => {
      const mean = field.radialMeanC?.[i];
      if (mean == null || !Number.isFinite(mean)) return;
      rM.push(r);
      deltaTC.push(mean - ambientC);
    });
  } else {
    const bins = null;
    const peak = nearestIndex(field.snapTimesS, field.peakTimeS);
    const profile = deltaTProfile(field, peak, ambientC, bins);
    if (!profile) return { odMm: null, bobbinMm: null };
    rM = profile.rM;
    deltaTC = profile.deltaTC;
  }
  if (rM.length < 2) return { odMm: null, bobbinMm: null };
  try {
    const result = radialExpansionFreeDisc(rM, deltaTC, material);
    const bobbinRadiusM = bobbinCircleMm / 2000.0;
    const inDomain = rM[0]! <= bobbinRadiusM && bobbinRadiusM <= rM[rM.length - 1]!;
    const bobbin = inDomain
      ? interpAt(result.r_m, result.radial_displacement_m, bobbinRadiusM)
      : result.radial_displacement_m[0]!;
    return { odMm: result.outer_radial_growth_m * 1000.0, bobbinMm: bobbin * 1000.0 };
  } catch {
    return { odMm: null, bobbinMm: null };
  }
}

function nearestIndex(values: number[], target: number): number {
  let best = 0;
  let gap = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

// --- outline ------------------------------------------------------------------

type OverlayKind = "face" | "section";

function nearestNice(wanted: number): number {
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return nice.reduce((best, v) => (Math.abs(v - wanted) < Math.abs(best - wanted) ? v : best), 1);
}

// --- component ----------------------------------------------------------------

export interface GrowthTabProps {
  field: SolverOk;
  geometry: ResolvedGeometry;
  material: RotorMaterial;
  ambientC: number;
  bobbinCircleDefaultMm: number;
  snapIndex: number;
}

export function GrowthTab({
  field,
  geometry,
  material,
  ambientC,
  bobbinCircleDefaultMm,
  snapIndex,
}: GrowthTabProps) {
  const [referenceC, setReferenceC] = useState(ambientC);
  const [bobbinCircleMm, setBobbinCircleMm] = useState(bobbinCircleDefaultMm);
  const [exaggerationInput, setExaggerationInput] = useState<number | null>(null);
  const [animate, setAnimate] = useState(false);
  const [maxOutlinePoints, setMaxOutlinePoints] = useState(1500);

  const bins = useMemo(() => (field.kind === "face" ? faceBinning(field) : null), [field]);

  const missing: string[] = [];
  if (material.thermal_expansion_1_k == null) missing.push("thermal expansion coefficient");
  if (material.poissons_ratio == null) missing.push("Poisson's ratio");

  const profile = useMemo(
    () => (missing.length ? null : deltaTProfile(field, snapIndex, referenceC, bins)),
    [field, snapIndex, referenceC, bins, missing.length],
  );

  const expansion = useMemo<{ result: ThermalExpansionResult | null; error: string | null }>(() => {
    if (!profile) return { result: null, error: null };
    try {
      return { result: radialExpansionFreeDisc(profile.rM, profile.deltaTC, material), error: null };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [profile, material]);

  // Which linework gets deformed, and about which axes.
  const outline = useMemo(() => {
    const result = expansion.result;
    if (!result) return null;
    const rExp = result.r_m;
    if (geometry.plan) {
      return {
        kind: "face" as OverlayKind,
        basePaths: facePaths(
          geometry.plan.outline_paths_mm,
          geometry.faceHoles,
          geometry.faceSlots,
          geometry.faceInner,
        ),
        what: "imported rotor face drawing",
      };
    }
    if (geometry.source === "upload" && geometry.sectionPointsMm) {
      return { kind: "section" as OverlayKind, basePaths: null, what: "imported cross-section" };
    }
    const bobbinRadiusM = bobbinCircleMm / 2000.0;
    const inDomain = rExp[0]! <= bobbinRadiusM && bobbinRadiusM <= rExp[rExp.length - 1]!;
    const rings: Point[][] = [
      circlePathMm(2000.0 * rExp[rExp.length - 1]!),
      circlePathMm(2000.0 * rExp[0]!),
    ];
    if (inDomain) rings.push(circlePathMm(bobbinCircleMm));
    return {
      kind: "face" as OverlayKind,
      basePaths: rings,
      what: "parametric annulus (OD, modeled inner edge, bobbin circle)",
    };
  }, [expansion.result, geometry, bobbinCircleMm]);

  const trueGrowthMm = expansion.result
    ? 1000.0 * Math.max(...expansion.result.radial_displacement_m.map(Math.abs))
    : 0;
  const rOuterMm = expansion.result ? 1000.0 * expansion.result.r_m[expansion.result.r_m.length - 1]! : 0;
  const autoExaggeration = trueGrowthMm > 1e-9 ? nearestNice((0.03 * rOuterMm) / trueGrowthMm) : 1;
  const exaggeration = exaggerationInput ?? autoExaggeration;

  const deform = useMemo(() => {
    return (result: ThermalExpansionResult, paths: Point[][] | null): GrowthOverlay | null => {
      if (!outline) return null;
      try {
        if (outline.kind === "section") {
          const pts = geometry.sectionPointsMm!;
          return deformSectionPolygon(
            [...pts, pts[0]!],
            result.r_m,
            result.radial_displacement_m,
            axialStrainProfile(result, material),
            exaggeration,
          );
        }
        return deformFacePaths(
          paths ?? outline.basePaths!,
          result.r_m,
          result.radial_displacement_m,
          exaggeration,
        );
      } catch {
        return null;
      }
    };
  }, [outline, geometry.sectionPointsMm, material, exaggeration]);

  const overlay = useMemo(
    () => (expansion.result ? deform(expansion.result, null) : null),
    [expansion.result, deform],
  );

  // --- animation frames: re-solve expansion on every displayed frame ----------
  const animation = useMemo(() => {
    if (!animate || !outline || missing.length) return null;
    const total = field.snapTimesS.length;
    const perFrame = Math.max(overlay ? overlay.base_paths_mm.reduce((n, p) => n + p.length, 0) : 1, 1);
    const stride = Math.max(1, Math.ceil((total * perFrame) / 400_000));
    const thinned =
      outline.kind === "face" ? decimatePaths(outline.basePaths!, maxOutlinePoints) : null;

    const frames: Array<{
      timeS: number;
      x: Array<number | null>;
      y: Array<number | null>;
      odGrowthMm: number;
      peakRiseC: number;
    }> = [];
    let base: { x: Array<number | null>; y: Array<number | null> } | null = null;
    let skipped = 0;
    for (let s = 0; s < total; s += stride) {
      const p = deltaTProfile(field, s, referenceC, bins);
      if (!p) {
        skipped += 1;
        continue;
      }
      let result: ThermalExpansionResult;
      try {
        result = radialExpansionFreeDisc(p.rM, p.deltaTC, material);
      } catch {
        skipped += 1;
        continue;
      }
      const ov = deform(result, thinned);
      if (!ov) {
        skipped += 1;
        continue;
      }
      if (!base) base = flattenPaths(ov.base_paths_mm);
      const grown = flattenPaths(ov.grown_paths_mm);
      frames.push({
        timeS: field.snapTimesS[s]!,
        x: grown.x,
        y: grown.y,
        odGrowthMm: 1000.0 * result.outer_diametral_growth_m,
        peakRiseC: Math.max(...p.deltaTC),
      });
    }
    if (!frames.length || !base) return null;
    return { frames, base, stride, skipped, total };
  }, [animate, outline, field, referenceC, bins, material, deform, maxOutlinePoints, overlay, missing.length]);

  if (missing.length) {
    return (
      <p className="note" style={{ color: "var(--warn)" }}>
        Material '{material.name}' is missing {missing.join(" and ")} — add them to the material
        database before growth can be computed.
      </p>
    );
  }
  if (expansion.error) {
    return <p className="note" style={{ color: "var(--bad)" }}>{expansion.error}</p>;
  }
  if (!expansion.result || !profile) {
    return <p className="note">No usable temperature profile at this snapshot.</p>;
  }

  const result = expansion.result;
  const bobbinRadiusM = bobbinCircleMm / 2000.0;
  const rFirst = result.r_m[0]!;
  const rLast = result.r_m[result.r_m.length - 1]!;
  const bobbinInDomain = rFirst <= bobbinRadiusM && bobbinRadiusM <= rLast;
  const bobbinGrowthM = bobbinInDomain
    ? interpAt(result.r_m, result.radial_displacement_m, bobbinRadiusM)
    : result.radial_displacement_m[0]!;
  const meanRise = result.delta_t_c.reduce((a, b) => a + b, 0) / result.delta_t_c.length;
  const timeS = field.snapTimesS[snapIndex] ?? 0;

  const baseFlat = overlay ? flattenPaths(overlay.base_paths_mm) : null;
  const grownFlat = overlay ? flattenPaths(overlay.grown_paths_mm) : null;

  return (
    <>
      <p className="note" style={{ marginTop: 0 }}>
        Free-disc thermoelastic growth (plane stress, thickness-averaged temperature) evaluated on
        the field at the snapshot selected above. Growth is measured from the reference (assembly)
        temperature — the state in which clearances were set.
      </p>

      <div className="controls">
        <div className="field">
          <label htmlFor="gr-ref">Reference (assembly) temperature, °C</label>
          <input
            id="gr-ref" type="number" step={1} value={referenceC}
            onChange={(e) => setReferenceC(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="gr-bob">Bobbin circle diameter, mm</label>
          <input
            id="gr-bob" type="number" step={1} value={bobbinCircleMm}
            onChange={(e) => setBobbinCircleMm(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="metrics">
        <Metric
          label="Outer edge radial growth"
          value={`${(result.outer_radial_growth_m * 1000).toFixed(3)} mm`}
          delta={`OD grows ${(result.outer_diametral_growth_m * 1000).toFixed(3)} mm`}
        />
        <Metric
          label="Bobbin circle radial growth"
          value={`${(bobbinGrowthM * 1000).toFixed(3)} mm`}
          delta={`bolt circle ø +${(2 * bobbinGrowthM * 1000).toFixed(3)} mm`}
        />
        <Metric label="Mean rise used" value={`${meanRise.toFixed(0)} °C`} />
        <Metric
          label="Peak hoop stress"
          value={
            result.peak_hoop_stress_pa == null
              ? "needs E"
              : `${(result.peak_hoop_stress_pa / 1e6 >= 0 ? "+" : "")}${(result.peak_hoop_stress_pa / 1e6).toFixed(0)} MPa`
          }
        />
      </div>

      {!bobbinInDomain && (
        <p className="note" style={{ color: "var(--warn)" }}>
          The bobbin circle (ø{bobbinCircleMm.toFixed(0)} mm) lies inboard of the modeled metal
          (ø{(2000 * rFirst).toFixed(0)} mm) — showing growth at the modeled inner edge instead.
          Model further inboard, or upload the full cross-section, to evaluate the true mounting
          surface.
        </p>
      )}

      <Chart
        title={`Radial thermal growth u(r) at t = ${timeS.toFixed(2)} s`}
        height={300}
        data={[
          {
            x: result.r_m.map((v) => v * 1000),
            y: result.radial_displacement_m.map((v) => v * 1000),
            type: "scatter", mode: "lines", name: "u(r)",
          },
          ...(bobbinInDomain
            ? [{
                x: [bobbinCircleMm / 2, bobbinCircleMm / 2],
                y: [
                  Math.min(...result.radial_displacement_m) * 1000,
                  Math.max(...result.radial_displacement_m) * 1000,
                ],
                type: "scatter" as const, mode: "lines" as const, name: "bobbin circle",
                line: { dash: "dash" as const, color: "#FFB800" },
              }]
            : []),
        ]}
        layout={{
          xaxis: { title: { text: "Radius (mm)" } },
          yaxis: { title: { text: "Radial growth (mm)" } },
        }}
      />
      <p className="note">
        Free-disc assumption: no restraint from hat or buttons (what a floating rotor
        approximates); restraint would trade growth for stress. The bobbin-circle growth is the
        rotor-side number — the hat runs cooler and grows less, so the required float clearance is
        roughly this growth minus the hat's own. For stepped cross-sections the constant-thickness
        disc solution is an approximation.
      </p>

      <h3 style={{ margin: "22px 0 6px", fontSize: 14 }}>Growth outline</h3>
      <p className="note" style={{ marginTop: 0 }}>
        <strong>Solid</strong> = base dimensions as drawn; <strong>dotted</strong> = where the metal
        sits at the selected snapshot. The exaggeration multiplies the <em>movement</em> only — the
        metrics above are always true scale.
      </p>

      <div className="controls">
        <div className="field">
          <label htmlFor="gr-exag">Growth exaggeration, ×</label>
          <input
            id="gr-exag" type="number" step={5} min={1} value={exaggeration}
            onChange={(e) => setExaggerationInput(Math.max(Number(e.target.value), 1))}
          />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button onClick={() => setExaggerationInput(null)}>Auto ({autoExaggeration}×)</button>
        </div>
        <Metric
          label="True peak radial growth"
          value={`${trueGrowthMm.toFixed(3)} mm`}
          delta={`${((200 * trueGrowthMm) / Math.max(2 * rOuterMm, 1e-9)).toFixed(3)} % of OD`}
        />
      </div>

      {overlay && baseFlat && grownFlat ? (
        <>
          <Chart
            title={`Thermal growth outline — ${outline!.what} (growth shown ×${exaggeration})`}
            height={460}
            equalAspect
            data={[
              {
                x: baseFlat.x, y: baseFlat.y, type: "scatter", mode: "lines",
                name: "base dimensions (as drawn)", hoverinfo: "skip",
              },
              {
                x: grownFlat.x, y: grownFlat.y, type: "scatter", mode: "lines",
                name: `expanded at t = ${timeS.toFixed(2)} s (×${exaggeration})`,
                line: { dash: "dot" }, hoverinfo: "skip",
              },
            ]}
            layout={{
              xaxis: { title: { text: outline!.kind === "section" ? "Radius (mm)" : "x (mm)" } },
              yaxis: { title: { text: outline!.kind === "section" ? "Axial (mm)" : "y (mm)" } },
            }}
          />
          <p className="note">
            Outer modeled edge (ø{(2 * rOuterMm).toFixed(1)} mm) grows{" "}
            {(result.outer_diametral_growth_m * 1000).toFixed(3)} mm on diameter
            {outline!.kind === "section"
              ? " · the section also grows through its thickness (plane-stress ε_z about the mid-plane)"
              : ""}
            .
          </p>
          {overlay.outside_domain_fraction > 0 && (
            <p className="note" style={{ color: "var(--warn)" }}>
              {(overlay.outside_domain_fraction * 100).toFixed(0)}% of the drawing's linework lies
              outside the modeled metal (ø{(2000 * rFirst).toFixed(0)}–{(2 * rOuterMm).toFixed(0)} mm)
              — those points are drawn with the nearest modeled edge's displacement, not a computed
              one. Model further inboard to cover them.
            </p>
          )}
        </>
      ) : (
        <p className="note">The outline could not be deformed at this snapshot.</p>
      )}

      <h3 style={{ margin: "22px 0 6px", fontSize: 14 }}>
        Growth animation {field.snapSpan === "run" ? "(whole multi-stop run)" : "(single stop + cool-down)"}
      </h3>
      <p className="note" style={{ marginTop: 0 }}>
        <strong>Dotted</strong> = base dimensions (the cold reference, fixed);{" "}
        <strong>solid</strong> = the actual hot dimensions at that instant. Watch the rotor swell
        through each stop and shrink back through the gap — the residual gap at the end of a gap is
        the heat the run never gave back, which is what makes a multi-stop event grow more than any
        single stop.
      </p>
      <div className="controls">
        <div className="field">
          <label>&nbsp;</label>
          <button className={animate ? undefined : "primary"} onClick={() => setAnimate((v) => !v)}>
            {animate ? "Hide animation" : "Build growth animation"}
          </button>
        </div>
        {animate && outline?.kind === "face" && (
          <div className="field">
            <label htmlFor="gr-pts">Max outline points per frame</label>
            <input
              id="gr-pts" type="number" step={500} min={50} value={maxOutlinePoints}
              onChange={(e) => setMaxOutlinePoints(Math.max(Number(e.target.value), 50))}
            />
          </div>
        )}
      </div>

      {animate && animation && (
        <>
          <AnimatedChart
            title={`Thermal growth at t = ${animation.frames[0]!.timeS.toFixed(1)} s — OD +${animation.frames[0]!.odGrowthMm.toFixed(3)} mm (growth shown ×${exaggeration})`}
            height={480}
            equalAspect
            data={[
              {
                x: animation.base.x, y: animation.base.y, type: "scatter", mode: "lines",
                name: "base dimensions (cold)", line: { dash: "dot" }, hoverinfo: "skip",
              },
              {
                x: animation.frames[0]!.x, y: animation.frames[0]!.y,
                type: "scatter", mode: "lines", name: "actual (hot)", hoverinfo: "skip",
              },
            ]}
            frames={animation.frames.map((f) => ({
              label: `${f.timeS.toFixed(1)} s`,
              traces: [1],
              data: [{ x: f.x, y: f.y, type: "scatter", mode: "lines" }],
              title: `Thermal growth at t = ${f.timeS.toFixed(1)} s — OD +${f.odGrowthMm.toFixed(3)} mm, peak rise ${f.peakRiseC.toFixed(0)} °C (growth shown ×${exaggeration})`,
            }))}
            layout={{
              // Axis ranges are locked across the run: an autoranged animation
              // rescales frame to frame, which reads as the rotor NOT growing.
              xaxis: { title: { text: outline!.kind === "section" ? "Radius (mm)" : "x (mm)" }, range: animation.base.x.length ? boundsOf(animation.base.x, exaggeration, trueGrowthMm) : undefined },
              yaxis: { title: { text: outline!.kind === "section" ? "Axial (mm)" : "y (mm)" }, range: animation.base.y.length ? boundsOf(animation.base.y, exaggeration, trueGrowthMm) : undefined },
            }}
          />
          <p className="note">
            {animation.frames.length} frames of {animation.total}
            {animation.stride > 1 ? ` (every ${animation.stride}${ordinal(animation.stride)})` : ""} ·{" "}
            {animation.frames[animation.frames.length - 1]!.timeS.toFixed(0)} s of{" "}
            {field.snapSpan === "run" ? "run time" : "stop + cool-down"} · peak OD growth over the
            run {Math.max(...animation.frames.map((f) => f.odGrowthMm)).toFixed(3)} mm · outline
            shown ×{exaggeration}
            {animation.skipped ? ` · ${animation.skipped} frames skipped (no valid profile)` : ""}
          </p>
        </>
      )}
      {animate && !animation && (
        <p className="note">
          No frame in this run produced a usable temperature profile for the expansion solve, so
          there is nothing to animate.
        </p>
      )}
    </>
  );
}

function boundsOf(values: Array<number | null>, exaggeration: number, growthMm: number): [number, number] {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const pad = 0.02 * (hi - lo) + exaggeration * growthMm;
  return [lo - pad, hi + pad];
}

function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return "st";
  if (n % 10 === 2 && n % 100 !== 12) return "nd";
  if (n % 10 === 3 && n % 100 !== 13) return "rd";
  return "th";
}

function interpAt(xs: number[], ys: number[], x: number): number {
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]!) {
      const span = xs[i]! - xs[i - 1]!;
      if (span === 0) return ys[i]!;
      return ys[i - 1]! + ((x - xs[i - 1]!) * (ys[i]! - ys[i - 1]!)) / span;
    }
  }
  return ys[ys.length - 1]!;
}

function Metric({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <div className="metric panel">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && <div className="metric-delta">{delta}</div>}
    </div>
  );
}
