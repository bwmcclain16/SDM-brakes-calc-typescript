/** Deform an imported rotor drawing through the thermal displacement field (spec 21, 22.3).
 *
 * The free-disc expansion solver (`./thermalExpansion.ts`) returns a radial
 * displacement profile `u(r)`. Under the axisymmetric assumption every material
 * point at radius `r` moves to `r + u(r)` with no circumferential motion, so
 * any imported drawing -- face linework, cooling holes, slots, the inner
 * mounting contour, or an `(r, z)` cross-section -- deforms under the single
 * mapping
 *
 *     `p_grown = p * (1 + u(|p|) / |p|)`
 *
 * applied point by point. That is what makes the growth outline geometry-faithful
 * rather than a uniformly scaled copy: a cooling hole translates outward *and*
 * distorts by the local gradient, exactly as the displacement field says it does.
 * A uniform temperature rise is the degenerate case where the mapping collapses to
 * a similarity scaling by `1 + alpha*dT` -- the anchor the tests pin.
 *
 * Growth is small (tenths of a mm on a ~180 mm rotor), so displays exaggerate it.
 * `exaggeration` multiplies the *displacement*, never the coordinates, and is
 * carried on the result so an exaggerated outline can never be mistaken for a true
 * dimension.
 *
 * Coordinate conventions match the importers: face paths are `(x, y)` mm about
 * the rotation axis at the origin; cross-sections are `(r, z)` mm with the
 * rotation axis at `r = 0`.
 */

export type Point = [number, number];

/** A single point chain before it has been validated/cleaned. */
type RawPath = readonly (readonly number[])[];

//: Facets used when a detected hole (center + radius) is drawn as a polygon.
export const HOLE_FACETS = 25;

/** Base and thermally-grown copies of the same linework, both in mm.
 *
 * `outside_domain_fraction` is the share of points whose radius fell outside
 * the modeled span and were therefore clamped to the nearest modeled end --
 * drawings routinely carry linework inboard of the modeled metal (drive tabs,
 * hub features), and this says so rather than presenting extrapolated motion
 * as computed motion.
 */
export interface GrowthOverlay {
  base_paths_mm: Point[][];
  grown_paths_mm: Point[][];
  exaggeration: number;
  max_radial_growth_mm: number;
  outside_domain_fraction: number;
}

export function pointCount(overlay: GrowthOverlay): number {
  return overlay.base_paths_mm.reduce((sum, path) => sum + path.length, 0);
}

/** `u` in mm at query radii (mm), plus a mask of queries outside the domain.
 *
 * Radii outside the modeled span are clamped to the nearest modeled end
 * (`np.interp`'s edge behaviour); the mask lets callers report the clamping.
 */
export function radialGrowthMm(
  radiusMm: number[],
  rM: number[],
  uM: number[],
): [number[], boolean[]] {
  const n = rM.length;
  if (n < 2 || rM.length !== uM.length) {
    throw new Error("r_m and u_m must be matching 1D arrays with >= 2 points");
  }
  const rMm = new Array<number>(n);
  const uMm = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    rMm[i] = rM[i]! * 1000.0;
    uMm[i] = uM[i]! * 1000.0;
  }
  for (let i = 1; i < n; i++) {
    if (rMm[i]! - rMm[i - 1]! <= 0.0) {
      throw new Error("r_m must be strictly increasing");
    }
  }
  const growth = radiusMm.map((r) => npInterp(r, rMm, uMm));
  // Geometry that sits exactly ON a domain edge (an OD circle against a domain
  // ending at the OD) lands a few ULP either side of it, so an exact compare
  // would report a rotor's own outline as extrapolated. The tolerance is far
  // below any distinction a drawing can express and far above float noise.
  const tol = 1e-9 * Math.max(Math.abs(rMm[n - 1]!), 1.0);
  const outside = radiusMm.map((r) => r < rMm[0]! - tol || r > rMm[n - 1]! + tol);
  return [growth, outside];
}

function cleanPaths(paths: readonly RawPath[]): Point[][] {
  const cleaned: Point[][] = [];
  for (const path of paths) {
    if (path.length >= 2 && path.every((p) => p.length === 2)) {
      cleaned.push(path.map((p) => [p[0]!, p[1]!] as Point));
    }
  }
  return cleaned;
}

/** Map face-plane `(x, y)` linework through the axisymmetric displacement field.
 *
 * Every point moves radially outward by `exaggeration * u(|p|)`; points on
 * the rotation axis have no radial direction and stay put.
 */
