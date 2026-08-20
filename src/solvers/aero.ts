/** Aero downforce/drag models: a simple speed-indexed downforce map, a CL/CD
 * model with a simplified center-of-pressure migration (spec 11.1-11.2), and a
 * tabulated CL/CD/CP map imported from a spec 11.3 CSV schema.
 *
 * File/YAML/CSV loading in the Python source reads from disk with `pathlib` +
 * `yaml`/`pandas`. There is no filesystem in the browser target, so the loader
 * functions here instead take an ALREADY-PARSED plain JavaScript value (the
 * result of `YAML.parse`/CSV-row-parsing done by the caller) and only perform
 * the pure validation/construction step.
 */

export interface AeroPoint {
  speed_mph: number;
  front_downforce_n: number;
  rear_downforce_n: number;
}

export interface AeroMap {
  points: readonly AeroPoint[];
}

/** Parses an already-loaded YAML document of the form
 * `{ downforce_map: [{ speed_mph, front_downforce_n, rear_downforce_n }, ...] }`.
 * (Python: `yaml.safe_load` + `Path.open`; the file read itself is the
 * caller's responsibility here.) */
export function loadAeroMap(raw: {
  downforce_map: Array<{ speed_mph: number; front_downforce_n: number; rear_downforce_n: number }>;
}): AeroMap {
  return {
    points: raw.downforce_map.map((point) => ({
      speed_mph: Number(point.speed_mph),
      front_downforce_n: Number(point.front_downforce_n),
      rear_downforce_n: Number(point.rear_downforce_n),
    })),
  };
}

/** Linear interpolation between the two bracketing points; outside the
 * tabulated speed range this extrapolates by a square law (dynamic pressure
 * ~ V^2) off the nearest endpoint rather than clamping. Mirrors Python's
 * private `_interpolate` exactly -- NOT the clamped `np.interp` used below in
 * `lookup`. */
function interpolateField(
  points: readonly AeroPoint[],
  speedMph: number,
  field: (point: AeroPoint) => number,
): number {
  const sortedPoints = [...points].sort((a, b) => a.speed_mph - b.speed_mph);
  const first = sortedPoints[0]!;
  const last = sortedPoints[sortedPoints.length - 1]!;
  if (speedMph <= first.speed_mph) {
    return field(first) * (speedMph / first.speed_mph) ** 2;
  }
  if (speedMph >= last.speed_mph) {
    return field(last) * (speedMph / last.speed_mph) ** 2;
  }
  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const lower = sortedPoints[i]!;
    const upper = sortedPoints[i + 1]!;
    if (lower.speed_mph <= speedMph && speedMph <= upper.speed_mph) {
      const fraction = (speedMph - lower.speed_mph) / (upper.speed_mph - lower.speed_mph);
      return field(lower) + fraction * (field(upper) - field(lower));
    }
  }
  return 0.0;
}

/** [front, rear] newtons at `speedMph`, or `[0, 0]` when no aero map is fitted. */
export function downforceAtSpeed(aeroMap: AeroMap | null, speedMph: number): [number, number] {
  if (aeroMap === null) return [0.0, 0.0];
  return [
    interpolateField(aeroMap.points, speedMph, (p) => p.front_downforce_n),
    interpolateField(aeroMap.points, speedMph, (p) => p.rear_downforce_n),
  ];
}

// --- Coefficient aero with CP migration (spec 11.1-11.2) --------------------

/** CL/CD aero with a simplified center-of-pressure migration model.
 *
 * `x_cp0_m` is measured rearward from the FRONT axle so that spec 11.2's
 * `lambda_aero_F = (L - x_cp)/L` and `lambda_aero_R = x_cp/L` hold. Positive
 * `cl` is downforce (spec 11.1 code convention).
 *
 * `x_cp = x_cp0 + k_pitch*theta_pitch + k_v*V^2` (spec 11.2). Nose-down pitch
 * is positive theta in this convention.
 */
