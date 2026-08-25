/** Import rotor cross-section polygons from CAD exchange files (spec 21).
 *
 * Supported inputs:
 *
 * - **DXF cross-section**: the modelspace must contain at least one CLOSED
 *   polyline profile (LWPOLYLINE / POLYLINE) drawn in the radius/axial plane;
 *   arcs and bulges are flattened to line segments. When several closed
 *   profiles exist, the one enclosing the largest area is taken as the rotor
 *   outline (inner profiles / bolt holes are ignored -- the FD model is 2D
 *   axisymmetric, so circumferential features like cross-drilling cannot be
 *   represented in the section anyway).
 * - **DXF face drawing / plan view**: an OD circle centered on the rotor
 *   axis, optional rings of identical cross-drilled holes, and arbitrary
 *   arcs/lines forming the inner profile (see {@link planViewFromDxf}).
 * - **CSV / whitespace text**: two numeric columns per line, `r, z` in mm.
 *
 * DWG is a proprietary binary format with no reliable open-source reader --
 * export the sketch as DXF from CAD (SolidWorks/Fusion/Inventor all offer
 * "Save as DXF") and upload that instead. {@link polygonFromUpload} raises a
 * clear error for `.dwg` uploads saying exactly that.
 *
 * Coordinate convention: X = radius from the rotation axis (mm), Y = axial
 * position (mm). {@link transformPolygon} provides swap/scale/offset fix-ups
 * for profiles drawn in other conventions or units.
 *
 * ---
 *
 * ## Porting notes (TypeScript port of `sdm_brakes/io/section_import.py`)
 *
 * The Python module leans on `ezdxf` for DXF parsing, arc-to-Bezier-to-
 * polyline flattening, and loose-edge loop chaining (`ezdxf.edgeminer` /
 * `ezdxf.edgesmith`). There is no JavaScript equivalent, so this file
 * reimplements the subset actually used, by hand, with zero runtime
 * dependencies. Notable deviations from ezdxf's exact internals, and why
 * they don't change the geometry that reaches the solvers:
 *
 * - **Arc flattening.** `ezdxf.path.make_path(...).flattening(distance)`
 *   converts every arc to cubic Bezier curves first (fitted to the circular
 *   arc), then adaptively subdivides those curves to the sagitta tolerance.
 *   That two-stage pipeline is impractical to reproduce bit-for-bit. Instead
 *   this port flattens circular arcs directly with the closed-form sagitta
 *   formula (`arcChordLength` / `arcSegmentCount`, ported from
 *   `ezdxf.math.arc.ConstructionArc.flattening`, which uses the same
 *   formula ezdxf itself derives for the purpose): the segment count is the
 *   smallest integer such that no segment's deviation from the true circular
 *   arc exceeds `distance`. Cross-checked against `ezdxf.path.make_path(...)
 *   .flattening()` on identical arcs (see the test suite and the task
 *   report): endpoints match to float precision on every case tried; ezdxf's
 *   Bezier-then-flatten pipeline consistently emits MORE points for the same
 *   tolerance (observed ~1.3x-2x on arcs from 40 deg to 360 deg, e.g. 8 vs 9,
 *   56 vs 65, 12 vs 17, 18 vs 33 points) because it pays for two independent
 *   approximation layers instead of one. Both stay within the requested
 *   sagitta of the true arc, so the resulting polygons are geometrically
 *   equivalent for area, point-in-polygon, and radius calculations -- just
 *   built from fewer, more efficient vertices here.
 * - **Loop chaining.** `ezdxf.edgeminer.find_all_loops` first packs runs of
 *   degree-2-only vertices into single "simple chain" macro-edges before its
 *   recursive backtracking search, purely as a performance optimization for
 *   graphs with long non-branching runs. This port runs the same recursive
 *   backtracking search (ported line-for-line from `edgeminer.LoopFinder
 *   .search`: same candidate-edge lookup, same forward/reversed
 *   normalization, same degree-2 guard via the "does this vertex already
 *   appear as some edge's end" check, same de-duplication by rotated edge-id
 *   key) directly on the un-packed edge list. The result set is identical;
 *   only the asymptotic cost on pathological inputs differs, and rotor face
 *   drawings carry at most a few dozen loose slot/profile entities, so the
 *   optimization is not needed here.
 * - **Unsupported entity types.** ELLIPSE and SPLINE entities are not
 *   parsed (a rotor face/section drawing built from lines, arcs, circles,
 *   and polylines -- the CAD-typical export -- never needs them). Any such
 *   entity, and any other DXF entity type this parser doesn't recognize, is
 *   silently skipped when scanning geometry, but its type name is still
 *   reported in the "no closed polyline profile found" error's entity list
 *   so a user knows what CAD actually put in the file.
 * - **Binary/legacy DXF recovery.** `ezdxf.recover` (used by Python as a
 *   fallback for malformed files) has no port here; only well-formed ASCII
 *   DXF tag streams are read. This matches the primary path Python takes for
 *   every file this project actually produces or receives (`doc.write()` /
 *   CAD "Save As DXF" both emit well-formed ASCII).
 */

export type Point = [number, number];

/** Max sagitta (mm) when flattening DXF arcs/bulges into polygon segments. */
export const FLATTEN_DISTANCE_MM = 0.1;

/** Chaining tolerance (mm) when joining loose arcs/lines into closed loops. */
export const LOOP_GAP_TOL_MM = 0.05;

/** DXF `$INSUNITS` header codes -> [scale to mm, unit name]. Only the
 * declarations CAD exporters actually mean are converted: inches/feet/cm.
 * "meters" (6) is deliberately treated as mm because it is the silent
 * default of many DXF writers (ezdxf among them) on files whose numbers are
 * really mm; a genuine meters drawing trips the tiny-OD warning and the
 * manual scale. */
