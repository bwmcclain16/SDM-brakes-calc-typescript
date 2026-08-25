/** In-plane (x, y) rotor face thermal model -- resolves hot spots (spec 21).
 *
 * The axisymmetric models smear holes/slots around the circumference, so they
 * cannot show azimuthal hot spots. This model instead treats the rotor as a THIN
 * PLATE in the face plane: the true 2D geometry from the CAD plan view (outer
 * circle, real inner mounting contour, every hole and slot as an actual void)
 * is rasterized onto an (x, y) grid and transient conduction is solved in-plane.
 *
 * Physics and assumptions (loud-assumptions convention):
 *
 * - **Thin plate**: temperature is uniform through the (few-mm) thickness.
 *   Justified by the tiny through-thickness Biot number and symmetric two-face
 *   heating; the (r, z) models cover through-thickness gradients instead.
 * - **Pad heat smeared in time, not in space**: the pad passes every point of
 *   the swept band once per revolution (fast vs. conduction), so friction power
 *   deposits uniformly per unit *contact* area -- but voids carry none, so the
 *   remaining ligaments run higher flux and conduction constriction between
 *   features produces genuine hot spots.
 * - Cooling: convection + radiation on both faces of every active cell, plus
 *   the walls of holes/slots and the rim/inner edges (cell-face area x
 *   thickness for every exposed cell side).
 * - Voxel boundaries: features are stair-stepped at the grid pitch; refine
 *   `n_pixels` for small ligaments.
 *
 * Numerical fields are flat `Float64Array`s (`index = row * n + col`, row = y
 * index, col = x index -- matching numpy's `meshgrid(axis, axis)` default
 * `xy` indexing, `xx[row,col]=axis[col]`, `yy[row,col]=axis[row]`) rather than
 * nested arrays. `heat` is preallocated once and reused every step, mirroring
 * `../solvers/thermalFdm.ts`'s pattern: `heat` is rebuilt from the OLD field
 * before `field` is mutated in place, so a single persistent buffer suffices.
 *
 * `SweptBand` duplication note: the section solver (`thermalFdmSection.ts`,
 * ported in parallel by another agent) defines its own `SweptBand`. This file
 * defines an identical-shaped local copy rather than importing across that
 * boundary -- see the assignment note. Reconcile into one shared type once
 * both land.
 */
import { STEFAN_BOLTZMANN, ZERO_CELSIUS_K } from "../constants.ts";
import { NeedsInputError } from "../errors.ts";
import type { CoolingParameters } from "../models/internal.ts";
import type { RotorMaterial } from "../models/rotors.ts";
import type { FieldSnapshot, HeatPulse } from "./thermalFdm.ts";
// SweptBand lives with the section model in Python too (thermal_face_plane.py
// imports it from thermal_fdm_section); keep that ownership here.
import { type SweptBand, makeSweptBand } from "./thermalFdmSection.ts";
export { type SweptBand, makeSweptBand };
import { heatPulsePowerW } from "./thermalFdm.ts";

export type Point = readonly [number, number];

// --- geometry --------------------------------------------------------------

/** True rotor face geometry (mm), typically from a plan-view DXF. */
export interface RotorFaceGeometry {
  outer_diameter_mm: number;
  inner_diameter_mm: number;
  thickness_mm: number;
  material: RotorMaterial;
  inner_boundary_mm?: readonly Point[] | null; // real contour beats the circle
  hole_centers_mm?: readonly (readonly [number, number, number])[];
  slot_loops_mm?: readonly (readonly Point[])[];
}

export function makeRotorFaceGeometry(
  outerDiameterMm: number,
  innerDiameterMm: number,
  thicknessMm: number,
  material: RotorMaterial,
  innerBoundaryMm: readonly Point[] | null = null,
  holeCentersMm: readonly (readonly [number, number, number])[] = [],
  slotLoopsMm: readonly (readonly Point[])[] = [],
): RotorFaceGeometry {
  if (outerDiameterMm <= 0.0 || thicknessMm <= 0.0) {
    throw new Error("outer diameter and thickness must be positive");
  }
  if (!(innerDiameterMm > 0.0 && innerDiameterMm < outerDiameterMm)) {
    throw new Error("inner diameter must be positive and inside the OD");
  }
  return {
    outer_diameter_mm: outerDiameterMm,
    inner_diameter_mm: innerDiameterMm,
    thickness_mm: thicknessMm,
    material,
    inner_boundary_mm: innerBoundaryMm,
    hole_centers_mm: holeCentersMm,
    slot_loops_mm: slotLoopsMm,
  };
}