export function deformFacePaths(
  pathsMm: readonly RawPath[],
  rM: number[],
  uM: number[],
  exaggeration = 1.0,
): GrowthOverlay {
  if (exaggeration <= 0.0) {
    throw new Error("exaggeration must be positive");
  }
  const base: Point[][] = [];
  const grown: Point[][] = [];
  let outsideCount = 0;
  let pointTotal = 0;
  let maxGrowth = 0.0;

  for (const pts of cleanPaths(pathsMm)) {
    // sqrt(x*x + y*y), NOT Math.hypot: V8's hypot uses a different
    // (overflow-safe) algorithm than numpy's and disagrees by 1 ULP on ~36% of a
    // typical rotor grid. Harmless for the growth value itself, but the
    // domain-edge test in radialGrowthMm compares this radius against the modeled
    // span, so a 1-ULP shift can flip outside_domain_fraction on geometry sitting
    // exactly on the OD. Python uses np.hypot, which matches the naive form here.
    const radius = pts.map(([x, y]) => Math.sqrt(x * x + y * y));
    const [growth, outside] = radialGrowthMm(radius, rM, uM);
    const grownPts: Point[] = pts.map((p, i) => {
      const r = radius[i]!;
      const onAxis = r <= 1e-9;
      const safeRadius = onAxis ? 1.0 : r;
      const factor = onAxis ? 1.0 : 1.0 + (exaggeration * growth[i]!) / safeRadius;
      return [p[0] * factor, p[1] * factor];
    });
    base.push(pts);
    grown.push(grownPts);

    let localMax = 0.0;
    for (const g of growth) {
      const a = Math.abs(g);
      if (a > localMax) localMax = a;
    }
    if (localMax > maxGrowth) maxGrowth = localMax;
    outsideCount += outside.reduce((n, o) => n + (o ? 1 : 0), 0);
    pointTotal += radius.length;
  }

  return {
    base_paths_mm: base,
    grown_paths_mm: grown,
    exaggeration,
    max_radial_growth_mm: maxGrowth,
    outside_domain_fraction: pointTotal ? outsideCount / pointTotal : 0.0,
  };
}

/** Map an `(r, z)` cross-section outline: radial `u(r)` plus optional `eps_z(r)`.
 *
 * A heated disc grows through its thickness as well as radially, so the plane-
 * stress through-thickness strain (see `axialStrainProfile` in
 * `./thermalExpansion.ts`) is applied about the section's own mid-plane.
 * Expanding about the mid-plane rather than `z = 0` keeps the result
 * independent of where the drawing put its axial datum. Passing
 * `axialStrain=null` shows radial growth only.
 */
export function deformSectionPolygon(
  pointsMm: readonly number[][],
  rM: number[],
  uM: number[],
  axialStrain: number[] | null = null,
  exaggeration = 1.0,
): GrowthOverlay {
  if (exaggeration <= 0.0) {
    throw new Error("exaggeration must be positive");
  }
  if (pointsMm.length < 3 || pointsMm.some((p) => p.length !== 2)) {
    throw new Error("section polygon needs at least 3 (r, z) points");
  }
  const n = pointsMm.length;
  const radius = pointsMm.map((p) => p[0]!);
  const zVals = pointsMm.map((p) => p[1]!);
  const [growth, outside] = radialGrowthMm(radius, rM, uM);

  const grownR = new Array<number>(n);
  for (let i = 0; i < n; i++) grownR[i] = radius[i]! + exaggeration * growth[i]!;
  let grownZ = zVals.slice();

  if (axialStrain !== null) {
    const rMm = rM.map((v) => v * 1000.0);
    if (axialStrain.length !== rMm.length) {
      throw new Error("axial_strain must match r_m");
    }
    const zMid = 0.5 * (Math.min(...zVals) + Math.max(...zVals));
    grownZ = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const epsZ = npInterp(radius[i]!, rMm, axialStrain);
      grownZ[i] = zMid + (zVals[i]! - zMid) * (1.0 + exaggeration * epsZ);
    }
  }

  const basePts: Point[] = pointsMm.map((p) => [p[0]!, p[1]!]);
  const grownPts: Point[] = grownR.map((r, i) => [r, grownZ[i]!]);

  let maxGrowth = 0.0;
  for (const g of growth) {
    const a = Math.abs(g);
    if (a > maxGrowth) maxGrowth = a;
  }
  const outsideCount = outside.reduce((n2, o) => n2 + (o ? 1 : 0), 0);

  return {
    base_paths_mm: [basePts],
    grown_paths_mm: [grownPts],
    exaggeration,
    max_radial_growth_mm: maxGrowth,
    outside_domain_fraction: outsideCount / radius.length,
  };
}