export interface CoefficientAero {
  cl: number;
  cd: number;
  frontal_area_m2: number;
  air_density_kg_m3: number;
  x_cp0_m: number;
  k_pitch_m_per_deg?: number;
  k_v_m_per_mps2?: number;
}

/** Spec 11.1: `F_down = 0.5 * rho * V^2 * CL * A`. */
export const coefficientDownforceN = (aero: CoefficientAero, speedMps: number): number =>
  0.5 * aero.air_density_kg_m3 * speedMps ** 2 * aero.cl * aero.frontal_area_m2;

/** Spec 11.1: `F_drag = 0.5 * rho * V^2 * CD * A`. */
export const coefficientDragN = (aero: CoefficientAero, speedMps: number): number =>
  0.5 * aero.air_density_kg_m3 * speedMps ** 2 * aero.cd * aero.frontal_area_m2;

/** Spec 11.2 simplified CP location, clamped to the wheelbase so axle
 * downforce never goes negative (a CP outside the axles in this low-order
 * model would imply lift on one axle -- outside its validity). */
export function cpPositionM(
  aero: CoefficientAero,
  speedMps: number,
  pitchDeg: number,
  wheelbaseM: number,
): number {
  const xCp =
    aero.x_cp0_m + (aero.k_pitch_m_per_deg ?? 0.0) * pitchDeg + (aero.k_v_m_per_mps2 ?? 0.0) * speedMps ** 2;
  return Math.min(Math.max(xCp, 0.0), wheelbaseM);
}

/** [front, rear] downforce split by the migrated CP (spec 11.2). */
export function coefficientAxleDownforceN(
  aero: CoefficientAero,
  speedMps: number,
  wheelbaseM: number,
  pitchDeg = 0.0,
): [number, number] {
  const total = coefficientDownforceN(aero, speedMps);
  const xCp = cpPositionM(aero, speedMps, pitchDeg, wheelbaseM);
  const frontFraction = (wheelbaseM - xCp) / wheelbaseM;
  return [total * frontFraction, total * (1.0 - frontFraction)];
}

// --- Aero-map CSV import (spec 11.3) -----------------------------------------

export const AERO_MAP_CSV_COLUMNS = [
  "speed_mps",
  "pitch_deg",
  "front_ride_height_mm",
  "rear_ride_height_mm",
  "yaw_deg",
  "CL",
  "CD",
  "CP_x_m",
] as const;

export interface AeroMapCsvRow {
  speed_mps: number;
  pitch_deg: number;
  front_ride_height_mm: number;
  rear_ride_height_mm: number;
  yaw_deg: number;
  CL: number;
  CD: number;
  CP_x_m: number;
}

/** Tabulated CL/CD/CP map imported from the spec 11.3 CSV schema.
 *
 * `table` stands in for the Python `pd.DataFrame`: an already-parsed array of
 * row objects (one per CSV data row), as produced by the caller's CSV parser. */
export interface AeroMapTable {
  table: readonly AeroMapCsvRow[];
}

/** Clamped linear interpolation -- mirrors `np.interp`: held at the endpoint
 * values outside `xs`'s range, never extrapolated. Assumes `xs` sorted
 * ascending. */
function npInterpClamped(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (xs.length === 0) return 0.0;
  if (x <= xs[0]!) return ys[0]!;
  const lastIndex = xs.length - 1;
  if (x >= xs[lastIndex]!) return ys[lastIndex]!;
  for (let i = 0; i < lastIndex; i++) {
    const lower = xs[i]!;
    const upper = xs[i + 1]!;
    if (lower <= x && x <= upper) {
      const fraction = (x - lower) / (upper - lower);
      return ys[i]! + fraction * (ys[i + 1]! - ys[i]!);
    }
  }
  return ys[lastIndex]!;
}