const DXF_INSUNITS_TO_MM: Record<number, [number, string]> = {
  0: [1.0, "unspecified (assumed mm)"],
  1: [25.4, "inches"],
  2: [304.8, "feet"],
  4: [1.0, "millimeters"],
  5: [10.0, "centimeters"],
  6: [1.0, "declared meters (assumed mm — a common false default)"],
};

// ============================================================================
// Public data model
// ============================================================================

/** One ring of identical cross-drilled holes detected in a plan view. */
export interface HoleRing {
  count: number;
  hole_diameter_mm: number;
  center_radius_mm: number;
}

/** Rotor face (plan-view) drawing reduced to axisymmetric data.
 *
 * Plan views carry no thickness and usually no clean inner circle (drive-tab
 * profiles are arcs/lines), so `suggested_inner_diameter_mm` is the closest
 * approach of any non-hole geometry to the rotor axis -- a starting value
 * for the user to confirm, not gospel.
 *
 * `hole_centers_mm` keeps every hole's true (x, y, radius) so displays can
 * punch holes where they actually are; `outline_paths_mm` is the drawing's
 * non-hole linework (OD circle, inner profile arcs/lines) flattened to point
 * chains for overlaying plots onto the real geometry.
 */
export interface PlanViewGeometry {
  outer_diameter_mm: number;
  suggested_inner_diameter_mm: number | null;
  hole_rings: HoleRing[];
  hole_centers_mm: [number, number, number][];
  outline_paths_mm: Point[][];
  // Closed loops chained from loose arcs/lines: slots of any shape (straight,
  // curved, J-hooks) as void polygons, and the true inner boundary contour
  // (the mounting-structure profile around the drive buttons) when the
  // drawing closes around the origin.
  slot_loops_mm: Point[][];
  inner_boundary_mm: Point[] | null;
  //: Length unit declared by the drawing ($INSUNITS); coordinates above are
  //: already converted to mm regardless.
  detected_units: string;
}

/** Uniformly scale every geometric quantity of a plan view (unit fix-up). */
export function scalePlanView(plan: PlanViewGeometry, scale: number): PlanViewGeometry {
  if (scale <= 0.0) {
    throw new Error("scale must be positive");
  }
  if (scale === 1.0) {
    return plan;
  }
  const pts = (points: readonly Point[]): Point[] => points.map(([x, y]) => [x * scale, y * scale]);
  return {
    outer_diameter_mm: plan.outer_diameter_mm * scale,
    suggested_inner_diameter_mm:
      plan.suggested_inner_diameter_mm === null ? null : plan.suggested_inner_diameter_mm * scale,
    hole_rings: plan.hole_rings.map((ring) => ({
      count: ring.count,
      hole_diameter_mm: ring.hole_diameter_mm * scale,
      center_radius_mm: ring.center_radius_mm * scale,
    })),
    hole_centers_mm: plan.hole_centers_mm.map(([x, y, r]) => [x * scale, y * scale, r * scale]),
    outline_paths_mm: plan.outline_paths_mm.map(pts),
    slot_loops_mm: plan.slot_loops_mm.map(pts),
    inner_boundary_mm: plan.inner_boundary_mm === null ? null : pts(plan.inner_boundary_mm),
    detected_units: plan.detected_units,
  };
}

// ============================================================================
// Small geometry helpers
// ============================================================================

function polygonArea(points: readonly Point[]): number {
  let area = 0.0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % n]!;
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2.0;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Returns the chord length for an arc defined by `radius` and the
 * `sagitta` (distance from the center of the arc to the center of its
 * chord). Ported from `ezdxf.math.arc.arc_chord_length`. */
function arcChordLength(radius: number, sagitta: number): number {
  const v = 2.0 * radius * sagitta - sagitta * sagitta;
  if (v < 0.0) return 0.0;
  return 2.0 * Math.sqrt(v);
}

/** Returns the number of segments required to approximate a circular arc of
 * the given `radius` and angular `span` (radians) so that no segment
 * deviates from the true arc by more than `sagitta`. Ported from
 * `ezdxf.math.arc.arc_segment_count`. */
function arcSegmentCount(radius: number, span: number, sagitta: number): number {
  if (radius <= 0.0) return 1;
  const chordLength = arcChordLength(radius, sagitta);
  const ratio = chordLength / 2.0 / radius;
  if (ratio < -1.0 || ratio > 1.0) return 1;
  const alpha = Math.asin(ratio) * 2.0;
  if (alpha <= 0.0) return 1;
  return Math.max(1, Math.ceil(span / alpha));
}

/** Flattens a counter-clockwise circular arc (`startDeg` -> `endDeg`,
 * degrees, DXF convention) to points within `sagitta` of the true curve.
 * Ported from `ezdxf.math.arc.ConstructionArc.flattening`, but computed
 * directly from the closed-form sagitta segment count instead of going
 * through ezdxf's Bezier-curve-fit-then-adaptively-flatten pipeline -- see
 * the module-level porting notes for the (small, one-directional) point-
 * count difference this produces relative to ezdxf itself. */
function flattenArcDeg(center: Point, radius: number, startDeg: number, endDeg: number, sagitta: number): Point[] {
  const r = Math.abs(radius);
  if (r <= 0.0) return [];
  if (Math.abs(startDeg - endDeg) < 1e-9) return [];
  let start = ((startDeg % 360) + 360) % 360;
  let stop = ((endDeg % 360) + 360) % 360;
  if (stop <= start) stop += 360;
  const span = ((stop - start) * Math.PI) / 180;
  const count = arcSegmentCount(r, span, sagitta);
  const points: Point[] = new Array(count + 1);
  for (let i = 0; i <= count; i++) {
    const deg = start + ((stop - start) * i) / count;
    const rad = (deg * Math.PI) / 180;
    points[i] = [center[0] + r * Math.cos(rad), center[1] + r * Math.sin(rad)];
  }
  return points;
}

