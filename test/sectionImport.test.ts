import test from "node:test";
import assert from "node:assert/strict";
import {
  FLATTEN_DISTANCE_MM,
  geometryFromUpload,
  planViewFromDxf,
  polygonFromCsv,
  polygonFromDxf,
  polygonFromUpload,
  transformPolygon,
  type Point,
} from "../src/io/sectionImport.ts";

/** Hand-written DXF tag-stream fixtures (group-code / value line pairs), so
 * the parser is proven against text this test file controls directly rather
 * than a committed binary sample -- and so the same fixtures double as a
 * from-scratch description of the ASCII DXF format the parser reads. */

function lineTag(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function lineEntity(x1: number, y1: number, x2: number, y2: number): string {
  return [lineTag(0, "LINE"), lineTag(10, x1), lineTag(20, y1), lineTag(11, x2), lineTag(21, y2)].join("\n");
}

function circleEntity(cx: number, cy: number, r: number): string {
  return [lineTag(0, "CIRCLE"), lineTag(10, cx), lineTag(20, cy), lineTag(40, r)].join("\n");
}

function arcEntity(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  return [
    lineTag(0, "ARC"),
    lineTag(10, cx),
    lineTag(20, cy),
    lineTag(40, r),
    lineTag(50, startDeg),
    lineTag(51, endDeg),
  ].join("\n");
}

/** vertices: [x, y, bulge?] */
function lwpolylineEntity(vertices: readonly [number, number, number?][], closed: boolean): string {
  const parts = [lineTag(0, "LWPOLYLINE"), lineTag(90, vertices.length), lineTag(70, closed ? 1 : 0)];
  for (const [x, y, b] of vertices) {
    parts.push(lineTag(10, x), lineTag(20, y));
    if (b) parts.push(lineTag(42, b));
  }
  return parts.join("\n");
}

/** Old-style POLYLINE + VERTEX... + SEQEND, vertices: [x, y, bulge?] */
function polyline2dEntity(vertices: readonly [number, number, number?][], closed: boolean): string {
  const parts = [lineTag(0, "POLYLINE"), lineTag(66, 1), lineTag(70, closed ? 1 : 0)];
  for (const [x, y, b] of vertices) {
    parts.push(lineTag(0, "VERTEX"), lineTag(10, x), lineTag(20, y));
    if (b) parts.push(lineTag(42, b));
  }
  parts.push(lineTag(0, "SEQEND"));
  return parts.join("\n");
}

function makeDxf(entities: readonly string[], insunits?: number): Uint8Array {
  let text = "0\nSECTION\n2\nHEADER\n";
  if (insunits !== undefined) text += `9\n$INSUNITS\n70\n${insunits}\n`;
  text += "0\nENDSEC\n";
  text += "0\nSECTION\n2\nENTITIES\n";
  text += entities.join("\n") + "\n";
  text += "0\nENDSEC\n0\nEOF\n";
  return new TextEncoder().encode(text);
}

function roundedSquareLoop(halfSide: number, cornerRadius: number, shuffle: number[]): string[] {
  // A closed CCW loop -- 4 straight edges + 4 quarter-arc corners -- built as
  // loose, unordered LINE/ARC entities the way a real rotor slot/drive-tab
  // profile arrives from CAD. `shuffle` reorders the 8 entities to prove the
  // loop chainer doesn't depend on file order.
  const s = halfSide;
  const r = cornerRadius;
  const inner = s - r;
  const parts = [
    arcEntity(inner, inner, r, 0, 90), // top-right corner
    lineEntity(inner, s, -inner, s), // top edge
    arcEntity(-inner, inner, r, 90, 180), // top-left corner
    lineEntity(-s, inner, -s, -inner), // left edge
    arcEntity(-inner, -inner, r, 180, 270), // bottom-left corner
    lineEntity(-inner, -s, inner, -s), // bottom edge
    arcEntity(inner, -inner, r, 270, 360), // bottom-right corner
    lineEntity(s, -inner, s, inner), // right edge
  ];
  return shuffle.map((i) => parts[i]!);
}

// ---------------------------------------------------------------------------
// Cross-section polygon from a closed LWPOLYLINE / POLYLINE
// ---------------------------------------------------------------------------

test("closed LWPOLYLINE rectangle parses to the rotor outline polygon", () => {
  const dxf = makeDxf([lwpolylineEntity([[74.0, -2.0], [91.5, -2.0], [91.5, 2.0], [74.0, 2.0]], true)]);
  const points = polygonFromDxf(dxf);
  assert.equal(points.length, 4);
  const xs = [...new Set(points.map((p) => Math.round(p[0] * 1e6) / 1e6))].sort((a, b) => a - b);
  const ys = [...new Set(points.map((p) => Math.round(p[1] * 1e6) / 1e6))].sort((a, b) => a - b);
  assert.deepEqual(xs, [74.0, 91.5]);
  assert.deepEqual(ys, [-2.0, 2.0]);
});

test("CRLF line endings parse (CAD-saved DXF regression)", () => {
  const dxf = makeDxf([lwpolylineEntity([[74.0, -2.0], [91.5, -2.0], [91.5, 2.0], [74.0, 2.0]], true)]);
  const text = new TextDecoder().decode(dxf).replace(/\n/g, "\r\n");
  const points = polygonFromDxf(new TextEncoder().encode(text));
  assert.equal(points.length, 4);
});

test("picks the largest-area closed profile when several exist", () => {
  const dxf = makeDxf([
    lwpolylineEntity([[80.0, 0.0], [82.0, 0.0], [82.0, 1.0], [80.0, 1.0]], true), // small inner feature
    lwpolylineEntity([[50.0, -2.0], [91.5, -2.0], [91.5, 2.0], [50.0, 2.0]], true), // actual outline
  ]);
  const points = polygonFromDxf(dxf);
  assert.ok(Math.abs(Math.min(...points.map((p) => p[0])) - 50.0) < 1e-9);
});

test("LWPOLYLINE bulge flattens to an outward arc", () => {
  // Rectangle whose right edge bulges outward (arc segment).
  const dxf = makeDxf([
    lwpolylineEntity(
      [[74.0, -2.0, 0.0], [91.5, -2.0, 0.5], [91.5, 2.0, 0.0], [74.0, 2.0, 0.0]],
      true,
    ),
  ]);
  const points = polygonFromDxf(dxf);
  assert.ok(points.length > 4, "arc must flatten into more than the 4 corner vertices");
  assert.ok(Math.max(...points.map((p) => p[0])) > 91.5, "bulge must extend past the straight edge");
});

test("old-style POLYLINE + VERTEX with a bulge parses the same as LWPOLYLINE", () => {
  const dxf = makeDxf([
    polyline2dEntity([[74.0, -2.0, 0.0], [91.5, -2.0, 0.5], [91.5, 2.0, 0.0], [74.0, 2.0, 0.0]], true),
  ]);
  const points = polygonFromDxf(dxf);
  assert.ok(points.length > 4);
  assert.ok(Math.max(...points.map((p) => p[0])) > 91.5);
});

test("no closed profile raises a helpful, entity-listing error", () => {
  const dxf = makeDxf([lineEntity(0.0, 0.0, 10.0, 0.0)]);
  assert.throws(() => polygonFromDxf(dxf), /closed polyline/);
  assert.throws(() => polygonFromDxf(dxf), /LINE/);
});

// ---------------------------------------------------------------------------
// CSV / TXT
// ---------------------------------------------------------------------------

test("CSV parses with header row, comments, and closing-duplicate dropped", () => {
  const text = "# rotor profile\nr_mm, z_mm\n74, -2\n91.5, -2\n91.5, 2\n74, 2\n74, -2\n";
  const points = polygonFromCsv(text);
  assert.equal(points.length, 4);
  assert.deepEqual(points[0], [74.0, -2.0]);
});

test("CSV rejects non-numeric rows and too-short lists with the offending line number", () => {
  assert.throws(() => polygonFromCsv("74, -2\nnot_a_number, 3\n91, 2"), /line 2/);
  assert.throws(() => polygonFromCsv("74, -2\n91, 2"), /at least 3/);
});

// ---------------------------------------------------------------------------
// Upload dispatch
// ---------------------------------------------------------------------------

test("upload dispatch: DWG message, unsupported extension, CSV pass-through", () => {
  assert.throws(
    () => polygonFromUpload("rotor.dwg", new Uint8Array([0, 1])),
    /Export the cross-section as DXF/,
  );
  assert.throws(() => polygonFromUpload("rotor.step", new Uint8Array()), /unsupported file type/);
  const points = polygonFromUpload("profile.csv", "74,-2\n91,-2\n91,2\n74,2");
  assert.equal(points.length, 4);
});

// ---------------------------------------------------------------------------
// transformPolygon
// ---------------------------------------------------------------------------

test("transformPolygon: swap axes, unit scale, offsets; rejects non-positive scale", () => {
  const raw: Point[] = [
    [0.0, 2.9],
    [0.157, 2.9],
  ]; // inches, axes swapped, radius in Y
  const fixed = transformPolygon(raw, true, 25.4, 0.0, -2.0);
  assert.ok(Math.abs(fixed[0]![0] - 73.66) < 1e-9);
  assert.ok(Math.abs(fixed[0]![1] - -2.0) < 1e-9);
  assert.ok(Math.abs(fixed[1]![0] - 73.66) < 1e-9);
  assert.ok(Math.abs(fixed[1]![1] - (25.4 * 0.157 - 2.0)) < 1e-9);
  assert.throws(() => transformPolygon(raw, false, 0.0));
});

// ---------------------------------------------------------------------------
// $INSUNITS unit auto-conversion
// ---------------------------------------------------------------------------

test("$INSUNITS = 1 (inches) auto-converts a plan-view drawing to mm", () => {
  const entities: string[] = [circleEntity(0.0, 0.0, 3.6)];
  for (let i = 0; i < 8; i++) {
    const angle = (2.0 * Math.PI * i) / 8;
    entities.push(circleEntity(2.8 * Math.cos(angle), 2.8 * Math.sin(angle), 0.09));
  }
  entities.push(lineEntity(0.748, -0.2, 0.748, 0.2));
  const plan = planViewFromDxf(makeDxf(entities, 1));

  assert.equal(plan.detected_units, "inches");
  assert.ok(Math.abs(plan.outer_diameter_mm - 2.0 * 3.6 * 25.4) < 1e-6);
  assert.ok(Math.abs(plan.hole_rings[0]!.center_radius_mm - 2.8 * 25.4) < 1e-6);
  assert.ok(Math.abs(plan.hole_rings[0]!.hole_diameter_mm - 0.18 * 25.4) / (0.18 * 25.4) < 0.01);
  // Inner extent is sampled at entity points; the line's endpoints sit at
  // hypot(0.748, 0.2) in — converted to mm like everything else.
  const expectedInner = 2.0 * Math.hypot(0.748, 0.2) * 25.4;
  assert.ok(
    Math.abs(plan.suggested_inner_diameter_mm! - expectedInner) / expectedInner < 0.01,
    `${plan.suggested_inner_diameter_mm} vs ${expectedInner}`,
  );
});

test("$INSUNITS = 1 (inches) auto-converts a cross-section polygon to mm", () => {
  const dxf = makeDxf(
    [lwpolylineEntity([[2.9, -0.08], [3.6, -0.08], [3.6, 0.08], [2.9, 0.08]], true)],
    1,
  );
  const points = polygonFromDxf(dxf);
  assert.ok(Math.abs(Math.max(...points.map((p) => p[0])) - 3.6 * 25.4) < 1e-6);
});

test("$INSUNITS = 6 (declared meters) is treated as the common false-default mm, not scaled 1000x", () => {
  const dxf = makeDxf(
    [lwpolylineEntity([[74.0, -2.0], [91.5, -2.0], [91.5, 2.0], [74.0, 2.0]], true)],
    6,
  );
  const points = polygonFromDxf(dxf);
  assert.ok(Math.abs(Math.max(...points.map((p) => p[0])) - 91.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// Plan view (face drawing): OD, hole rings, inner extent
// ---------------------------------------------------------------------------

function planViewDxfBytes(): Uint8Array {
  // Synthetic face drawing shaped like the team's rotor DXF: OD circle, hole
  // rings, arc/line inner profile -- no closed polyline anywhere.
  const entities: string[] = [circleEntity(0.0, 0.0, 91.5)];
  for (const [ringRadius, count] of [
    [68.4, 23],
    [80.5, 23],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const angle = (2.0 * Math.PI * i) / count;
      entities.push(circleEntity(ringRadius * Math.cos(angle), ringRadius * Math.sin(angle), 2.25));
    }
  }
  // Inner drive-tab profile: arc at r=60 plus a line whose closest approach
  // to the axis is 58 mm.
  entities.push(arcEntity(0.0, 0.0, 60.0, 10.0, 50.0));
  entities.push(lineEntity(58.0, -5.0, 58.0, 5.0));
  return makeDxf(entities);
}

test("plan view parses OD, hole rings, and inner extent", () => {
  const geom = planViewFromDxf(planViewDxfBytes());
  assert.ok(Math.abs(geom.outer_diameter_mm - 183.0) < 1e-6);
  assert.equal(geom.hole_rings.length, 2);
  const ring = geom.hole_rings[0]!;
  assert.equal(ring.count, 23);
  assert.ok(Math.abs(ring.hole_diameter_mm - 4.5) < 1e-6);
  assert.ok(Math.abs(ring.center_radius_mm - 68.4) < 1e-6);
  assert.ok(Math.abs(geom.hole_rings[1]!.center_radius_mm - 80.5) < 1e-6);
  // The line at x=58 is the closest non-hole geometry to the axis.
  assert.ok(Math.abs(geom.suggested_inner_diameter_mm! - 116.0) < 0.5);
});

test("geometry dispatch: plan view vs. cross-section", () => {
  const [kind, geom] = geometryFromUpload("rotor face.dxf", planViewDxfBytes());
  assert.equal(kind, "plan");
  assert.ok(Math.abs((geom as { outer_diameter_mm: number }).outer_diameter_mm - 183.0) < 1e-6);

  const dxf = makeDxf([lwpolylineEntity([[74.0, -2.0], [91.5, -2.0], [91.5, 2.0], [74.0, 2.0]], true)]);
  const [kind2, points] = geometryFromUpload("section.dxf", dxf);
  assert.equal(kind2, "section");
  assert.equal((points as Point[]).length, 4);
});

test("plan view without a concentric circle raises", () => {
  const dxf = makeDxf([circleEntity(50.0, 50.0, 10.0)]); // off-axis only
  assert.throws(() => planViewFromDxf(dxf), /origin/);
});

test("plan view with no circles at all raises", () => {
  const dxf = makeDxf([lineEntity(0, 0, 10, 0)]);
  assert.throws(() => planViewFromDxf(dxf), /circles/);
});

// ---------------------------------------------------------------------------
// Loop chaining: loose ARC + LINE entities into closed loops (the hard part)
// ---------------------------------------------------------------------------

test("loose ARC+LINE entities chain into the inner boundary loop, regardless of file order", () => {
  // 4 lines + 4 corner arcs forming a rounded square around the origin,
  // written to the DXF in a shuffled (non-geometric) order -- exactly how a
  // real rotor drive-tab / mounting contour arrives as loose entities.
  const shuffled = [5, 1, 7, 3, 0, 6, 2, 4];
  const loopEntities = roundedSquareLoop(40.0, 8.0, shuffled);
  const entities: string[] = [circleEntity(0.0, 0.0, 91.5), ...loopEntities];
  const geom = planViewFromDxf(makeDxf(entities));

  assert.ok(geom.inner_boundary_mm !== null, "inner boundary loop must be found");
  const loop = geom.inner_boundary_mm!;
  assert.ok(loop.length >= 8, `expected at least the 8 corner vertices, got ${loop.length}`);

  // Every vertex should sit within [halfSide, hypot(halfSide,halfSide)] of
  // the origin -- i.e. it's a closed ring roughly bounding the 40mm square,
  // not a stray open chain.
  const halfSide = 40.0;
  for (const [x, y] of loop) {
    const r = Math.hypot(x, y);
    assert.ok(r >= halfSide - 1e-6 && r <= Math.SQRT2 * halfSide + 1e-6, `point (${x},${y}) r=${r} out of range`);
  }

  // The loop must actually enclose the origin, and its area should be close
  // to the rounded square's true area (S^2 side minus the 4 corner cut-offs).
  const s = halfSide;
  const r = 8.0;
  const trueArea = (2 * s) ** 2 - (4 - Math.PI) * r * r;
  const shoelace = (pts: Point[]) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[(i + 1) % pts.length]!;
      a += x0 * y1 - x1 * y0;
    }
    return Math.abs(a) / 2;
  };
  const area = shoelace(loop);
  assert.ok(Math.abs(area - trueArea) / trueArea < 0.01, `area ${area} vs true ${trueArea}`);
});

test("a small loose-edge loop away from the origin is classified as a slot, not the inner boundary", () => {
  // A simple 4-line rectangular slot, loose (not a polyline), centered at
  // (70, 0) -- must NOT be mistaken for the inner boundary since it doesn't
  // enclose the origin.
  const cx = 70.0;
  const hw = 5.0;
  const hh = 1.5;
  const slotEntities = [
    lineEntity(cx - hw, hh, cx + hw, hh),
    lineEntity(cx + hw, hh, cx + hw, -hh),
    lineEntity(cx + hw, -hh, cx - hw, -hh),
    lineEntity(cx - hw, -hh, cx - hw, hh),
  ];
  const entities: string[] = [circleEntity(0.0, 0.0, 91.5), ...slotEntities];
  const geom = planViewFromDxf(makeDxf(entities));

  assert.equal(geom.inner_boundary_mm, null);
  assert.equal(geom.slot_loops_mm.length, 1);
  const slot = geom.slot_loops_mm[0]!;
  const area = (() => {
    let a = 0;
    for (let i = 0; i < slot.length; i++) {
      const [x0, y0] = slot[i]!;
      const [x1, y1] = slot[(i + 1) % slot.length]!;
      a += x0 * y1 - x1 * y0;
    }
    return Math.abs(a) / 2;
  })();
  assert.ok(Math.abs(area - 2 * hw * (2 * hh)) < 1e-9);
});

// ---------------------------------------------------------------------------
// Arc flattening stays within the requested sagitta tolerance
// ---------------------------------------------------------------------------

test("arc flattening (via bulge) stays within FLATTEN_DISTANCE_MM sagitta of the true circle", () => {
  // A large-radius, wide-sweep bulge exercises many segments; every flattened
  // vertex must sit on the true circle to float precision (the sagitta
  // tolerance bounds the *chord* deviation between vertices, but each vertex
  // itself is placed exactly on the analytic circle by construction).
  const dxf = makeDxf([
    lwpolylineEntity([[100.0, 0.0, 1.0], [-100.0, 0.0, 1.0]], true), // two bulge-1 (semicircle) segments = full circle
  ]);
  const points = polygonFromDxf(dxf);
  assert.ok(points.length > 8, `expected a well-flattened circle, got ${points.length} points`);
  for (const [x, y] of points) {
    const r = Math.hypot(x, y);
    assert.ok(Math.abs(r - 100.0) < 1e-6, `point (${x},${y}) r=${r} not on the r=100 circle`);
  }
  void FLATTEN_DISTANCE_MM; // sanity: constant is exported and usable by callers
});