/** CL, CD, CP_x at an operating point.
 *
 * Secondary dimensions (pitch, ride heights, yaw) snap to the nearest
 * tabulated value -- CFD maps are sparse grids, and inventing
 * cross-derivatives by blending attitudes would be false precision. Speed is
 * then linearly interpolated along the surviving rows, held at the end points
 * beyond the tabulated range.
 */
export function lookup(
  table: AeroMapTable,
  speedMps: number,
  pitchDeg: number | null = 0.0,
  frontRideHeightMm: number | null = null,
  rearRideHeightMm: number | null = null,
  yawDeg: number | null = 0.0,
): { CL: number; CD: number; CP_x_m: number } {
  let rows = table.table;
  const filters: Array<[keyof AeroMapCsvRow, number | null]> = [
    ["pitch_deg", pitchDeg],
    ["front_ride_height_mm", frontRideHeightMm],
    ["rear_ride_height_mm", rearRideHeightMm],
    ["yaw_deg", yawDeg],
  ];
  for (const [column, target] of filters) {
    if (target === null) continue;
    // pandas' `.unique()` returns values in order of first appearance, and
    // `np.argmin` breaks ties by taking the FIRST minimum -- replicate both.
    const uniqueValues: number[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      const v = row[column];
      if (!seen.has(v)) {
        seen.add(v);
        uniqueValues.push(v);
      }
    }
    let nearest = uniqueValues[0]!;
    let bestDiff = Math.abs(nearest - target);
    for (const v of uniqueValues) {
      const diff = Math.abs(v - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = v;
      }
    }
    rows = rows.filter((row) => row[column] === nearest);
  }

  const sortedRows = [...rows].sort((a, b) => a.speed_mps - b.speed_mps);
  const speeds = sortedRows.map((row) => row.speed_mps);
  return {
    CL: npInterpClamped(speedMps, speeds, sortedRows.map((row) => row.CL)),
    CD: npInterpClamped(speedMps, speeds, sortedRows.map((row) => row.CD)),
    CP_x_m: npInterpClamped(speedMps, speeds, sortedRows.map((row) => row.CP_x_m)),
  };
}

/** Loads a spec 11.3 aero-map CSV, validating the column schema.
 *
 * `rows` stands in for the parsed CSV (see `AeroMapTable`). Python validates
 * against `pd.read_csv`'s `DataFrame.columns` (populated from the header row
 * even when there are zero data rows); with only parsed data rows available
 * here, the column check instead uses the keys of the first row when present. */
export function loadAeroMapCsv(rows: ReadonlyArray<Record<string, unknown>>): AeroMapTable {
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const missing = AERO_MAP_CSV_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) {
    throw new Error(`aero map CSV missing required columns: [${missing.map((m) => `'${m}'`).join(", ")}]`);
  }
  if (rows.length === 0) {
    throw new Error("aero map CSV has no data rows");
  }
  return { table: rows as unknown as AeroMapCsvRow[] };
}

/** Freezes a map lookup into a CoefficientAero at one operating point.
 *
 * The returned object carries the looked-up CP directly (`x_cp0_m`) with zero
 * migration coefficients, because migration is already encoded in the table
 * itself.
 */
export function aeroFromMap(
  table: AeroMapTable,
  frontalAreaM2: number,
  airDensityKgM3: number,
  speedMps: number,
  pitchDeg = 0.0,
  frontRideHeightMm: number | null = null,
  rearRideHeightMm: number | null = null,
  yawDeg = 0.0,
): CoefficientAero {
  const point = lookup(table, speedMps, pitchDeg, frontRideHeightMm, rearRideHeightMm, yawDeg);
  return {
    cl: point.CL,
    cd: point.CD,
    frontal_area_m2: frontalAreaM2,
    air_density_kg_m3: airDensityKgM3,
    x_cp0_m: point.CP_x_m,
    k_pitch_m_per_deg: 0.0,
    k_v_m_per_mps2: 0.0,
  };
}