export interface FacePlateModel {
  geometry: RotorFaceGeometry;
  cooling: CoolingParameters;
  swept_band: SweptBand;
  rotor_heat_fraction: number | null;
  n_pixels: number;
}

export function makeFacePlateModel(
  geometry: RotorFaceGeometry,
  cooling: CoolingParameters,
  sweptBand: SweptBand,
  rotorHeatFraction: number | null = null,
  nPixels = 241,
): FacePlateModel {
  if (!(nPixels >= 61 && nPixels <= 601)) {
    throw new Error("n_pixels must be in [61, 601]");
  }
  const model: FacePlateModel = {
    geometry,
    cooling,
    swept_band: sweptBand,
    rotor_heat_fraction: rotorHeatFraction,
    n_pixels: nPixels,
  };
  const frac = facePlateHeatFraction(model);
  if (!(frac > 0.0 && frac <= 1.0)) {
    throw new Error("rotor_heat_fraction must be in (0, 1]");
  }
  return model;
}

export function facePlateHeatFraction(model: FacePlateModel): number {
  if (model.rotor_heat_fraction !== null && model.rotor_heat_fraction !== undefined) {
    return model.rotor_heat_fraction;
  }
  return model.cooling.rotor_heat_fraction ?? 1.0;
}

// --- results -----------------------------------------------------------------

export interface FaceFieldResult {
  x_m: number[]; // (n,) cell centers, both axes identical
  y_m: number[];
  active_mask: FieldSnapshot; // (n, n) 0/1
  band_mask: FieldSnapshot; // active cells inside the swept band
  snapshot_times_s: number[];
  temperature_c: FieldSnapshot[]; // (n_snap,) each (n, n), NaN outside
  history_times_s: number[];
  peak_band_history_c: number[];
  bulk_average_history_c: number[];
  peak_temperature_c: number;
  peak_time_s: number;
  peak_location_mm: [number, number];
  hot_spot_delta_c: number; // peak minus same-radius azimuthal mean
  radial_bins_m: number[];
  radial_max_c: number[]; // azimuthal max/mean/min at peak snapshot
  radial_mean_c: number[];
  radial_min_c: number[];
  lumped_delta_t_c: number;
  energy_balance_error_fraction: number;
  section_mass_kg: number;
  contact_area_m2: number;
  dt_s: number;
  // Energy accounting (J); histories share history_times_s.
  energy_in_j: number;
  stored_energy_j: number;
  convective_energy_j: number;
  radiative_energy_j: number;
  energy_in_history_j: number[];
  convective_energy_history_j: number[];
  radiative_energy_history_j: number[];
}

/** Repeated stops on the FULL face geometry.
 *
 * The axisymmetric event trains smear cooling features around the disc, so
 * they cannot answer "does the ligament between these two slots keep getting
 * hotter every lap?". This does: every hole, slot and the real inner contour
 * stays a void for the whole run, so hot spots accumulate where the geometry
 * actually constricts conduction.
 */
export interface FaceEventTrainResult {
  converged: boolean;
  events_run: number;
  peak_temperatures_c: number[];
  peak_bulk_temperatures_c: number[];
  hot_spot_deltas_c: number[];
  cyclic_peak_c: number;
  cyclic_hot_spot_delta_c: number;
  final_field: FaceFieldResult;
  limit_exceeded: boolean;
  total_energy_in_j: number;
  total_convective_energy_j: number;
  total_radiative_energy_j: number;
  // Continuous history and animation frames across the whole run, matching
  // the axisymmetric trains (see thermalFdm.ts's FdmEventTrainResult).
  train_times_s: number[] | null;
  train_peak_surface_c: number[] | null;
  train_bulk_average_c: number[] | null;
  train_snapshot_times_s: number[] | null;
  train_snapshots_c: FieldSnapshot[] | null;
}