/** Counter-clockwise angle span (degrees, [0, 360]) from `start` to `end`,
 * DXF convention. Ported from `ezdxf.math._construct.arc_angle_span_deg`. */
function arcAngleSpanDeg(start: number, end: number): number {
  const tol = 1e-9;
  if (Math.abs(start - end) < tol) return 0.0;
  const s = ((start % 360) + 360) % 360;
  const endMod = ((end % 360) + 360) % 360;
  if (Math.abs(s - endMod) < tol) return 360.0;
  let e = Math.abs(end - 360.0) < tol ? end : endMod;
  if (e < s) e += 360.0;
  return e - s;
}

// ============================================================================
// DXF tag-stream parsing (ENTITIES + $INSUNITS only)
// ============================================================================

interface Tag {
  code: number;
  value: string;
}

/** Splits a normalized (LF-only) DXF text body into (group-code, value)
 * tag pairs -- DXF's flat "alternating group-code / value line" ASCII
 * format. */
function tokenizeDxf(text: string): Tag[] {
  const lines = text.split("\n");
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeLine = lines[i]!.trim();
    if (codeLine === "") continue;
    const code = Number.parseInt(codeLine, 10);
    if (!Number.isFinite(code)) continue;
    tags.push({ code, value: lines[i + 1]!.trim() });
  }
  return tags;
}

/** Returns the tags strictly between a `SECTION`/2/`name` marker and its
 * matching `ENDSEC`, or `[]` if the section is absent. */
function extractSection(tags: readonly Tag[], name: string): Tag[] {
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!;
    if (t.code === 0 && t.value === "SECTION") {
      const marker = tags[i + 1];
      if (marker && marker.code === 2 && marker.value === name) {
        let j = i + 2;
        while (j < tags.length && !(tags[j]!.code === 0 && tags[j]!.value === "ENDSEC")) j++;
        return tags.slice(i + 2, j);
      }
    }
  }
  return [];
}

