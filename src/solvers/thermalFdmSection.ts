/** 2D axisymmetric transient conduction on an arbitrary rotor cross-section.
 *
 * Generalizes `./thermalFdm.ts` (which assumes a constant-thickness annulus)
 * to any axisymmetric profile: the rotor cross-section is supplied as a
 * closed polygon in the (r, z) plane -- imported from CAD or built
 * parametrically -- so stepped hats, undercuts, and variable thickness all
 * conduct correctly.
 *
 * Discretization: the polygon is rasterized onto a regular cell-centered grid
 * over its bounding box (a cell is active when its center lies inside the
 * polygon). Finite-volume conduction runs between adjacent active cells;
 * every face between an active cell and the outside is a cooling surface
 * (convection + radiation). Pad heat enters through the top and bottom
 * exposed faces of each radial column inside the swept band.
 *
 * The pad swept band is defined FROM THE OUTER EDGE of the section:
 * `SweptBand(outer_offset_mm, depth_mm)` puts the pad contact between
 * `r_outer - outer_offset` and `r_outer - outer_offset - depth`.
 *
 * Differences vs the annulus model (stated per the loud-assumptions convention):
 *
 * - **Full thickness is modeled** (no mid-plane symmetry) because a general
 *   section need not be symmetric. Heat still splits evenly between the two
 *   friction faces.
 * - **Cell-centered surfaces.** Reported "surface" temperatures are cell-center
 *   values half a cell below the true surface; refine the grid for sharp pulses.
 * - **Voxel boundary.** Curved/diagonal profile edges are stair-stepped at the
 *   grid resolution; exposed area (and thus cooling) is the voxelized area.
 * - Circumferential smearing, solid-disc convection, and `rotor_heat_fraction`
 *   semantics match the annulus model.
 *
 * **Inactive cells are NaN in every REPORTED field** (`temperature_c`,
 * `active_mask`); internally the working `field` buffer keeps a real number
 * (ambient) at inactive cells so no NaN ever enters the stencil -- conduction,
 * cooling, and flux conductances/areas are all exactly zero at an inactive
 * cell's faces, so its `heat` accumulator never receives a nonzero
 * contribution and `field[inactive]` is never advanced, matching the Python
 * `field[mask] += dt * heat[mask]` boolean-indexed update exactly.
 *
 * Numerical fields are flat `Float64Array`s (`index = j * nRadial + i`,
 * `j` = axial/z, `i` = radial/r), matching `./thermalFdm.ts`'s layout and
 * loop-recomputation style (each conduction term is recomputed in the `+=`
 * pass and again in the `-=` pass rather than cached, mirroring two separate
 * numpy statements over the whole array).
 */
import { STEFAN_BOLTZMANN, ZERO_CELSIUS_K } from "../constants.ts";
import { NeedsInputError } from "../errors.ts";
import type { CoolingParameters } from "../models/internal.ts";
import type { RotorMaterial } from "../models/rotors.ts";
import {
  heatPulsePeakPowerW,
  heatPulsePowerW,
  semiInfiniteSurfaceRiseC,
  stableTimeStepS,
  type FieldSnapshot,
  type HeatPulse,
} from "./thermalFdm.ts";

// --- domain types -------------------------------------------------------------

/** A ring of identical through-holes (cross-drilling), smeared azimuthally.
 *
 * The 2D axisymmetric model cannot resolve discrete holes; instead each band
 * removes the azimuthal fraction of material the holes occupy at every
 * radius (less mass, less conduction, less pad contact) and adds the hole
 * walls as extra convective/radiative cooling surface -- the standard
 * smeared-porosity treatment.
 */
export interface HoleBand {
  count: number;
  hole_diameter_mm: number;
  center_radius_mm: number;
}

export function makeHoleBand(count: number, holeDiameterMm: number, centerRadiusMm: number): HoleBand {
  if (count < 1) throw new Error("hole band count must be >= 1");
  if (holeDiameterMm <= 0.0) throw new Error("hole_diameter_mm must be positive");
  if (centerRadiusMm <= holeDiameterMm / 2.0) {
    throw new Error("hole band must sit clear of the rotation axis");
  }
  return { count, hole_diameter_mm: holeDiameterMm, center_radius_mm: centerRadiusMm };
}

/** Closed axisymmetric cross-section polygon, coordinates in mm.
 *
 * `points_mm` are (r, z) vertices; r is the distance from the rotation axis
 * and must be positive everywhere. The polygon is closed implicitly (last
 * vertex connects back to the first). `hole_bands` adds smeared
 * cross-drilling (see `HoleBand`).
 */
export interface RotorSection {
  points_mm: ReadonlyArray<readonly [number, number]>;
  material: RotorMaterial;
  hole_bands: ReadonlyArray<HoleBand>;
}

export function sectionROuterMm(section: RotorSection): number {
  let m = -Infinity;
  for (const p of section.points_mm) if (p[0] > m) m = p[0];
  return m;
}

export function sectionRInnerMm(section: RotorSection): number {
  let m = Infinity;
  for (const p of section.points_mm) if (p[0] < m) m = p[0];
  return m;
}

export function sectionZSpanMm(section: RotorSection): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of section.points_mm) {
    if (p[1] < lo) lo = p[1];
    if (p[1] > hi) hi = p[1];
  }
  return [lo, hi];
}

