/** Reading a solved field: snapshots, surface profiles, face reconstruction.
 *
 * The worker hands back one flat Float64Array for the whole snapshot stack
 * (see `solver.worker.ts` — it is transferred, not cloned). Everything the
 * views need to pull out of it lives here so the page components stay about
 * layout rather than indexing arithmetic.
 */
import type { SolverOk } from "../../worker/solver.worker.ts";

export type Grid = Array<Array<number | null>>;

/** One snapshot as rows, NaN mapped to null so Plotly draws voids as gaps. */
export function snapshotGrid(field: SolverOk, index: number): Grid {
  const { nRows, nCols, snapData } = field;
  const base = index * nRows * nCols;
  const rows: Grid = new Array(nRows);
  for (let j = 0; j < nRows; j++) {
    const row: Array<number | null> = new Array(nCols);
    for (let i = 0; i < nCols; i++) {
      const v = snapData[base + j * nCols + i]!;
      row[i] = Number.isFinite(v) ? v : null;
    }
    rows[j] = row;
  }
  return rows;
}

/** One snapshot as raw rows, NaN preserved — what the expansion solvers want. */
export function snapshotRows(field: SolverOk, index: number): number[][] {
  const { nRows, nCols, snapData } = field;
  const base = index * nRows * nCols;
  const rows: number[][] = new Array(nRows);
  for (let j = 0; j < nRows; j++) {
    rows[j] = Array.from(snapData.subarray(base + j * nCols, base + (j + 1) * nCols));
  }
  return rows;
}

export function snapshotCount(field: SolverOk): number {
  return field.snapTimesS.length;
}

/** Index of the snapshot closest to a time. */
export function nearestSnapshot(field: SolverOk, timeS: number): number {
  let best = 0;
  let bestGap = Infinity;
  field.snapTimesS.forEach((t, i) => {
    const gap = Math.abs(t - timeS);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}

/** Index of the hottest snapshot in the stack — where the scrubber should open. */
export function hottestSnapshot(field: SolverOk): number {
  const { nRows, nCols, snapData } = field;
  const stride = nRows * nCols;
  let best = 0;
  let bestMax = -Infinity;
  for (let s = 0; s < field.snapTimesS.length; s++) {
    let max = -Infinity;
    for (let k = s * stride; k < (s + 1) * stride; k++) {
      const v = snapData[k]!;
      if (Number.isFinite(v) && v > max) max = v;
    }
    if (max > bestMax) {
      bestMax = max;
      best = s;
    }
  }
  return best;
}

/** Friction-face temperature along the radius, for one snapshot.
 *
 * The annulus models a half thickness with the surface as the last axial row,
 * so its profile is that row. A rasterized section has metal only where the
 * drawing put it, so the surface is the topmost ACTIVE cell of each radial
 * column — anything else reads voids as cold metal.
 */
export function surfaceProfile(field: SolverOk, index: number): Array<number | null> {
  const { nRows, nCols, snapData, activeMask } = field;
  const base = index * nRows * nCols;
  if (activeMask === null) {
    const top = base + (nRows - 1) * nCols;
    return Array.from(snapData.subarray(top, top + nCols));
  }
  const profile: Array<number | null> = new Array(nCols).fill(null);
  for (let i = 0; i < nCols; i++) {
    for (let j = nRows - 1; j >= 0; j--) {
      if (activeMask[j * nCols + i] === 1) {
        const v = snapData[base + j * nCols + i]!;
        profile[i] = Number.isFinite(v) ? v : null;
        break;
      }
    }
  }
  return profile;
}

/** np.interp on a strictly increasing x, with numpy's clamp-at-the-edges rule. */
export function interp(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi]! - xs[lo]!;
  if (span === 0) return ys[lo]!;
  return ys[lo]! + ((x - xs[lo]!) * (ys[hi]! - ys[lo]!)) / span;
}

export interface FaceRaster {
  axisMm: number[];
  z: Grid;
  rInnerMm: number;
  rOuterMm: number;
}

/** Sweep an axisymmetric surface profile around the disc.
 *
 * The model has no azimuthal variation, so this reconstruction is exact rather
 * than decorative — the same temperature at the same radius, everywhere around.
 * Holes are punched at their drawn positions because the solver smears their
 * cooling azimuthally: showing metal where a hole is would be a lie the solver
 * never told.
 */
export function sweepProfileToFace(
  rMm: number[],
  profile: Array<number | null>,
  holesMm: ReadonlyArray<readonly [number, number, number]>,
  nPixels = 221,
): FaceRaster | null {
  const rValid: number[] = [];
  const tValid: number[] = [];
  rMm.forEach((r, i) => {
    const t = profile[i];
    if (t !== null && t !== undefined && Number.isFinite(t)) {
      rValid.push(r);
      tValid.push(t);
    }
  });
  if (rValid.length < 2) return null;

  const rOuter = rValid[rValid.length - 1]!;
  const rInner = rValid[0]!;
  const axis: number[] = new Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    axis[i] = -rOuter + (2.0 * rOuter * i) / (nPixels - 1);
  }

  const z: Grid = new Array(nPixels);
  for (let j = 0; j < nPixels; j++) {
    const y = axis[j]!;
    const row: Array<number | null> = new Array(nPixels);
    for (let i = 0; i < nPixels; i++) {
      const x = axis[i]!;
      // sqrt(x*x + y*y), not Math.hypot — the core uses the naive form to keep
      // the domain-edge test bit-identical with numpy, and this shares its edges.
      const rr = Math.sqrt(x * x + y * y);
      if (rr < rInner || rr > rOuter) {
        row[i] = null;
        continue;
      }
      let masked = false;
      for (const [hx, hy, hr] of holesMm) {
        const dx = x - hx;
        const dy = y - hy;
        if (dx * dx + dy * dy <= hr * hr) {
          masked = true;
          break;
        }
      }
      row[i] = masked ? null : interp(rr, rValid, tValid);
    }
    z[j] = row;
  }
  return { axisMm: axis, z, rInnerMm: rInner, rOuterMm: rOuter };
}

/** Mirror an annulus half-thickness field about the mid-plane for display. */
export function mirrorAnnulus(half: Grid): Grid {
  const flipped = half.slice().reverse();
  return [...flipped, ...half.slice(1)];
}

/** The matching mirrored axial axis, in mm. */
export function mirrorAxisMm(zM: number[]): number[] {
  const mm = zM.map((v) => v * 1000.0);
  const negated = mm.slice().reverse().map((v) => -v);
  return [...negated, ...mm.slice(1)];
}

/** Flatten point chains into one x/y pair with null breaks.
 *
 * One trace per hole would be hundreds of traces on a cross-drilled rotor;
 * a null break draws them all as a single one. */
export function flattenPaths(
  paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): { x: Array<number | null>; y: Array<number | null> } {
  const x: Array<number | null> = [];
  const y: Array<number | null> = [];
  for (const path of paths) {
    for (const point of path) {
      x.push(point[0]);
      y.push(point[1]);
    }
    x.push(null);
    y.push(null);
  }
  return { x, y };
}

/** A closed circle as x/y arrays, for rings drawn over a face view. */
export function circleXY(radiusMm: number, facets = 181): { x: number[]; y: number[] } {
  const x: number[] = new Array(facets);
  const y: number[] = new Array(facets);
  for (let i = 0; i < facets; i++) {
    const theta = (2.0 * Math.PI * i) / (facets - 1);
    x[i] = radiusMm * Math.cos(theta);
    y[i] = radiusMm * Math.sin(theta);
  }
  return { x, y };
}