function readInsunits(headerTags: readonly Tag[]): number {
  for (let i = 0; i < headerTags.length; i++) {
    const t = headerTags[i]!;
    if (t.code === 9 && t.value === "$INSUNITS") {
      const valueTag = headerTags[i + 1];
      if (valueTag) {
        const n = Number.parseInt(valueTag.value, 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return 0;
}

interface DxfLineEntity {
  kind: "LINE";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface DxfCircleEntity {
  kind: "CIRCLE";
  cx: number;
  cy: number;
  r: number;
}

interface DxfArcEntity {
  kind: "ARC";
  cx: number;
  cy: number;
  r: number;
  startAngleDeg: number;
  endAngleDeg: number;
}

interface DxfPolylineVertex {
  x: number;
  y: number;
  bulge: number;
}

interface DxfPolylineEntity {
  kind: "LWPOLYLINE" | "POLYLINE";
  closed: boolean;
  vertices: DxfPolylineVertex[];
}

type DxfEntity = DxfLineEntity | DxfCircleEntity | DxfArcEntity | DxfPolylineEntity;
type DxfEdgeEntity = DxfLineEntity | DxfArcEntity;

interface DxfDocument {
  insunits: number;
  entities: DxfEntity[];
  /** Every top-level entity type name seen in ENTITIES, including types this
   * parser does not model (used only for diagnostic error messages). */
  entityTypeNames: string[];
}

function firstTagNumber(tags: readonly Tag[], code: number): number | undefined {
  for (const t of tags) {
    if (t.code === code) {
      const n = Number.parseFloat(t.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function hasClosedFlag(tags: readonly Tag[]): boolean {
  const flags = firstTagNumber(tags, 70) ?? 0;
  return (Math.trunc(flags) & 1) === 1;
}

function polylineVerticesFromLwpolylineTags(tags: readonly Tag[]): DxfPolylineVertex[] {
  const vertices: DxfPolylineVertex[] = [];
  let current: DxfPolylineVertex | null = null;
  for (const t of tags) {
    if (t.code === 10) {
      current = { x: Number.parseFloat(t.value), y: 0, bulge: 0 };
      vertices.push(current);
    } else if (t.code === 20 && current) {
      current.y = Number.parseFloat(t.value);
    } else if (t.code === 42 && current) {
      current.bulge = Number.parseFloat(t.value);
    }
  }
  return vertices;
}

function vertexFromTags(tags: readonly Tag[]): DxfPolylineVertex {
  return {
    x: firstTagNumber(tags, 10) ?? 0,
    y: firstTagNumber(tags, 20) ?? 0,
    bulge: firstTagNumber(tags, 42) ?? 0,
  };
}

interface RawEntityRecord {
  type: string;
  tags: Tag[];
}

function splitEntityRecords(entityTags: readonly Tag[]): RawEntityRecord[] {
  const records: RawEntityRecord[] = [];
  let current: RawEntityRecord | null = null;
  for (const t of entityTags) {
    if (t.code === 0) {
      current = { type: t.value, tags: [] };
      records.push(current);
    } else if (current) {
      current.tags.push(t);
    }
  }
  return records;
}

function buildEntities(records: readonly RawEntityRecord[]): { entities: DxfEntity[]; typeNames: string[] } {
  const entities: DxfEntity[] = [];
  const typeNames = new Set<string>();
  let i = 0;
  while (i < records.length) {
    const rec = records[i]!;
    switch (rec.type) {
      case "LINE": {
        typeNames.add(rec.type);
        entities.push({
          kind: "LINE",
          x1: firstTagNumber(rec.tags, 10) ?? 0,
          y1: firstTagNumber(rec.tags, 20) ?? 0,
          x2: firstTagNumber(rec.tags, 11) ?? 0,
          y2: firstTagNumber(rec.tags, 21) ?? 0,
        });
        i++;
        break;
      }
      case "CIRCLE": {
        typeNames.add(rec.type);
        entities.push({
          kind: "CIRCLE",
          cx: firstTagNumber(rec.tags, 10) ?? 0,
          cy: firstTagNumber(rec.tags, 20) ?? 0,
          r: firstTagNumber(rec.tags, 40) ?? 0,
        });
        i++;
        break;
      }
      case "ARC": {
        typeNames.add(rec.type);
        entities.push({
          kind: "ARC",
          cx: firstTagNumber(rec.tags, 10) ?? 0,
          cy: firstTagNumber(rec.tags, 20) ?? 0,
          r: firstTagNumber(rec.tags, 40) ?? 0,
          startAngleDeg: firstTagNumber(rec.tags, 50) ?? 0,
          endAngleDeg: firstTagNumber(rec.tags, 51) ?? 0,
        });
        i++;
        break;
      }
      case "LWPOLYLINE": {
        typeNames.add(rec.type);
        entities.push({
          kind: "LWPOLYLINE",
          closed: hasClosedFlag(rec.tags),
          vertices: polylineVerticesFromLwpolylineTags(rec.tags),
        });
        i++;
        break;
      }
      case "POLYLINE": {
        typeNames.add(rec.type);
        const closed = hasClosedFlag(rec.tags);
        const vertices: DxfPolylineVertex[] = [];
        i++;
        while (i < records.length && records[i]!.type === "VERTEX") {
          vertices.push(vertexFromTags(records[i]!.tags));
          i++;
        }
        if (i < records.length && records[i]!.type === "SEQEND") i++;
        entities.push({ kind: "POLYLINE", closed, vertices });
        break;
      }
      default: {
        // Unsupported/unmodeled entity type (TEXT, HATCH, SPLINE, ELLIPSE,
        // INSERT, DIMENSION, ...). Not geometrically interpreted, but its
        // name is kept for the "no closed profile found" diagnostic.
        typeNames.add(rec.type);
        i++;
      }
    }
  }
  return { entities, typeNames: Array.from(typeNames).sort() };
}

function readDxfDocument(data: Uint8Array | string): DxfDocument {
  const raw = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const tags = tokenizeDxf(text);
  if (!tags.some((t) => t.code === 0 && t.value === "SECTION")) {
    throw new Error("could not parse DXF file: no SECTION found");
  }
  const headerTags = extractSection(tags, "HEADER");
  const entityTags = extractSection(tags, "ENTITIES");
  const records = splitEntityRecords(entityTags);
  const { entities, typeNames } = buildEntities(records);
  return { insunits: readInsunits(headerTags), entities, entityTypeNames: typeNames };
}

/** Reads the drawing's declared length unit ($INSUNITS) as [scale-to-mm, name].
 *
 * CAD exporters (SolidWorks, Fusion, Inventor) stamp this header, so inch
 * drawings convert automatically instead of arriving 25.4x too small. Files
 * with no (trustworthy) declaration are assumed to be mm -- the page-level
 * manual unit scale remains the escape hatch.
 */
function dxfUnitScaleToMm(doc: DxfDocument): [number, string] {
  const entry = DXF_INSUNITS_TO_MM[doc.insunits];
  if (entry) return entry;
  return [1.0, `unrecognized unit code ${doc.insunits} (assumed mm)`];
}

// ============================================================================
// Cross-section polygon (closed LWPOLYLINE/POLYLINE profile)
// ============================================================================

/** Flattens a polyline's vertex+bulge chain to points, in the vertex order
 * given, closing the ring back to vertex 0 when `closed` is true. Straight
 * segments contribute their end vertex only; bulge segments are expanded to
 * an arc via {@link bulgeToArc} and flattened to `distance` sagitta. Mirrors
 * what `ezdxf.path.make_path(...).flattening(distance)` yields for an
 * LWPOLYLINE/POLYLINE, including the closed-loop duplicate: the last point
 * of a closed polyline coincides with the first (callers that want an open
 * ring must drop it themselves, matching Python's own call sites). */
function flattenPolyline(vertices: readonly DxfPolylineVertex[], closed: boolean, distance: number): Point[] {
  const n = vertices.length;
  if (n === 0) return [];
  const points: Point[] = [[vertices[0]!.x, vertices[0]!.y]];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const v0 = vertices[i]!;
    const v1 = vertices[(i + 1) % n]!;
    const start: Point = [v0.x, v0.y];
    const end: Point = [v1.x, v1.y];
    if (v0.bulge === 0) {
      points.push(end);
    } else {
      const arc = bulgeToArc(start, end, v0.bulge);
      const arcPts = flattenArcDeg(
        arc.center,
        arc.radius,
        (arc.startAngleRad * 180) / Math.PI,
        (arc.endAngleRad * 180) / Math.PI,
        distance,
      );
      // Drop the duplicate joint point (arcPts[0] === start already pushed).
      for (let k = 1; k < arcPts.length; k++) points.push(arcPts[k]!);
      if (arcPts.length === 0) points.push(end);
    }
  }
  return points;
}

/** Converts a bulge-encoded vertex pair to arc parameters (center,
 * start/end angle in radians, radius). Ported from
 * `ezdxf.math.bulge.bulge_to_arc` / `signed_bulge_radius`. The arcs defined
 * by bulge values start at the vertex carrying the bulge and end at the
 * following vertex; the return value always describes a counter-clockwise
 * arc (clockwise/negative-bulge inputs have start/end swapped). */
function bulgeToArc(
  start: Point,
  end: Point,
  bulge: number,
): { center: Point; startAngleRad: number; endAngleRad: number; radius: number } {
  const angleOf = (p1: Point, p2: Point) => Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
  const polar = (p: Point, angle: number, distance: number): Point => [
    p[0] + Math.cos(angle) * distance,
    p[1] + Math.sin(angle) * distance,
  ];
  const chord = dist(start, end);
  const r = (chord * (1.0 + bulge * bulge)) / 4.0 / bulge;
  const a = angleOf(start, end) + (Math.PI / 2 - Math.atan(bulge) * 2);
  const center = polar(start, a, r);
  if (bulge < 0) {
    return { center, startAngleRad: angleOf(center, end), endAngleRad: angleOf(center, start), radius: Math.abs(r) };
  }
  return { center, startAngleRad: angleOf(center, start), endAngleRad: angleOf(center, end), radius: Math.abs(r) };
}

function closedProfilesFromEntities(entities: readonly DxfEntity[], flattenDistance: number): Point[][] {
  const profiles: Point[][] = [];
  for (const entity of entities) {
    if (entity.kind !== "LWPOLYLINE" && entity.kind !== "POLYLINE") continue;
    if (!entity.closed) continue;
    let points = flattenPolyline(entity.vertices, true, flattenDistance);
    // Flattening a closed path repeats the start point at the end.
    if (points.length > 1 && dist(points[0]!, points[points.length - 1]!) < 1e-9) {
      points = points.slice(0, -1);
    }
    if (points.length >= 3 && polygonArea(points) > 0.0) {
      profiles.push(points);
    }
  }
  return profiles;
}

/** Extracts the rotor outline polygon from DXF file bytes.
 *
 * Returns the largest-area closed polyline profile in modelspace, flattened
 * to straight segments. Coordinates are converted to mm using the drawing's
 * declared unit ($INSUNITS); drawings with no declaration are assumed mm
 * (rescale with {@link transformPolygon} when that assumption is wrong).
 */
export function polygonFromDxf(data: Uint8Array | string): Point[] {
  const doc = readDxfDocument(data);
  const [scale] = dxfUnitScaleToMm(doc);
  const profiles = closedProfilesFromEntities(doc.entities, FLATTEN_DISTANCE_MM / scale);
  if (profiles.length === 0) {
    const found = doc.entityTypeNames;
    throw new Error(
      "no closed polyline profile found in the DXF modelspace " +
        `(entities present: ${found.length ? found.join(", ") : "none"}). ` +
        "Join the cross-section outline into a single closed polyline " +
        "(PEDIT > Join in AutoCAD; 'export as polyline' in most CAD) and re-export.",
    );
  }
  let best = profiles[0]!;
  let bestArea = polygonArea(best);
  for (const p of profiles.slice(1)) {
    const a = polygonArea(p);
    if (a > bestArea) {
      best = p;
      bestArea = a;
    }
  }
  return best.map(([x, y]) => [x * scale, y * scale]);
}

/** Parses a two-column (r, z) point list in mm; comma or whitespace separated. */
export function polygonFromCsv(text: string): Point[] {
  const points: Point[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber++;
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("r") || lower.startsWith("x")) continue; // header row
    const tokens = line
      .replace(/,/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length < 2) {
      throw new Error(`line ${lineNumber}: expected two numeric columns, got '${rawLine}'`);
    }
    const r = Number(tokens[0]);
    const z = Number(tokens[1]);
    if (!Number.isFinite(r) || !Number.isFinite(z)) {
      throw new Error(`line ${lineNumber}: non-numeric value in '${rawLine}'`);
    }
    points.push([r, z]);
  }
  if (points.length < 3) {
    throw new Error("point list needs at least 3 (r, z) rows");
  }
  if (dist(points[0]!, points[points.length - 1]!) < 1e-9) {
    points.pop();
  }
  return points;
}

// ============================================================================
// Plan view (face drawing) reduction
// ============================================================================

function round(x: number, ndigits: number): number {
  const m = 10 ** ndigits;
  return Math.round(x * m) / m;
}

function flattenEntityForOutline(entity: DxfEntity, distance: number): Point[] {
  switch (entity.kind) {
    case "LINE":
      return [
        [entity.x1, entity.y1],
        [entity.x2, entity.y2],
      ];
    case "CIRCLE":
      return flattenArcDeg([entity.cx, entity.cy], entity.r, 0, 360, distance);
    case "ARC":
      return flattenArcDeg([entity.cx, entity.cy], entity.r, entity.startAngleDeg, entity.endAngleDeg, distance);
    case "LWPOLYLINE":
    case "POLYLINE":
      return flattenPolyline(entity.vertices, entity.closed, distance);
  }
}

/** Distances from the origin of sampled points along a LINE/ARC/CIRCLE/
 * polyline. Straight segments are sampled only at their two endpoints (they
 * are not subdivided -- their true closest approach to the origin can fall
 * strictly between the endpoints and is not captured; this mirrors
 * `ezdxf.path`'s LINE_TO handling exactly, and is the reason
 * `suggested_inner_diameter_mm` is documented as a starting value rather
 * than an exact figure). */
function sampleEntityRadii(entity: DxfEntity, flattenDistance: number): number[] {
  const points = flattenEntityForOutline(entity, flattenDistance);
  return points.map(([x, y]) => Math.hypot(x, y));
}

/** Reduces a rotor FACE drawing (plan view) to axisymmetric geometry.
 *
 * Expects: one large circle centered on the rotor axis (the OD), optional
 * rings of small identical circles (cross-drilling), and arbitrary
 * lines/arcs forming the inner profile. Hole circles are grouped by
 * (diameter, center radius); the innermost extent of the remaining geometry
 * becomes the suggested inner diameter.
 */
export function planViewFromDxf(data: Uint8Array | string): PlanViewGeometry {
  const doc = readDxfDocument(data);
  const [scale, unitName] = dxfUnitScaleToMm(doc);
  const flatten = FLATTEN_DISTANCE_MM / scale;

  const circles = doc.entities.filter((e): e is DxfCircleEntity => e.kind === "CIRCLE");
  if (circles.length === 0) {
    throw new Error(
      "no circles found in the DXF — a plan-view rotor drawing needs at " +
        "least the OD circle centered on the rotor axis",
    );
  }
  // OD: the largest circle whose center sits on (near) the rotor axis.
  const concentric = circles.filter((c) => Math.hypot(c.cx, c.cy) < 0.05 * c.r);
  if (concentric.length === 0) {
    throw new Error(
      "no circle centered on the origin found — draw (or move) the rotor " +
        "so its axis is at the drawing origin",
    );
  }
  const odCircle = concentric.reduce((a, b) => (b.r > a.r ? b : a));
  const rOuter = odCircle.r;

  // Group the remaining small circles into hole rings by (diameter, center r),
  // keeping every hole's true center for geometry-faithful displays.
  const groups = new Map<string, { dia: number; centerR: number; count: number }>();
  const holeCenters: [number, number, number][] = [];
  const holeEntities = new Set<DxfCircleEntity>();
  for (const c of circles) {
    if (c === odCircle) continue;
    const centerR = Math.hypot(c.cx, c.cy);
    if (c.r >= 0.3 * rOuter || centerR < 1e-6) continue; // concentric construction circle or oversized feature
    const dia = round(2.0 * c.r, 2);
    const cr = round(centerR, 1);
    const key = `${dia}|${cr}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
    } else {
      groups.set(key, { dia, centerR: cr, count: 1 });
    }
    holeCenters.push([c.cx, c.cy, c.r]);
    holeEntities.add(c);
  }
  const holeRings: HoleRing[] = Array.from(groups.values())
    .sort((a, b) => a.centerR - b.centerR)
    .map((g) => ({ count: g.count, hole_diameter_mm: g.dia, center_radius_mm: g.centerR }));

  // Non-hole linework (OD circle, inner profile arcs/lines) for overlays.
  const outlinePaths: Point[][] = [];
  for (const entity of doc.entities) {
    if (entity.kind === "CIRCLE" && holeEntities.has(entity)) continue;
    const points = flattenEntityForOutline(entity, flatten);
    if (points.length >= 2) outlinePaths.push(points);
  }

  // Inner-extent suggestion: closest approach to the axis of any line/arc
  // (and any concentric circle smaller than the OD).
  let minR: number | null = null;
  for (const entity of doc.entities) {
    if (entity.kind === "CIRCLE") {
      if (entity === odCircle) continue;
      const centerR = Math.hypot(entity.cx, entity.cy);
      if (centerR < 0.05 * entity.r) {
        // concentric ring (an ID circle)
        minR = minR === null ? entity.r : Math.min(minR, entity.r);
      }
      continue;
    }
    const radii = sampleEntityRadii(entity, flatten);
    if (radii.length) {
      const closest = Math.min(...radii);
      minR = minR === null ? closest : Math.min(minR, closest);
    }
  }
  const suggestedInner = minR !== null && minR < rOuter ? 2.0 * minR : null;

  const { slotLoops, innerBoundary } = closedFeatureLoops(doc.entities, flatten, LOOP_GAP_TOL_MM / scale);
  const plan: PlanViewGeometry = {
    outer_diameter_mm: 2.0 * rOuter,
    suggested_inner_diameter_mm: suggestedInner,
    hole_rings: holeRings,
    hole_centers_mm: holeCenters,
    outline_paths_mm: outlinePaths,
    slot_loops_mm: slotLoops,
    inner_boundary_mm: innerBoundary,
    detected_units: unitName,
  };
  return scalePlanView(plan, scale);
}

// ============================================================================
// Loose-edge loop chaining (slots + inner boundary contour)
// ============================================================================

interface RawEdge {
  id: number;
  start: Point;
  end: Point;
  length: number;
  entity: DxfEdgeEntity;
}

/** Builds `Edge`s from LINE/ARC entities, projected onto the xy-plane, and
 * discards degenerate ones (near-zero length). Ported from
 * `ezdxf.edgesmith.edges_from_entities_2d` / `make_edge_2d` / `_validate_edge`
 * for the LINE and ARC cases (ELLIPSE and SPLINE are not supported -- see
 * the module-level porting notes). */
function edgesFromEntities2d(entities: readonly DxfEdgeEntity[], gapTol: number): RawEdge[] {
  const edges: RawEdge[] = [];
  let nextId = 1;
  for (const e of entities) {
    let start: Point;
    let end: Point;
    let length: number;
    if (e.kind === "LINE") {
      start = [e.x1, e.y1];
      end = [e.x2, e.y2];
      length = dist(start, end);
    } else {
      const r = Math.abs(e.r);
      if (r < 1e-9) continue;
      const span = arcAngleSpanDeg(e.startAngleDeg, e.endAngleDeg);
      length = r * ((span * Math.PI) / 180);
      const sa = (e.startAngleDeg * Math.PI) / 180;
      const ea = (e.endAngleDeg * Math.PI) / 180;
      start = [e.cx + r * Math.cos(sa), e.cy + r * Math.sin(sa)];
      end = [e.cx + r * Math.cos(ea), e.cy + r * Math.sin(ea)];
    }
    if (dist(start, end) < gapTol) continue;
    if (length < gapTol) continue;
    edges.push({ id: nextId++, start, end, length, entity: e });
  }
  return edges;
}

interface DirectedEdge {
  edge: RawEdge;
  reversed: boolean;
}

function directedStart(d: DirectedEdge): Point {
  return d.reversed ? d.edge.end : d.edge.start;
}
function directedEnd(d: DirectedEdge): Point {
  return d.reversed ? d.edge.start : d.edge.end;
}

function loopKey(chain: readonly DirectedEdge[], reverse: boolean): string {
  const ids = (reverse ? [...chain].reverse() : chain).map((d) => d.edge.id);
  let minIdx = 0;
  for (let i = 1; i < ids.length; i++) if (ids[i]! < ids[minIdx]!) minIdx = i;
  return [...ids.slice(minIdx), ...ids.slice(0, minIdx)].join(",");
}

/** Safety cap on backtracking search steps: real rotor face drawings carry
 * at most a few dozen loose slot/profile entities (a handful of edges per
 * slot), for which this search completes in well under a millisecond. This
 * cap only guards against a degenerate/malformed input (e.g. thousands of
 * near-coincident tiny edges) turning into a hang; Python's equivalent
 * (`edgeminer.find_all_loops(..., timeout=10)`) keeps whatever loops it
 * already found and gives up on the rest, which is what happens here too. */
const LOOP_SEARCH_STEP_LIMIT = 200_000;

/** Finds every closed loop of edges with only degree-2 interior vertices.
 * Ported line-for-line from `ezdxf.edgeminer.LoopFinder.search` /
 * `find_all_loops`, minus the "pack degree-2 runs into one macro-edge"
 * performance optimization -- see the module-level porting notes for why
 * that doesn't change the result set. Returns `[]` (rather than throwing)
 * if the step budget above is exhausted, matching Python's "best effort"
 * TimeoutError handling in `_closed_feature_loops`. */
function findAllLoops(edges: readonly RawEdge[], gapTol: number): DirectedEdge[][] {
  if (edges.length < 2) return [];
  const solutions = new Map<string, DirectedEdge[]>();
  let steps = 0;
  let exhausted = false;

  const addSolution = (chain: DirectedEdge[]) => {
    const key = loopKey(chain, false);
    const keyRev = loopKey(chain, true);
    if (solutions.has(key) || solutions.has(keyRev)) return;
    solutions.set(key, chain);
  };

  const edgesLinkedTo = (point: Point, gapTol: number): RawEdge[] =>
    edges.filter((e) => dist(e.start, point) <= gapTol || dist(e.end, point) <= gapTol);

  const search = (startEdge: RawEdge, gapTol: number) => {
    const startPoint = startEdge.start;
    const todo: DirectedEdge[][] = [[{ edge: startEdge, reversed: false }]];
    while (todo.length > 0) {
      if (++steps > LOOP_SEARCH_STEP_LIMIT) {
        exhausted = true;
        return;
      }
      const chain = todo.pop()!;
      const lastEdge = chain[chain.length - 1]!;
      const endPoint = directedEnd(lastEdge);
      const chainIds = new Set(chain.map((d) => d.edge.id));
      const candidates = edgesLinkedTo(endPoint, gapTol).filter((e) => !chainIds.has(e.id));
      for (const edge of candidates) {
        const forward = dist(endPoint, edge.start) <= gapTol;
        const nextDirected: DirectedEdge = { edge, reversed: !forward };
        const lastPoint = directedEnd(nextDirected);
        if (dist(lastPoint, startPoint) <= gapTol) {
          addSolution([...chain, nextDirected]);
        } else if (!chain.some((d) => dist(lastPoint, directedEnd(d)) <= gapTol)) {
          todo.push([...chain, nextDirected]);
        }
      }
    }
  };

  for (const e of edges) {
    search(e, gapTol);
    if (exhausted) return Array.from(solutions.values());
  }
  return Array.from(solutions.values());
}

function flattenLoopEdgeEntity(entity: DxfEdgeEntity, distance: number): Point[] {
  if (entity.kind === "LINE") {
    return [
      [entity.x1, entity.y1],
      [entity.x2, entity.y2],
    ];
  }
  return flattenArcDeg([entity.cx, entity.cy], entity.r, entity.startAngleDeg, entity.endAngleDeg, distance);
}

/** Flattens a chain of directed edges into one continuous point sequence
 * (each edge's underlying entity geometry, oriented and joined). Ported from
 * `ezdxf.edgesmith.path2d_from_chain` + its subsequent `.flattening()` call. */
function path2dFromChain(loop: readonly DirectedEdge[], flattenDistance: number): Point[] {
  const points: Point[] = [];
  for (const d of loop) {
    let segPoints = flattenLoopEdgeEntity(d.edge.entity, flattenDistance);
    if (d.reversed) segPoints = [...segPoints].reverse();
    if (points.length > 0 && segPoints.length > 0) segPoints = segPoints.slice(1);
    points.push(...segPoints);
  }
  return points;
}

/** Tests if `point` is inside `polygon`. Returns +1 for inside, 0 for on the
 * boundary, -1 for outside. Supports convex and concave polygons with
 * clockwise or counter-clockwise vertex order. Ported from
 * `ezdxf.math._construct.is_point_in_polygon_2d`. */
function isPointInPolygon2d(point: Point, polygonIn: readonly Point[], absTol = 1e-10): number {
  let polygon = polygonIn;
  if (polygon.length < 3) return -1;
  if (dist(polygon[0]!, polygon[polygon.length - 1]!) < 1e-9) {
    polygon = polygon.slice(0, -1);
  }
  if (polygon.length < 3) return -1;
  const [x, y] = point;
  let inside = false;
  let [x1, y1] = polygon[polygon.length - 1]!;
  for (const [x2, y2] of polygon) {
    const [a, b] = x2 < x1 ? [x2, x1] : [x1, x2];
    if (a <= x && x <= b) {
      const [c, d] = y2 < y1 ? [y2, y1] : [y1, y2];
      if (c <= y && y <= d && Math.abs((y2 - y1) * x - (x2 - x1) * y + (x2 * y1 - y2 * x1)) <= absTol) {
        return 0;
      }
    }
    if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
      if (x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
    }
    x1 = x2;
    y1 = y2;
  }
  return inside ? 1 : -1;
}

/** Chains loose arcs/lines into closed loops: slots + the inner contour.
 *
 * Rotor face drawings rarely use closed polylines for slots -- straight
 * slots, curved slots, and J-hooks come through as disconnected ARC/LINE
 * entities. The loop-finding graph walk below reassembles them into closed
 * loops; the loop that encloses the drawing origin is the rotor's inner
 * boundary (the mounting-structure contour), every other loop is a void
 * feature. Closed LWPOLYLINE/POLYLINE slots are collected directly as well.
 */
function closedFeatureLoops(
  entities: readonly DxfEntity[],
  flattenDistance: number,
  gapTol: number,
): { slotLoops: Point[][]; innerBoundary: Point[] | null } {
  const loopsPoints: Point[][] = [];

  // Closed polyline features first (some CAD exports do close their slots).
  for (const entity of entities) {
    if ((entity.kind === "LWPOLYLINE" || entity.kind === "POLYLINE") && entity.closed) {
      const points = flattenPolyline(entity.vertices, true, flattenDistance);
      if (points.length >= 3) loopsPoints.push(points);
    }
  }

  // Loose arcs/lines chained into loops.
  const loose = entities.filter((e): e is DxfEdgeEntity => e.kind === "LINE" || e.kind === "ARC");
  if (loose.length > 0) {
    try {
      const edges = edgesFromEntities2d(loose, gapTol);
      if (edges.length >= 2) {
        for (const loop of findAllLoops(edges, gapTol)) {
          const points = path2dFromChain(loop, flattenDistance);
          if (points.length >= 3) loopsPoints.push(points);
        }
      }
    } catch {
      // keep whatever was found; features stay best-effort
    }
  }

  // Classify: the largest loop enclosing the origin is the inner boundary.
  let innerBoundary: Point[] | null = null;
  const slots: Point[][] = [];
  const origin: Point = [0.0, 0.0];
  for (const points of loopsPoints) {
    if (isPointInPolygon2d(origin, points) >= 0) {
      if (innerBoundary === null || polygonArea(points) > polygonArea(innerBoundary)) {
        if (innerBoundary !== null) slots.push(innerBoundary);
        innerBoundary = points;
      } else {
        slots.push(points);
      }
    } else {
      slots.push(points);
    }
  }
  return { slotLoops: slots, innerBoundary };
}

// ============================================================================
// Dispatch + fix-ups
// ============================================================================

const DWG_MESSAGE =
  "DWG is a proprietary binary format that cannot be read directly. " +
  "Export the cross-section as DXF from your CAD package " +
  "(File > Save As > DXF in AutoCAD/SolidWorks/Fusion) and upload that.";

/** Dispatches an uploaded drawing to the right interpretation.
 *
 * Returns `["section", polygonPoints]` when the file contains a closed
 * polyline cross-section, or `["plan", PlanViewGeometry]` when it looks
 * like a rotor face drawing (circles, no closed profile). CSV always means
 * a cross-section point list.
 */
export function geometryFromUpload(
  filename: string,
  data: Uint8Array | string,
): ["section", Point[]] | ["plan", PlanViewGeometry] {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith(".dwg")) {
    throw new Error(DWG_MESSAGE);
  }
  if (lowered.endsWith(".csv") || lowered.endsWith(".txt")) {
    const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
    return ["section", polygonFromCsv(text)];
  }
  if (!lowered.endsWith(".dxf")) {
    throw new Error(`unsupported file type '${filename}': upload .dxf, .csv, or .txt`);
  }
  try {
    return ["section", polygonFromDxf(data)];
  } catch {
    return ["plan", planViewFromDxf(data)];
  }
}

/** Dispatches on the uploaded file's extension. */
export function polygonFromUpload(filename: string, data: Uint8Array | string): Point[] {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith(".dwg")) {
    throw new Error(DWG_MESSAGE);
  }
  if (lowered.endsWith(".dxf")) {
    return polygonFromDxf(data);
  }
  if (lowered.endsWith(".csv") || lowered.endsWith(".txt")) {
    const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
    return polygonFromCsv(text);
  }
  throw new Error(`unsupported file type '${filename}': upload .dxf, .csv, or .txt`);
}

/** Fix-ups for drawings in other conventions: swap X/Y, unit scale (e.g.
 * 25.4 for a profile drawn in inches), and axis offsets (e.g. when the
 * profile was drawn with the rotation axis at the sketch origin elsewhere). */
export function transformPolygon(
  points: readonly Point[],
  swapAxes = false,
  scale = 1.0,
  radialOffsetMm = 0.0,
  axialOffsetMm = 0.0,
): Point[] {
  if (scale <= 0.0) {
    throw new Error("scale must be positive");
  }
  return points.map(([x, y]) => {
    const [r, z] = swapAxes ? [y, x] : [x, y];
    return [r * scale + radialOffsetMm, z * scale + axialOffsetMm] as Point;
  });
}