/** Shoelace area of the (r, z) polygon. */
export function sectionPlanAreaMm2(section: RotorSection): number {
  const pts = section.points_mm;
  const n = pts.length;
  let area = 0.0;
  for (let k = 0; k < n; k++) {
    const [r0, z0] = pts[k]!;
    const [r1, z1] = pts[(k + 1) % n]!;
    area += r0 * z1 - r1 * z0;
  }
  return Math.abs(area) / 2.0;
}

export function makeRotorSection(
  pointsMm: ReadonlyArray<readonly [number, number]>,
  material: RotorMaterial,
  holeBands: ReadonlyArray<HoleBand> = [],
): RotorSection {
  if (pointsMm.length < 3) {
    throw new Error("a cross-section polygon needs at least 3 points");
  }
  let minR = Infinity;
  for (const p of pointsMm) if (p[0] < minR) minR = p[0];
  if (minR <= 0.0) {
    throw new Error(
      "cross-section radii must all be positive (r is distance from the rotation axis; " +
        "shift the profile if it was drawn from a local origin)",
    );
  }
  const section: RotorSection = { points_mm: pointsMm, material, hole_bands: holeBands };
  if (sectionPlanAreaMm2(section) <= 0.0) {
    throw new Error("cross-section polygon has zero area");
  }
  return section;
}

/** Pad contact band measured inward from the section's outer edge. */
export interface SweptBand {
  depth_mm: number;
  outer_offset_mm: number;
}

export function makeSweptBand(depthMm: number, outerOffsetMm = 0.0): SweptBand {
  if (depthMm <= 0.0) throw new Error("swept band depth_mm must be positive");
  if (outerOffsetMm < 0.0) throw new Error("swept band outer_offset_mm must be >= 0");
  return { depth_mm: depthMm, outer_offset_mm: outerOffsetMm };
}

export interface SectionFdmModel {
  section: RotorSection;
  cooling: CoolingParameters;
  swept_band: SweptBand;
  rotor_heat_fraction: number | null; // null -> cooling.rotor_heat_fraction
  n_radial: number;
  n_axial: number;
}

export function makeSectionFdmModel(
  section: RotorSection,
  cooling: CoolingParameters,
  sweptBand: SweptBand,
  rotorHeatFraction: number | null = null,
  nRadial = 81,
  nAxial = 33,
): SectionFdmModel {
  if (nRadial < 5 || nAxial < 5) {
    throw new Error("n_radial and n_axial must both be >= 5");
  }
  const model: SectionFdmModel = {
    section,
    cooling,
    swept_band: sweptBand,
    rotor_heat_fraction: rotorHeatFraction,
    n_radial: nRadial,
    n_axial: nAxial,
  };
  const frac = sectionFdmHeatFraction(model);
  if (!(frac > 0.0 && frac <= 1.0)) {
    throw new Error("rotor_heat_fraction must be in (0, 1]");
  }
  return model;
}

export function sectionFdmHeatFraction(model: SectionFdmModel): number {
  if (model.rotor_heat_fraction !== null && model.rotor_heat_fraction !== undefined) {
    return model.rotor_heat_fraction;
  }
  return model.cooling.rotor_heat_fraction ?? 1.0;
}

export interface SectionThermalResult {
  r_m: number[]; // (n_radial,) cell centers
  z_m: number[]; // (n_axial,) cell centers
  active_mask: FieldSnapshot; // (n_axial, n_radial) 1.0/0.0, no NaN
  snapshot_times_s: number[];
  temperature_c: FieldSnapshot[]; // (n_snap,) each (n_axial, n_radial), NaN outside
  surface_history_times_s: number[];
  peak_surface_history_c: number[]; // max over pad-contact cells
  bulk_average_history_c: number[];
  peak_surface_temperature_c: number;
  peak_surface_time_s: number;
  lumped_delta_t_c: number;
  analytic_surface_rise_c: number;
  dt_s: number;
  energy_balance_error_fraction: number;
  section_mass_kg: number;
  flux_area_m2: number; // total pad-contact area, both faces
  swept_r_bounds_m: [number, number];
  // Energy accounting (J); histories share surface_history_times_s. Zero /
  // null for prescribed-temperature solves.
  energy_in_j: number;
  stored_energy_j: number;
  convective_energy_j: number;
  radiative_energy_j: number;
  energy_in_history_j: number[] | null;
  convective_energy_history_j: number[] | null;
  radiative_energy_history_j: number[] | null;
}

export interface SectionEventTrainResult {
  converged: boolean;
  events_run: number;
  peak_surface_temperatures_c: number[];
  peak_bulk_temperatures_c: number[];
  cyclic_peak_surface_c: number;
  surface_minus_bulk_at_peak_c: number;
  final_field: SectionThermalResult;
  limit_exceeded: boolean;
  // Totals summed over every event run (J).
  total_energy_in_j: number;
  total_convective_energy_j: number;
  total_radiative_energy_j: number;
  // CONTINUOUS history across the WHOLE train (every stop and every gap).
  train_times_s: number[] | null;
  train_peak_surface_c: number[] | null;
  train_bulk_average_c: number[] | null;
  // Field snapshots spanning the whole train for animation; NaN outside the
  // section (same masking as SectionThermalResult.temperature_c).
  train_snapshot_times_s: number[] | null;
  train_snapshots_c: FieldSnapshot[] | null;
}