// --- small numpy-semantics helpers (duplicated from thermalFdm.ts -- those
// are module-private there, so this file carries its own copies rather than
// reaching past the module boundary). ----------------------------------------

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
function uniqueSorted(xs: number[]): number[] {
  const arr = xs.slice();
  arr.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of arr) {
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/** bisect.bisect_right / np.digitize(x, bins, right=False) for a single x
 * against a monotonically increasing `bins`: first index i such that
 * `bins[i-1] <= x < bins[i]`, i.e. count of bin edges <= x. */
function bisectRight(edges: Float64Array, x: number): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x < edges[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function arrMax(arr: number[]): number {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}

function requireMaterial(material: RotorMaterial): { k: number; rho: number; cp: number } {
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

/** Even-odd ray-casting point-in-polygon, matching matplotlib's
 * `Path.contains_points` for a simple (non-self-intersecting) closed loop --
 * the only shape these DXF-derived contours ever are. Not exercised by any
 * recorded fixture scenario (none use `inner_boundary_mm` / `slot_loops_mm`),
 * so this is a faithful-by-construction port, unverified against Python. */
/** Even-odd ray casting, standing in for matplotlib's `Path.contains_points`.
 *
 * Verified against Python on real slot/contour geometry (see the
 * face_slots_and_inner_contour fixture: 6 slots + a 120-point lobed inner
 * contour, all matching cell for cell).
 *
 * KNOWN DIVERGENCE, on points lying EXACTLY on a polygon edge: matplotlib
 * reports outside where this reports inside. Measured on a grid-aligned slot
 * (corner at angle 0 with a mesh line through y=0): 2 cells of 6561 flip,
 * moving section mass by 0.05% and peak temperature by ~0.04%. Matching it
 * would mean replicating an undocumented Agg implementation detail, and the
 * tie is arbitrary in both libraries. Imported DXF coordinates landing exactly
 * on a mesh line is the only way to hit it.
 */
function pointInPolygon(x: number, y: number, poly: readonly Point[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]![0];
    const yi = poly[i]![1];
    const xj = poly[j]![0];
    const yj = poly[j]![1];
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- mesh --------------------------------------------------------------------

interface FaceMesh {
  n: number;
  axis: Float64Array; // (n,)
  dx: number;
  rr: Float64Array; // flat (n*n); idx = row*n + col
  k: number;
  rho: number;
  cp: number;
  thickness: number;
  mask: Uint8Array; // flat (n*n)
  bandMask: Uint8Array; // flat (n*n)
  capacityCell: number; // scalar: every cell has the same area
  gSide: number; // conductance per cell side
  faceArea: number; // both faces of the plate, one cell
  wallArea: Float64Array; // flat (n*n)
  contactArea: number;
  mass: number;
}

function buildFaceMesh(model: FacePlateModel): FaceMesh {
  const geom = model.geometry;
  const { k, rho, cp } = requireMaterial(geom.material);
  const rOuter = geom.outer_diameter_mm / 2000.0;
  const rInner = geom.inner_diameter_mm / 2000.0;
  const thickness = geom.thickness_mm / 1000.0;

  const n = model.n_pixels;
  const axis = linspace(-rOuter, rOuter, n);
  const dx = axis[1]! - axis[0]!;
  const nn = n * n;

  // xx[row,col] = axis[col] (x), yy[row,col] = axis[row] (y) -- numpy
  // meshgrid(axis, axis) default 'xy' indexing.
  //
  // Deliberately `sqrt(x*x + y*y)`, NOT `Math.hypot(x, y)`: verified against
  // the actual Python run that for this grid's magnitude range (~0.09 m, no
  // overflow/underflow risk) `np.hypot` is bit-for-bit IDENTICAL to the naive
  // formula, while V8's `Math.hypot` disagrees by 1 ULP on boundary cells
  // (e.g. n_pixels=81, OD 183mm: the (row=8, col=64) cell sits exactly on a
  // 3-4-5 Pythagorean-triple radius equal to r_outer). That 1 ULP flips
  // `rr <= r_outer` and changes which cells are active, which then cascades
  // through the whole solve -- see the module's final report for detail.
  const rr = new Float64Array(nn);
  for (let row = 0; row < n; row++) {
    const y = axis[row]!;
    for (let col = 0; col < n; col++) {
      const x = axis[col]!;
      rr[row * n + col] = Math.sqrt(x * x + y * y);
    }
  }

  const mask = new Uint8Array(nn);
  for (let idx = 0; idx < nn; idx++) mask[idx] = rr[idx]! <= rOuter ? 1 : 0;

  const innerBoundary = geom.inner_boundary_mm;
  if (innerBoundary && innerBoundary.length >= 3) {
    const poly: Point[] = innerBoundary.map((p) => [p[0] / 1000.0, p[1] / 1000.0] as Point);
    for (let row = 0; row < n; row++) {
      const y = axis[row]!;
      for (let col = 0; col < n; col++) {
        const idx = row * n + col;
        if (!mask[idx]) continue; // AND with false stays false
        const x = axis[col]!;
        if (pointInPolygon(x, y, poly)) mask[idx] = 0;
      }
    }
  } else {
    for (let idx = 0; idx < nn; idx++) {
      if (mask[idx] && !(rr[idx]! >= rInner)) mask[idx] = 0;
    }
  }

  for (const hole of geom.hole_centers_mm ?? []) {
    const hx = hole[0] / 1000.0;
    const hy = hole[1] / 1000.0;
    const hr = hole[2] / 1000.0;
    const hr2 = hr * hr;
    for (let row = 0; row < n; row++) {
      const y = axis[row]!;
      const dy = y - hy;
      for (let col = 0; col < n; col++) {
        const idx = row * n + col;
        if (!mask[idx]) continue;
        const x = axis[col]!;
        const dxh = x - hx;
        if (!(dxh * dxh + dy * dy > hr2)) mask[idx] = 0;
      }
    }
  }

  for (const loop of geom.slot_loops_mm ?? []) {
    if (loop.length < 3) continue;
    const poly: Point[] = loop.map((p) => [p[0] / 1000.0, p[1] / 1000.0] as Point);
    for (let row = 0; row < n; row++) {
      const y = axis[row]!;
      for (let col = 0; col < n; col++) {
        const idx = row * n + col;
        if (!mask[idx]) continue;
        const x = axis[col]!;
        if (pointInPolygon(x, y, poly)) mask[idx] = 0;
      }
    }
  }

  let anyActive = false;
  for (let idx = 0; idx < nn; idx++) if (mask[idx]) { anyActive = true; break; }
  if (!anyActive) throw new Error("no active cells — check the face geometry inputs");

  const bandHi = rOuter - model.swept_band.outer_offset_mm / 1000.0;
  const bandLo = bandHi - model.swept_band.depth_mm / 1000.0;
  const bandMask = new Uint8Array(nn);
  for (let idx = 0; idx < nn; idx++) {
    bandMask[idx] = mask[idx] && rr[idx]! >= bandLo && rr[idx]! <= bandHi ? 1 : 0;
  }
  let anyBand = false;
  for (let idx = 0; idx < nn; idx++) if (bandMask[idx]) { anyBand = true; break; }
  if (!anyBand) throw new Error("swept band does not intersect the rotor face geometry");

  // Exposed side count per active cell (feature walls, rim, inner edge).
  const exposedSides = new Float64Array(nn);
  // exposed_sides[:, :-1] += mask[:, :-1] & ~mask[:, 1:]
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n - 1; col++) {
      const idx = row * n + col;
      if (mask[idx] && !mask[idx + 1]) exposedSides[idx]! += 1;
    }
  }
  // exposed_sides[:, 1:] += mask[:, 1:] & ~mask[:, :-1]
  for (let row = 0; row < n; row++) {
    for (let col = 1; col < n; col++) {
      const idx = row * n + col;
      if (mask[idx] && !mask[idx - 1]) exposedSides[idx]! += 1;
    }
  }
  // exposed_sides[:-1, :] += mask[:-1, :] & ~mask[1:, :]
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      if (mask[idx] && !mask[idx + n]) exposedSides[idx]! += 1;
    }
  }
  // exposed_sides[1:, :] += mask[1:, :] & ~mask[:-1, :]
  for (let row = 1; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      if (mask[idx] && !mask[idx - n]) exposedSides[idx]! += 1;
    }
  }
  // exposed_sides[:, 0] += mask[:, 0]
  for (let row = 0; row < n; row++) {
    const idx = row * n;
    if (mask[idx]) exposedSides[idx]! += 1;
  }
  // exposed_sides[:, -1] += mask[:, -1]
  for (let row = 0; row < n; row++) {
    const idx = row * n + (n - 1);
    if (mask[idx]) exposedSides[idx]! += 1;
  }
  // exposed_sides[0, :] += mask[0, :]
  for (let col = 0; col < n; col++) {
    if (mask[col]) exposedSides[col]! += 1;
  }
  // exposed_sides[-1, :] += mask[-1, :]
  for (let col = 0; col < n; col++) {
    const idx = (n - 1) * n + col;
    if (mask[idx]) exposedSides[idx]! += 1;
  }

  const cellArea = dx * dx;
  const wallArea = new Float64Array(nn);
  for (let idx = 0; idx < nn; idx++) wallArea[idx] = exposedSides[idx]! * dx * thickness;

  let maskCount = 0;
  let bandCount = 0;
  for (let idx = 0; idx < nn; idx++) {
    if (mask[idx]) maskCount++;
    if (bandMask[idx]) bandCount++;
  }

  return {
    n,
    axis,
    dx,
    rr,
    k,
    rho,
    cp,
    thickness,
    mask,
    bandMask,
    capacityCell: rho * cp * cellArea * thickness,
    gSide: k * thickness,
    faceArea: 2.0 * cellArea,
    wallArea,
    contactArea: bandCount * cellArea,
    mass: maskCount * cellArea * thickness * rho,
  };
}