/** A closed circle as a point chain (for parametric geometry with no drawing). */
export function circlePathMm(
  diameterMm: number,
  centerMm: Point = [0.0, 0.0],
  facets = 181,
): Point[] {
  if (diameterMm <= 0.0) {
    throw new Error("diameter must be positive");
  }
  const n = Math.max(Math.trunc(facets), 8);
  const radius = diameterMm / 2.0;
  const theta = linspace(0.0, 2.0 * Math.PI, n);
  const points: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = [centerMm[0] + radius * Math.cos(theta[i]!), centerMm[1] + radius * Math.sin(theta[i]!)];
  }
  return points;
}

/** Assemble an imported face drawing's features into one list of point chains.
 *
 * Takes the pieces a plan-view geometry import carries (drawing linework,
 * detected hole centers, chained slot loops, the inner mounting contour) and
 * returns closed chains ready to deform. Kept dependency-free -- callers
 * unpack the plan object -- so the geometry layer does not reach back into the
 * import layer.
 */
export function facePaths(
  outlinePathsMm: readonly RawPath[] = [],
  holeCentersMm: readonly number[][] = [],
  slotLoopsMm: readonly RawPath[] = [],
  innerBoundaryMm: RawPath | null = null,
  holeFacets = HOLE_FACETS,
): Point[][] {
  const paths: Point[][] = [];
  for (const path of cleanPaths(outlinePathsMm)) {
    paths.push(path);
  }
  for (const hole of holeCentersMm) {
    const [centerX, centerY, holeRadius] = hole;
    if (holeRadius! > 0.0) {
      paths.push(circlePathMm(2.0 * holeRadius!, [centerX!, centerY!], holeFacets));
    }
  }
  const loops: RawPath[] = [...slotLoopsMm];
  if (innerBoundaryMm !== null) {
    loops.push(innerBoundaryMm);
  }
  for (const loop of cleanPaths(loops)) {
    const first = loop[0]!;
    const last = loop[loop.length - 1]!;
    const closed = allClosePoint(first, last) ? loop : [...loop, [first[0], first[1]] as Point];
    paths.push(closed);
  }
  return paths;
}

/** Thin long chains to fit a total point budget (animation payload control).
 *
 * Every chain keeps its first and last point so closed loops stay closed; only
 * the sampling between them gets coarser.
 */
export function decimatePaths(paths: readonly RawPath[], maxPoints: number): Point[][] {
  const kept = cleanPaths(paths);
  const total = kept.reduce((sum, p) => sum + p.length, 0);
  if (maxPoints <= 0 || total <= maxPoints) {
    return kept;
  }
  const stride = Math.ceil(total / maxPoints);
  const thinned: Point[][] = [];
  for (const pts of kept) {
    const sampled: Point[] = [];
    for (let i = 0; i < pts.length; i += stride) sampled.push(pts[i]!);
    const last = pts[pts.length - 1]!;
    if (!allClosePoint(sampled[sampled.length - 1]!, last)) {
      sampled.push(last);
    }
    if (sampled.length >= 2) thinned.push(sampled);
  }
  return thinned;
}

// --- small numpy-semantics helpers ------------------------------------------

/** np.linspace(start, stop, num) -- endpoint inclusive, exact. */
function linspace(start: number, stop: number, num: number): number[] {
  const n = Math.max(num, 0);
  const out = new Array<number>(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = i === n - 1 ? stop : start + i * step;
  return out;
}

/** np.interp: linear interpolation, clamped at both ends (never extrapolated). */
function npInterp(x: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (x <= xp[0]!) return fp[0]!;
  if (x >= xp[n - 1]!) return fp[n - 1]!;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xp[i]!;
    const x1 = xp[i + 1]!;
    if (x0 <= x && x <= x1) {
      if (x1 === x0) return fp[i]!;
      return fp[i]! + (fp[i + 1]! - fp[i]!) * ((x - x0) / (x1 - x0));
    }
  }
  return fp[n - 1]!; // unreachable given the bounds checks above
}

/** np.allclose default tolerances (rtol=1e-5, atol=1e-8), applied per point. */
function allClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b);
}

function allClosePoint(a: Point, b: Point): boolean {
  return allClose(a[0], b[0]) && allClose(a[1], b[1]);
}