// --- small numpy-semantics helpers (local copies -- see thermalFdm.ts for the
// canonical versions; these are private there so cannot be imported) ---------

function requireSectionMaterial(material: RotorMaterial): { k: number; rho: number; cp: number } {
  if (material.thermal_conductivity_w_mk === null || material.thermal_conductivity_w_mk === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].thermal_conductivity_w_mk`);
  }
  if (material.density_kg_m3 === null || material.density_kg_m3 === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].density_kg_m3`);
  }
  if (material.specific_heat_j_kgk === null || material.specific_heat_j_kgk === undefined) {
    throw new NeedsInputError(`rotor_material[${material.name}].specific_heat_j_kgk`);
  }
  return {
    k: material.thermal_conductivity_w_mk,
    rho: material.density_kg_m3,
    cp: material.specific_heat_j_kgk,
  };
}

/** np.linspace(start, stop, num) -- endpoint inclusive, exact. */
function linspace(start: number, stop: number, num: number): Float64Array {
  const n = Math.max(num, 0);
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = i === n - 1 ? stop : start + i * step;
  return out;
}

/** np.round / Python round(): round-half-to-even. */
function npRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** np.unique on an already-rounded array: sorted, deduplicated. */
function uniqueSorted(xs: Float64Array): number[] {
  const arr = Array.from(xs);
  arr.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of arr) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

function sumAll(arr: Float64Array): number {
  let s = 0.0;
  for (let idx = 0; idx < arr.length; idx++) s += arr[idx]!;
  return s;
}

function weightedSum(capacity: Float64Array, field: Float64Array): number {
  let s = 0.0;
  for (let idx = 0; idx < capacity.length; idx++) s += capacity[idx]! * field[idx]!;
  return s;
}

function arrMax(arr: number[]): number {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}

/** max over the flux-mask cells (pad-contact faces, both top and bottom). */
function fluxMax(field: Float64Array, fluxMask: boolean[]): number {
  let m = -Infinity;
  for (let idx = 0; idx < field.length; idx++) {
    if (fluxMask[idx] && field[idx]! > m) m = field[idx]!;
  }
  return m;
}

/** Ray-casting point-in-polygon (even-odd crossing count). For a simple
 * (non-self-intersecting) polygon this agrees with matplotlib's
 * `Path.contains_points` nonzero-winding test everywhere except exactly ON an
 * edge -- a case that never arises here because mesh cell centers are always
 * strictly interior to the bounding box by construction (see buildSectionMesh),
 * so they are strictly interior or strictly exterior to the polygon itself for
 * every polygon used in the fixtures (axis-aligned rectangles). */
function pointInPolygon(rq: number, zq: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ri = poly[i]![0];
    const zi = poly[i]![1];
    const rj = poly[j]![0];
    const zj = poly[j]![1];
    const intersects = zi > zq !== zj > zq && rq < ((rj - ri) * (zq - zi)) / (zj - zi) + ri;
    if (intersects) inside = !inside;
  }
  return inside;
}

function maskedSnapshot(field: Float64Array, mask: boolean[], nZ: number, nR: number): FieldSnapshot {
  const data = new Float64Array(field.length);
  for (let idx = 0; idx < field.length; idx++) data[idx] = mask[idx] ? field[idx]! : NaN;
  return { nAxial: nZ, nRadial: nR, data };
}

function maskToSnapshot(mask: boolean[], nZ: number, nR: number): FieldSnapshot {
  const data = new Float64Array(nZ * nR);
  for (let idx = 0; idx < data.length; idx++) data[idx] = mask[idx] ? 1.0 : 0.0;
  return { nAxial: nZ, nRadial: nR, data };
}

// --- mesh ---------------------------------------------------------------------

interface Mesh {
  r: Float64Array; // (nR,) cell centers, m
  z: Float64Array; // (nZ,) cell centers, m
  dr: number;
  dz: number;
  material: RotorMaterial;
  mask: boolean[]; // flat nZ*nR
  capacity: Float64Array; // flat nZ*nR
  gAxial: Float64Array; // flat (nZ-1)*nR, between rows j, j+1
  gRadial: Float64Array; // flat nZ*(nR-1), between columns kk, kk+1
  aCool: Float64Array; // flat nZ*nR
  aFlux: Float64Array; // flat nZ*nR
  fluxMask: boolean[]; // flat nZ*nR
  fluxAreaTotal: number;
  sectionMass: number;
  bandBounds: [number, number];
  nR: number;
  nZ: number;
}