// --- core time stepping -------------------------------------------------------

function maskedSnapshot(f: Float64Array, mask: Uint8Array, n: number): FieldSnapshot {
  const nn = n * n;
  const data = new Float64Array(nn);
  for (let idx = 0; idx < nn; idx++) data[idx] = mask[idx] ? f[idx]! : NaN;
  return { nAxial: n, nRadial: n, data };
}

function bandMaxOf(f: Float64Array, band: Uint8Array): number {
  let m = -Infinity;
  for (let idx = 0; idx < f.length; idx++) {
    if (band[idx] && f[idx]! > m) m = f[idx]!;
  }
  return m;
}

function maskMeanOf(f: Float64Array, mask: Uint8Array): number {
  let s = 0.0;
  let c = 0;
  for (let idx = 0; idx < f.length; idx++) {
    if (mask[idx]) {
      s += f[idx]!;
      c++;
    }
  }
  return s / c;
}

function maskSumOf(f: Float64Array, mask: Uint8Array): number {
  let s = 0.0;
  for (let idx = 0; idx < f.length; idx++) if (mask[idx]) s += f[idx]!;
  return s;
}

interface RunOutput {
  result: FaceFieldResult;
  field: Float64Array<ArrayBuffer>;
}

/** One event on a prebuilt mesh from a given start field.
 *
 * Split out of `simulateFaceSingleStop` so an event train can carry the field
 * from one stop into the next without rebuilding the geometry.
 */