function buildSectionMesh(model: SectionFdmModel): Mesh {
  const section = model.section;
  const { k, rho, cp } = requireSectionMaterial(section.material);

  const rLo = sectionRInnerMm(section) / 1000.0;
  const rHi = sectionROuterMm(section) / 1000.0;
  const [zLoMm, zHiMm] = sectionZSpanMm(section);
  const zLo = zLoMm / 1000.0;
  const zHi = zHiMm / 1000.0;

  const nR = model.n_radial;
  const nZ = model.n_axial;
  const nCells = nZ * nR;
  const dr = (rHi - rLo) / nR;
  const dz = (zHi - zLo) / nZ;
  const rCenters = new Float64Array(nR);
  for (let i = 0; i < nR; i++) rCenters[i] = rLo + (i + 0.5) * dr;
  const zCenters = new Float64Array(nZ);
  for (let j = 0; j < nZ; j++) zCenters[j] = zLo + (j + 0.5) * dz;

  // Rasterize: cell active when its center is inside the polygon.
  const polyM: [number, number][] = section.points_mm.map(([r, z]) => [r / 1000.0, z / 1000.0]);
  const mask = new Array<boolean>(nCells);
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      mask[j * nR + i] = pointInPolygon(rCenters[i]!, zCenters[j]!, polyM);
    }
  }
  let anyActive = false;
  for (let idx = 0; idx < nCells; idx++) {
    if (mask[idx]) {
      anyActive = true;
      break;
    }
  }
  if (!anyActive) {
    throw new Error("no grid cells fall inside the cross-section; check units/axes");
  }

  // Smeared cross-drilling: solid azimuthal fraction f(r) per radial column.
  const solidFraction = new Float64Array(nR).fill(1.0);
  const holeWallPerM = new Float64Array(nR).fill(0.0);
  for (const band of section.hole_bands) {
    const rHole = band.hole_diameter_mm / 2000.0;
    const rCenter = band.center_radius_mm / 1000.0;
    for (let i = 0; i < nR; i++) {
      const diff = rCenters[i]! - rCenter;
      if (Math.abs(diff) < rHole) {
        const clipped = Math.max(rHole ** 2 - diff ** 2, 0.0);
        const chord = 2.0 * Math.sqrt(clipped);
        solidFraction[i] = solidFraction[i]! - (band.count * chord) / (2.0 * Math.PI * rCenters[i]!);
        holeWallPerM[i] = holeWallPerM[i]! + (band.count * Math.PI * (2.0 * rHole) * dr) / (2.0 * rHole);
      }
    }
  }
  let minSolid = Infinity;
  for (let i = 0; i < nR; i++) if (solidFraction[i]! < minSolid) minSolid = solidFraction[i]!;
  if (minSolid <= 0.02) {
    throw new Error(
      "hole bands remove (nearly) the full circumference at some radius — " +
        "check hole counts/diameters/positions",
    );
  }
  const fFace = new Float64Array(Math.max(nR - 1, 0));
  for (let kk = 0; kk < nR - 1; kk++) fFace[kk] = 0.5 * (solidFraction[kk]! + solidFraction[kk + 1]!);

  // Per-column geometric quantities. These are z-independent BY CONSTRUCTION
  // (the Python `rr` meshgrid replicates r_centers across every z row), so we
  // compute them once per radial column instead of materializing a redundant
  // (n_z, n_r) array -- the values are bit-identical to what indexing the
  // full grid would give.
  const volumeAtR = new Float64Array(nR);
  const aZFaceAtR = new Float64Array(nR);
  const aOuterFaceAtR = new Float64Array(nR);
  const aInnerFaceAtR = new Float64Array(nR);
  for (let i = 0; i < nR; i++) {
    volumeAtR[i] = 2.0 * Math.PI * rCenters[i]! * dr * dz * solidFraction[i]!;
    aZFaceAtR[i] = 2.0 * Math.PI * rCenters[i]! * dr * solidFraction[i]!;
    aOuterFaceAtR[i] = 2.0 * Math.PI * (rCenters[i]! + dr / 2.0) * dz * solidFraction[i]!;
    aInnerFaceAtR[i] = 2.0 * Math.PI * (rCenters[i]! - dr / 2.0) * dz * solidFraction[i]!;
  }
  const rFacesBetween = new Float64Array(Math.max(nR - 1, 0));
  for (let kk = 0; kk < nR - 1; kk++) rFacesBetween[kk] = rLo + (kk + 1) * dr;
  const aRFaceAtFace = new Float64Array(Math.max(nR - 1, 0));
  for (let kk = 0; kk < nR - 1; kk++) {
    aRFaceAtFace[kk] = 2.0 * Math.PI * rFacesBetween[kk]! * dz * fFace[kk]!;
  }

  const capacity = new Float64Array(nCells);
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      const idx = j * nR + i;
      capacity[idx] = mask[idx] ? rho * cp * volumeAtR[i]! : 0.0;
    }
  }

  // Conduction conductances between adjacent ACTIVE cells.
  const gAxial = new Float64Array(Math.max(nZ - 1, 0) * nR);
  for (let j = 0; j < nZ - 1; j++) {
    for (let i = 0; i < nR; i++) {
      const bothZ = mask[j * nR + i]! && mask[(j + 1) * nR + i]!;
      gAxial[j * nR + i] = bothZ ? (k * aZFaceAtR[i]!) / dz : 0.0;
    }
  }
  const gRadial = new Float64Array(nZ * Math.max(nR - 1, 0));
  for (let j = 0; j < nZ; j++) {
    for (let kk = 0; kk < nR - 1; kk++) {
      const bothR = mask[j * nR + kk]! && mask[j * nR + kk + 1]!;
      gRadial[j * (nR - 1) + kk] = bothR ? (k * aRFaceAtFace[kk]!) / dr : 0.0;
    }
  }

  // Exposed boundary faces (active cell with inactive/out-of-domain neighbor).
  const exposedUp = new Array<boolean>(nCells).fill(false);
  const exposedDown = new Array<boolean>(nCells).fill(false);
  const exposedOut = new Array<boolean>(nCells).fill(false);
  const exposedIn = new Array<boolean>(nCells).fill(false);
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      const idx = j * nR + i;
      if (!mask[idx]) continue;
      exposedUp[idx] = j === nZ - 1 || !mask[(j + 1) * nR + i]!;
      exposedDown[idx] = j === 0 || !mask[(j - 1) * nR + i]!;
      exposedOut[idx] = i === nR - 1 || !mask[j * nR + i + 1]!;
      exposedIn[idx] = i === 0 || !mask[j * nR + i - 1]!;
    }
  }

  const aCool = new Float64Array(nCells);
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      const idx = j * nR + i;
      let a = 0.0;
      a += exposedUp[idx] ? aZFaceAtR[i]! : 0.0;
      a += exposedDown[idx] ? aZFaceAtR[i]! : 0.0;
      a += exposedOut[idx] ? aOuterFaceAtR[i]! : 0.0;
      a += exposedIn[idx] ? aInnerFaceAtR[i]! : 0.0;
      a += mask[idx] ? holeWallPerM[i]! * dz : 0.0;
      aCool[idx] = a;
    }
  }

  // Pad flux faces: per radial column inside the swept band, the top-most and
  // bottom-most active cells take flux through their exposed z faces.
  const rOut = rHi;
  const bandHi = rOut - model.swept_band.outer_offset_mm / 1000.0;
  const bandLo = bandHi - model.swept_band.depth_mm / 1000.0;
  const fluxMask = new Array<boolean>(nCells).fill(false);
  for (let i = 0; i < nR; i++) {
    if (rCenters[i]! >= bandLo && rCenters[i]! <= bandHi) {
      let topRow = -1;
      let bottomRow = -1;
      for (let j = 0; j < nZ; j++) {
        if (mask[j * nR + i]!) {
          if (bottomRow === -1) bottomRow = j;
          topRow = j;
        }
      }
      if (bottomRow === -1) continue;
      fluxMask[topRow * nR + i] = true; // top friction face
      fluxMask[bottomRow * nR + i] = true; // bottom friction face
    }
  }
  let anyFlux = false;
  for (let idx = 0; idx < nCells; idx++) {
    if (fluxMask[idx]) {
      anyFlux = true;
      break;
    }
  }
  if (!anyFlux) {
    throw new Error(
      "swept band does not intersect the cross-section; check the pad " +
        "offset/depth against the section's outer radius",
    );
  }
  const aFlux = new Float64Array(nCells);
  let fluxAreaTotal = 0.0;
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      const idx = j * nR + i;
      aFlux[idx] = fluxMask[idx] ? aZFaceAtR[i]! : 0.0;
      fluxAreaTotal += aFlux[idx]!;
    }
  }

  let sectionMassAccum = 0.0;
  for (let j = 0; j < nZ; j++) {
    for (let i = 0; i < nR; i++) {
      if (mask[j * nR + i]!) sectionMassAccum += volumeAtR[i]!;
    }
  }
  const sectionMass = rho * sectionMassAccum;

  return {
    r: rCenters,
    z: zCenters,
    dr,
    dz,
    material: section.material,
    mask,
    capacity,
    gAxial,
    gRadial,
    aCool,
    aFlux,
    fluxMask,
    fluxAreaTotal,
    sectionMass,
    bandBounds: [bandLo, bandHi],
    nR,
    nZ,
  };
}

// --- core time stepping ---------------------------------------------------------

interface SectionRunOutput {
  result: SectionThermalResult;
  field: Float64Array;
}

function runSectionCore(
  model: SectionFdmModel,
  mesh: Mesh,
  pulse: HeatPulse,
  tFieldInit: Float64Array,
  coolDownS: number,
  snapshotsIn: number,
): SectionRunOutput {
  const cooling = model.cooling;
  const frac = sectionFdmHeatFraction(model);
  const h = cooling.convection_coefficient_w_m2k;
  const eps = cooling.emissivity;
  const tInf = cooling.ambient_temperature_c;
  const tInfK4 = (tInf + ZERO_CELSIUS_K) ** 4;
  const sigma = STEFAN_BOLTZMANN;

  const nR = mesh.nR;
  const nZ = mesh.nZ;
  const nCells = nZ * nR;

  const totalTime = pulse.duration_s + coolDownS;
  let dt = stableTimeStepS(mesh.material, mesh.dr, mesh.dz);
  const nSteps = Math.max(1, Math.ceil(totalTime / dt));
  dt = totalTime / nSteps;

  const mask = mesh.mask;
  const field = tFieldInit.slice();
  for (let idx = 0; idx < nCells; idx++) if (!mask[idx]) field[idx] = tInf;

  const capacity = mesh.capacity;
  const totalCapacity = sumAll(capacity);

  const snapshots = Math.max(2, snapshotsIn);
  const snapStepsArr = linspace(0, nSteps, snapshots).map((v) => npRound(v));
  const snapSteps = new Set<number>(uniqueSorted(snapStepsArr));
  const recordEvery = Math.max(1, Math.floor(nSteps / 1500));

  const snapFields: FieldSnapshot[] = [maskedSnapshot(field, mask, nZ, nR)];
  const snapTimes: number[] = [0.0];
  const histTimes: number[] = [0.0];
  const histPeak: number[] = [fluxMax(field, mesh.fluxMask)];
  const histBulk: number[] = [weightedSum(capacity, field) / totalCapacity];

  let peakC = histPeak[0]!;
  let peakT = 0.0;
  let energyIn = 0.0;
  let energyConv = 0.0;
  let energyRad = 0.0;
  const histIn: number[] = [0.0];
  const histConv: number[] = [0.0];
  const histRad: number[] = [0.0];
  const storedStart = weightedSum(capacity, field);

  const qScale = frac / mesh.fluxAreaTotal; // power -> flux over all pad faces

  const heat = new Float64Array(nCells);

  for (let step = 1; step <= nSteps; step++) {
    const tMid = (step - 0.5) * dt;
    heat.fill(0.0);

    // Axial conduction between rows j and j+1: heat[:-1,:]+=qz; heat[1:,:]-=qz
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[j * nR + i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[j * nR + i] += qz;
      }
    }
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[j * nR + i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[(j + 1) * nR + i] -= qz;
      }
    }

    // Radial conduction between columns kk and kk+1: heat[:,:-1]+=qr; heat[:,1:]-=qr
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk] += qr;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk + 1] -= qr;
      }
    }

    // Pad heat into the swept band (top and bottom friction faces).
    const qFluxScale = qScale * heatPulsePowerW(pulse, tMid);
    let qInSum = 0.0;
    for (let idx = 0; idx < nCells; idx++) {
      const qIn = qFluxScale * mesh.aFlux[idx]!;
      heat[idx] += qIn;
      qInSum += qIn;
    }
    energyIn += qInSum * dt;

    // Convection + radiation losses, kept as separate terms so the
    // dissipation split is reported, not just its sum.
    let sumConv = 0.0;
    let sumRad = 0.0;
    for (let idx = 0; idx < nCells; idx++) {
      const t = field[idx]!;
      const conv = h * mesh.aCool[idx]! * (t - tInf);
      const rad = eps * sigma * mesh.aCool[idx]! * ((t + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[idx] -= conv + rad;
      sumConv += conv;
      sumRad += rad;
    }
    energyConv += sumConv * dt;
    energyRad += sumRad * dt;

    for (let idx = 0; idx < nCells; idx++) {
      if (mask[idx]) field[idx] += dt * (heat[idx]! / capacity[idx]!);
    }

    const bandPeakNow = fluxMax(field, mesh.fluxMask);
    if (bandPeakNow > peakC) {
      peakC = bandPeakNow;
      peakT = step * dt;
    }
    if (step % recordEvery === 0 || step === nSteps) {
      histTimes.push(step * dt);
      histPeak.push(bandPeakNow);
      histBulk.push(weightedSum(capacity, field) / totalCapacity);
      histIn.push(energyIn);
      histConv.push(energyConv);
      histRad.push(energyRad);
    }
    if (snapSteps.has(step)) {
      snapFields.push(maskedSnapshot(field, mask, nZ, nR));
      snapTimes.push(step * dt);
    }
  }

  const stored = weightedSum(capacity, field) - storedStart;
  const energyLoss = energyConv + energyRad;
  const denom = Math.max(energyIn, 1e-9);
  const balanceError = (stored + energyLoss - energyIn) / denom;

  const lumpedDelta = (frac * pulse.energy_j) / Math.max(totalCapacity, 1e-12);
  const analytic = semiInfiniteSurfaceRiseC(qScale * heatPulsePeakPowerW(pulse), mesh.material, pulse.duration_s);

  const result: SectionThermalResult = {
    r_m: Array.from(mesh.r),
    z_m: Array.from(mesh.z),
    active_mask: maskToSnapshot(mask, nZ, nR),
    snapshot_times_s: snapTimes,
    temperature_c: snapFields,
    surface_history_times_s: histTimes,
    peak_surface_history_c: histPeak,
    bulk_average_history_c: histBulk,
    peak_surface_temperature_c: peakC,
    peak_surface_time_s: peakT,
    lumped_delta_t_c: lumpedDelta,
    analytic_surface_rise_c: analytic,
    dt_s: dt,
    energy_balance_error_fraction: balanceError,
    section_mass_kg: mesh.sectionMass,
    flux_area_m2: mesh.fluxAreaTotal,
    swept_r_bounds_m: mesh.bandBounds,
    energy_in_j: energyIn,
    stored_energy_j: stored,
    convective_energy_j: energyConv,
    radiative_energy_j: energyRad,
    energy_in_history_j: histIn,
    convective_energy_history_j: histConv,
    radiative_energy_history_j: histRad,
  };
  return { result, field };
}