function runFace(
  model: FacePlateModel,
  mesh: FaceMesh,
  pulse: HeatPulse,
  initialField: Float64Array,
  coolDownS = 0.0,
  snapshotsIn = 25,
): RunOutput {
  const cooling = model.cooling;
  const frac = facePlateHeatFraction(model);
  const h = cooling.convection_coefficient_w_m2k;
  const eps = cooling.emissivity;
  const tInf = cooling.ambient_temperature_c;
  const tInfK4 = (tInf + ZERO_CELSIUS_K) ** 4;
  const sigma = STEFAN_BOLTZMANN;

  const n = mesh.n;
  const nn = n * n;
  const mask = mesh.mask;
  const band = mesh.bandMask;
  const alpha = mesh.k / (mesh.rho * mesh.cp);
  let dt = (0.4 * mesh.dx ** 2) / (4.0 * alpha);
  const totalTime = pulse.duration_s + coolDownS;
  const nSteps = Math.max(1, Math.ceil(totalTime / dt));
  dt = totalTime / nSteps;

  const field = initialField.slice();
  for (let idx = 0; idx < nn; idx++) if (!mask[idx]) field[idx] = tInf; // voids track ambient; they carry no capacity

  const capacity = mesh.capacityCell;
  const g = mesh.gSide;

  // both_x[row,col] = mask[row,col] & mask[row,col+1], shape (n, n-1)
  const bothX = new Uint8Array(n * (n - 1));
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n - 1; col++) {
      const idxL = row * n + col;
      bothX[row * (n - 1) + col] = mask[idxL] && mask[idxL + 1] ? 1 : 0;
    }
  }
  // both_y[row,col] = mask[row,col] & mask[row+1,col], shape (n-1, n)
  const bothY = new Uint8Array((n - 1) * n);
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n; col++) {
      const idxT = row * n + col;
      bothY[row * n + col] = mask[idxT] && mask[idxT + n] ? 1 : 0;
    }
  }

  const coolArea = new Float64Array(nn);
  for (let idx = 0; idx < nn; idx++) coolArea[idx] = mesh.faceArea * mask[idx]! + mesh.wallArea[idx]!;

  const snapshots = Math.max(2, snapshotsIn);
  const snapStepsArr: number[] = [];
  for (const v of linspace(0, nSteps, snapshots)) snapStepsArr.push(npRound(v));
  const snapSteps = new Set<number>(uniqueSorted(snapStepsArr));
  const recordEvery = Math.max(1, Math.floor(nSteps / 1500));

  const snapFields: FieldSnapshot[] = [maskedSnapshot(field, mask, n)];
  const snapTimes: number[] = [0.0];
  const histTimes: number[] = [0.0];
  const histPeak: number[] = [bandMaxOf(field, band)];
  const histBulk: number[] = [maskMeanOf(field, mask)];

  let peakC = histPeak[0]!;
  let peakT = 0.0;
  let energyIn = 0.0;
  let energyConv = 0.0;
  let energyRad = 0.0;
  const histIn: number[] = [0.0];
  const histConv: number[] = [0.0];
  const histRad: number[] = [0.0];
  const storedStart = maskSumOf(field, mask) * capacity;

  const qScale = frac / mesh.contactArea;

  let bandCount = 0;
  for (let idx = 0; idx < nn; idx++) if (band[idx]) bandCount++;

  const heat = new Float64Array(nn);

  for (let step = 1; step <= nSteps; step++) {
    const tMid = (step - 0.5) * dt;
    heat.fill(0.0);

    // qx = g * (field[:, 1:] - field[:, :-1]) * both_x
    // heat[:, :-1] += qx
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n - 1; col++) {
        const idxL = row * n + col;
        const qx = bothX[row * (n - 1) + col] ? g * (field[idxL + 1]! - field[idxL]!) : 0.0;
        heat[idxL]! += qx;
      }
    }
    // heat[:, 1:] -= qx
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n - 1; col++) {
        const idxL = row * n + col;
        const qx = bothX[row * (n - 1) + col] ? g * (field[idxL + 1]! - field[idxL]!) : 0.0;
        heat[idxL + 1]! -= qx;
      }
    }
    // qy = g * (field[1:, :] - field[:-1, :]) * both_y
    // heat[:-1, :] += qy
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n; col++) {
        const idxT = row * n + col;
        const qy = bothY[row * n + col] ? g * (field[idxT + n]! - field[idxT]!) : 0.0;
        heat[idxT]! += qy;
      }
    }
    // heat[1:, :] -= qy
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n; col++) {
        const idxT = row * n + col;
        const qy = bothY[row * n + col] ? g * (field[idxT + n]! - field[idxT]!) : 0.0;
        heat[idxT + n]! -= qy;
      }
    }

    const qFlux = qScale * heatPulsePowerW(pulse, tMid) * mesh.dx ** 2;
    for (let idx = 0; idx < nn; idx++) if (band[idx]) heat[idx]! += qFlux;
    energyIn += qFlux * bandCount * dt;

    // Separate conv/rad terms so the joule-level dissipation split is reported.
    let sumConv = 0.0;
    let sumRad = 0.0;
    for (let idx = 0; idx < nn; idx++) {
      const conv = h * coolArea[idx]! * (field[idx]! - tInf);
      const rad = eps * sigma * coolArea[idx]! * ((field[idx]! + ZERO_CELSIUS_K) ** 4 - tInfK4);
      heat[idx]! -= conv + rad;
      if (mask[idx]) {
        sumConv += conv;
        sumRad += rad;
      }
    }
    energyConv += sumConv * dt;
    energyRad += sumRad * dt;

    for (let idx = 0; idx < nn; idx++) {
      if (mask[idx]) field[idx]! += (dt * heat[idx]!) / capacity;
    }

    const bandPeakNow = bandMaxOf(field, band);
    if (bandPeakNow > peakC) {
      peakC = bandPeakNow;
      peakT = step * dt;
    }
    if (step % recordEvery === 0 || step === nSteps) {
      histTimes.push(step * dt);
      histPeak.push(bandPeakNow);
      histBulk.push(maskMeanOf(field, mask));
      histIn.push(energyIn);
      histConv.push(energyConv);
      histRad.push(energyRad);
    }
    if (snapSteps.has(step)) {
      snapFields.push(maskedSnapshot(field, mask, n));
      snapTimes.push(step * dt);
    }
  }

  const stored = maskSumOf(field, mask) * capacity - storedStart;
  const energyLoss = energyConv + energyRad;
  const denom = Math.max(energyIn, 1e-9);
  const balanceError = (stored + energyLoss - energyIn) / denom;

  // Hot-spot statistics from the snapshot nearest the peak time.
  let peakSnapIndex = 0;
  let bestDiff = Math.abs(snapTimes[0]! - peakT);
  for (let kk = 1; kk < snapTimes.length; kk++) {
    const diff = Math.abs(snapTimes[kk]! - peakT);
    if (diff < bestDiff) {
      bestDiff = diff;
      peakSnapIndex = kk;
    }
  }
  const peakField = snapFields[peakSnapIndex]!.data;

  let flatIndex = -1;
  let bestVal = -Infinity;
  for (let idx = 0; idx < nn; idx++) {
    if (!band[idx]) continue; // np.where(band, peak_field, nan) -- non-band -> NaN, skipped
    const v = peakField[idx]!;
    if (v > bestVal) {
      bestVal = v;
      flatIndex = idx;
    }
  }
  const iy = Math.floor(flatIndex / n);
  const ix = flatIndex % n;
  const peakXyMm: [number, number] = [mesh.axis[ix]! * 1000.0, mesh.axis[iy]! * 1000.0];
  const peakRadius = mesh.rr[iy * n + ix]!;

  const ringTol = 2.0 * mesh.dx;
  let ringSum = 0.0;
  let ringCount = 0;
  for (let idx = 0; idx < nn; idx++) {
    if (mask[idx] && Math.abs(mesh.rr[idx]! - peakRadius) <= ringTol) {
      ringSum += peakField[idx]!;
      ringCount++;
    }
  }
  const ringMean = ringCount > 0 ? ringSum / ringCount : peakC;

  let bandMaxVal = -Infinity;
  for (let idx = 0; idx < nn; idx++) if (band[idx] && peakField[idx]! > bandMaxVal) bandMaxVal = peakField[idx]!;
  const hotSpotDelta = bandMaxVal - ringMean;

  // Azimuthal max/mean/min vs radius at the peak snapshot.
  const rrActive: number[] = [];
  const tActive: number[] = [];
  let rrMin = Infinity;
  let rrMax = -Infinity;
  for (let idx = 0; idx < nn; idx++) {
    if (mask[idx]) {
      const r = mesh.rr[idx]!;
      rrActive.push(r);
      tActive.push(peakField[idx]!);
      if (r < rrMin) rrMin = r;
      if (r > rrMax) rrMax = r;
    }
  }
  const nBins = 40;
  const binEdges = linspace(rrMin, rrMax, nBins + 1);
  const binCenters = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) binCenters[b] = 0.5 * (binEdges[b]! + binEdges[b + 1]!);

  const radialMax = new Float64Array(nBins).fill(NaN);
  const radialMean = new Float64Array(nBins).fill(NaN);
  const radialMin = new Float64Array(nBins).fill(NaN);
  const bucketSum = new Float64Array(nBins);
  const bucketCount = new Int32Array(nBins);
  const bucketMax = new Float64Array(nBins).fill(-Infinity);
  const bucketMin = new Float64Array(nBins).fill(Infinity);
  for (let idx = 0; idx < rrActive.length; idx++) {
    // np.digitize(rr_active, bin_edges) - 1; a value exactly at rr_active.max()
    // lands one bin PAST the last valid index (which == n_bins) and is
    // dropped by Python's `for b in range(n_bins)` -- reproduced here by the
    // same upper-bound skip, not clamped into the last bin.
    const which = bisectRight(binEdges, rrActive[idx]!) - 1;
    if (which < 0 || which >= nBins) continue;
    const v = tActive[idx]!;
    bucketSum[which]! += v;
    bucketCount[which]!++;
    if (v > bucketMax[which]!) bucketMax[which] = v;
    if (v < bucketMin[which]!) bucketMin[which] = v;
  }
  for (let b = 0; b < nBins; b++) {
    if (bucketCount[b]! > 0) {
      radialMax[b] = bucketMax[b]!;
      radialMean[b] = bucketSum[b]! / bucketCount[b]!;
      radialMin[b] = bucketMin[b]!;
    }
  }

  const result: FaceFieldResult = {
    x_m: Array.from(mesh.axis),
    y_m: Array.from(mesh.axis),
    active_mask: { nAxial: n, nRadial: n, data: Float64Array.from(mask) },
    band_mask: { nAxial: n, nRadial: n, data: Float64Array.from(band) },
    snapshot_times_s: snapTimes,
    temperature_c: snapFields,
    history_times_s: histTimes,
    peak_band_history_c: histPeak,
    bulk_average_history_c: histBulk,
    peak_temperature_c: peakC,
    peak_time_s: peakT,
    peak_location_mm: peakXyMm,
    hot_spot_delta_c: hotSpotDelta,
    radial_bins_m: Array.from(binCenters),
    radial_max_c: Array.from(radialMax),
    radial_mean_c: Array.from(radialMean),
    radial_min_c: Array.from(radialMin),
    lumped_delta_t_c: (frac * pulse.energy_j) / Math.max(mesh.mass * mesh.cp, 1e-12),
    energy_balance_error_fraction: balanceError,
    section_mass_kg: mesh.mass,
    contact_area_m2: mesh.contactArea,
    dt_s: dt,
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

// --- public API ----------------------------------------------------------------

/** One braking event on the true face geometry (holes, slots, contour). */
export function simulateFaceSingleStop(
  model: FacePlateModel,
  pulse: HeatPulse,
  initialTemperatureC: number | null = null,
  coolDownS = 0.0,
  snapshots = 25,
): FaceFieldResult {
  const mesh = buildFaceMesh(model);
  const start =
    initialTemperatureC === null || initialTemperatureC === undefined
      ? model.cooling.ambient_temperature_c
      : initialTemperatureC;
  const initial = new Float64Array(mesh.n * mesh.n).fill(start);
  const { result } = runFace(model, mesh, pulse, initial, coolDownS, snapshots);
  return result;
}

/** Repeated stops on the true face geometry, to cyclic convergence.
 *
 * Convergence semantics match the axisymmetric trains. `snapshots` defaults
 * lower here than for the (r, z) models because each frame is a full n x n
 * face field, so frames cost far more memory.
 */
export function simulateFaceEventTrain(
  model: FacePlateModel,
  pulse: HeatPulse,
  gapS: number,
  maxEvents = 30,
  convergenceTolC = 2.0,
  relativeTol = 0.01,
  consecutiveRequired = 3,
  snapshots = 12,
  captureAnimation = true,
): FaceEventTrainResult {
  if (gapS < 0.0) throw new Error("gap_s must be >= 0");
  if (maxEvents < 1) throw new Error("max_events must be >= 1");
  const mesh = buildFaceMesh(model);
  const tInf = model.cooling.ambient_temperature_c;
  let field = new Float64Array(mesh.n * mesh.n).fill(tInf);

  const peaks: number[] = [];
  const bulks: number[] = [];
  const deltas: number[] = [];
  let consecutive = 0;
  let converged = false;
  let last: FaceFieldResult | null = null;
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
    const { result, field: nextField } = runFace(model, mesh, pulse, field, gapS, snapshots);
    field = nextField;
    last = result;
    peaks.push(result.peak_temperature_c);
    bulks.push(arrMax(result.bulk_average_history_c));
    deltas.push(result.hot_spot_delta_c);
    totalIn += result.energy_in_j;
    totalConv += result.convective_energy_j;
    totalRad += result.radiative_energy_j;

    const offset = (peaks.length - 1) * eventPeriodS;
    const first = trainTimes.length > 0 ? 1 : 0; // skip the repeated joint sample
    trainTimes.push(result.history_times_s.slice(first).map((t) => t + offset));
    trainPeak.push(result.peak_band_history_c.slice(first));
    trainBulk.push(result.bulk_average_history_c.slice(first));
    if (captureAnimation) {
      const snapFirst = snapTimesList.length > 0 ? 1 : 0;
      snapTimesList.push(result.snapshot_times_s.slice(snapFirst).map((t) => t + offset));
      snapFieldsList.push(result.temperature_c.slice(snapFirst));
    }

    if (peaks.length >= 2) {
      const diff = Math.abs(peaks[peaks.length - 1]! - peaks[peaks.length - 2]!);
      const rel = diff / Math.max(peaks[peaks.length - 1]! - tInf, 1e-9);
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

  if (last === null) throw new Error("max_events must be >= 1"); // maxEvents >= 1
  return {
    converged,
    events_run: peaks.length,
    peak_temperatures_c: peaks,
    peak_bulk_temperatures_c: bulks,
    hot_spot_deltas_c: deltas,
    cyclic_peak_c: peaks[peaks.length - 1]!,
    cyclic_hot_spot_delta_c: deltas[deltas.length - 1]!,
    final_field: last,
    limit_exceeded: peaks[peaks.length - 1]! > model.cooling.allowable_rotor_temperature_c,
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