// --- public API -------------------------------------------------------------------

export function simulateSectionSingleStop(
  model: SectionFdmModel,
  pulse: HeatPulse,
  initialTemperatureC: number | null = null,
  coolDownS = 0.0,
  snapshots = 25,
): SectionThermalResult {
  const mesh = buildSectionMesh(model);
  const start =
    initialTemperatureC === null || initialTemperatureC === undefined
      ? model.cooling.ambient_temperature_c
      : initialTemperatureC;
  const tInit = new Float64Array(model.n_axial * model.n_radial).fill(start);
  const { result } = runSectionCore(model, mesh, pulse, tInit, coolDownS, snapshots);
  return result;
}

/** Repeated identical events to cyclic convergence (semantics match
 * `simulateEventTrain` in `./thermalFdm.ts`).
 *
 * Each event is a braking pulse followed by `gapS` of cooling; the per-event
 * histories are stitched into one continuous whole-train trace, and
 * `captureAnimation` keeps every event's field snapshots so the heat spread
 * can be animated over the full train.
 */
export function simulateSectionEventTrain(
  model: SectionFdmModel,
  pulse: HeatPulse,
  gapS: number,
  maxEvents = 60,
  convergenceTolC = 2.0,
  relativeTol = 0.01,
  consecutiveRequired = 3,
  snapshots = 25,
  captureAnimation = true,
): SectionEventTrainResult {
  if (gapS < 0.0) throw new Error("gap_s must be >= 0");
  const mesh = buildSectionMesh(model);
  const tInf = model.cooling.ambient_temperature_c;
  let field = new Float64Array(model.n_axial * model.n_radial).fill(tInf);

  const peaksSurface: number[] = [];
  const peaksBulk: number[] = [];
  let consecutive = 0;
  let converged = false;
  let lastResult: SectionThermalResult | null = null;
  let totalIn = 0.0;
  let totalConv = 0.0;
  let totalRad = 0.0;

  const eventPeriodS = pulse.duration_s + gapS;
  const trainTimes: number[][] = [];
  const trainPeak: number[][] = [];
  const trainBulk: number[][] = [];
  const snapTimesList: number[][] = [];
  const snapFieldsList: FieldSnapshot[][] = [];

  for (let eventIdx = 1; eventIdx <= maxEvents; eventIdx++) {
    const { result, field: nextField } = runSectionCore(model, mesh, pulse, field, gapS, snapshots);
    field = nextField;
    lastResult = result;
    peaksSurface.push(result.peak_surface_temperature_c);
    peaksBulk.push(arrMax(result.bulk_average_history_c));
    totalIn += result.energy_in_j;
    totalConv += result.convective_energy_j;
    totalRad += result.radiative_energy_j;

    const offset = (peaksSurface.length - 1) * eventPeriodS;
    const first = trainTimes.length > 0 ? 1 : 0; // skip the repeated joint sample
    trainTimes.push(result.surface_history_times_s.slice(first).map((t) => t + offset));
    trainPeak.push(result.peak_surface_history_c.slice(first));
    trainBulk.push(result.bulk_average_history_c.slice(first));
    if (captureAnimation) {
      const snapFirst = snapTimesList.length > 0 ? 1 : 0;
      snapTimesList.push(result.snapshot_times_s.slice(snapFirst).map((t) => t + offset));
      snapFieldsList.push(result.temperature_c.slice(snapFirst));
    }

    if (peaksSurface.length >= 2) {
      const diff = Math.abs(peaksSurface[peaksSurface.length - 1]! - peaksSurface[peaksSurface.length - 2]!);
      const rel = diff / Math.max(peaksSurface[peaksSurface.length - 1]! - tInf, 1e-9);
      if (diff < convergenceTolC && rel < relativeTol) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }
      if (consecutive >= consecutiveRequired) {
        converged = true;
        break;
      }
    }
  }

  if (lastResult === null) throw new Error("max_events must be >= 1");
  const cyclicPeak = peaksSurface[peaksSurface.length - 1]!;
  return {
    converged,
    events_run: peaksSurface.length,
    peak_surface_temperatures_c: peaksSurface,
    peak_bulk_temperatures_c: peaksBulk,
    cyclic_peak_surface_c: cyclicPeak,
    surface_minus_bulk_at_peak_c: cyclicPeak - peaksBulk[peaksBulk.length - 1]!,
    final_field: lastResult,
    limit_exceeded: cyclicPeak > model.cooling.allowable_rotor_temperature_c,
    total_energy_in_j: totalIn,
    total_convective_energy_j: totalConv,
    total_radiative_energy_j: totalRad,
    train_times_s: trainTimes.flat(),
    train_peak_surface_c: trainPeak.flat(),
    train_bulk_average_c: trainBulk.flat(),
    train_snapshot_times_s: snapFieldsList.length ? snapTimesList.flat() : null,
    train_snapshots_c: snapFieldsList.length ? snapFieldsList.flat() : null,
  };
}

/** Steady-state field with the pad-contact cells HELD at a set temperature.
 *
 * Same idea as `solveSteadyBandTemperature` in `./thermalFdm.ts` but on the
 * arbitrary cross-section: the friction-face cells inside the swept band are
 * clamped (Dirichlet), the rest of the section conducts and cools until the
 * field stops changing. Energy-accounting result fields are zeroed
 * (meaningless for a prescribed-temperature boundary).
 */
export function solveSectionSteadyBandTemperature(
  model: SectionFdmModel,
  bandTemperatureC: number,
  toleranceC = 0.1,
  maxTimeS = 600.0,
): SectionThermalResult {
  const mesh = buildSectionMesh(model);
  const cooling = model.cooling;
  const h = cooling.convection_coefficient_w_m2k;
  const eps = cooling.emissivity;
  const tInf = cooling.ambient_temperature_c;
  const tInfK4 = (tInf + ZERO_CELSIUS_K) ** 4;
  const sigma = STEFAN_BOLTZMANN;

  const dt = stableTimeStepS(mesh.material, mesh.dr, mesh.dz);
  const nSteps = Math.max(2, Math.ceil(maxTimeS / dt));
  const checkEvery = Math.max(1, npRound(1.0 / dt));

  const nR = mesh.nR;
  const nZ = mesh.nZ;
  const nCells = nZ * nR;
  const mask = mesh.mask;

  const field = new Float64Array(nCells).fill(tInf);
  for (let idx = 0; idx < nCells; idx++) if (mesh.fluxMask[idx]) field[idx] = bandTemperatureC;

  const capacity = mesh.capacity;
  const totalCapacity = sumAll(capacity);

  const snapFields: FieldSnapshot[] = [maskedSnapshot(field, mask, nZ, nR)];
  const snapTimes: number[] = [0.0];
  const histTimes: number[] = [0.0];
  const histPeak: number[] = [bandTemperatureC];
  const histBulk: number[] = [weightedSum(capacity, field) / totalCapacity];
  const recordEvery = Math.max(1, Math.floor(nSteps / 1500));
  let reference = field.slice();
  let finalStep = nSteps;

  const heat = new Float64Array(nCells);

  for (let step = 1; step <= nSteps; step++) {
    heat.fill(0.0);

    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[j * nR + i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[j * nR + i] += qz;
      }
    }
    for (let j = 0; j < nZ - 1; j++) {
      for (let i = 0; i < nR; i++) {
        const qz = mesh.gAxial[j * nR + i]! * (field[(j + 1) * nR + i]! - field[j * nR + i]!);
        heat[(j + 1) * nR + i] -= qz;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk] += qr;
      }
    }
    for (let j = 0; j < nZ; j++) {
      for (let kk = 0; kk < nR - 1; kk++) {
        const qr = mesh.gRadial[j * (nR - 1) + kk]! * (field[j * nR + kk + 1]! - field[j * nR + kk]!);
        heat[j * nR + kk + 1] -= qr;
      }
    }

    for (let idx = 0; idx < nCells; idx++) {
      const t = field[idx]!;
      const loss =
        h * mesh.aCool[idx]! * (t - tInf) + eps * sigma * mesh.aCool[idx]! * ((t + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[idx] -= loss;
    }

    for (let idx = 0; idx < nCells; idx++) {
      if (mask[idx]) field[idx] += dt * (heat[idx]! / capacity[idx]!);
    }
    for (let idx = 0; idx < nCells; idx++) {
      if (mesh.fluxMask[idx]) field[idx] = bandTemperatureC; // Dirichlet clamp
    }

    if (step % recordEvery === 0) {
      histTimes.push(step * dt);
      histPeak.push(fluxMax(field, mesh.fluxMask));
      histBulk.push(weightedSum(capacity, field) / totalCapacity);
    }
    if (step % checkEvery === 0) {
      let maxDiff = 0.0;
      for (let idx = 0; idx < nCells; idx++) {
        if (!mask[idx]) continue;
        const d = Math.abs(field[idx]! - reference[idx]!);
        if (d > maxDiff) maxDiff = d;
      }
      if (maxDiff < toleranceC) {
        finalStep = step;
        break;
      }
      reference = field.slice();
    }
  }

  snapFields.push(maskedSnapshot(field, mask, nZ, nR));
  snapTimes.push(finalStep * dt);
  histTimes.push(finalStep * dt);
  histPeak.push(fluxMax(field, mesh.fluxMask));
  histBulk.push(weightedSum(capacity, field) / totalCapacity);

  return {
    r_m: Array.from(mesh.r),
    z_m: Array.from(mesh.z),
    active_mask: maskToSnapshot(mask, nZ, nR),
    snapshot_times_s: snapTimes,
    temperature_c: snapFields,
    surface_history_times_s: histTimes,
    peak_surface_history_c: histPeak,
    bulk_average_history_c: histBulk,
    peak_surface_temperature_c: fluxMax(field, mesh.fluxMask),
    peak_surface_time_s: finalStep * dt,
    lumped_delta_t_c: 0.0,
    analytic_surface_rise_c: 0.0,
    dt_s: dt,
    energy_balance_error_fraction: 0.0,
    section_mass_kg: mesh.sectionMass,
    flux_area_m2: mesh.fluxAreaTotal,
    swept_r_bounds_m: mesh.bandBounds,
    energy_in_j: 0.0,
    stored_energy_j: 0.0,
    convective_energy_j: 0.0,
    radiative_energy_j: 0.0,
    energy_in_history_j: null,
    convective_energy_history_j: null,
    radiative_energy_history_j: null,
  };
}

/** Convenience: the constant-thickness annulus as a section polygon. */
export function rectangularSection(
  outerDiameterMm: number,
  innerDiameterMm: number,
  thicknessMm: number,
  material: RotorMaterial,
  holeBands: ReadonlyArray<HoleBand> = [],
): RotorSection {
  const rO = outerDiameterMm / 2.0;
  const rI = innerDiameterMm / 2.0;
  const halfT = thicknessMm / 2.0;
  return makeRotorSection(
    [
      [rI, -halfT],
      [rO, -halfT],
      [rO, halfT],
      [rI, halfT],
    ],
    material,
    holeBands,
  );
}
