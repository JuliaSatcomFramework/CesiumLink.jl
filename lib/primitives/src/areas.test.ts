import test from "node:test";
import assert from "node:assert/strict";
import { AreaFamily, DEFAULT_RADIUS, DRAPE_SPAN_DEG, spanDegrees } from "./areas.ts";
import type { NdArray } from "../../core/src/codec.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

/** The store the Core hands a family; each family gets its own. */

// What a family does with the rings it is given. The claim under test is that a supplied boundary
// reaches Cesium as the hierarchy it describes — the outer ring, then one hole per ring after it —
// so the fill, the outline and the pick id are the ones the regular footprint path already builds.
// Cesium is reached only through the namespace the family is handed, so no WebGL is involved.

class FakeCartesian3 {
  lon: number;
  lat: number;
  height: number;
  constructor(lon = 0, lat = 0, height = 0) {
    this.lon = lon;
    this.lat = lat;
    this.height = height;
  }
  static fromDegrees(lon: number, lat: number, height = 0) {
    return new FakeCartesian3(lon, lat, height);
  }
}

class FakePolygonHierarchy {
  positions: FakeCartesian3[];
  holes: FakePolygonHierarchy[];
  constructor(positions: FakeCartesian3[] = [], holes: FakePolygonHierarchy[] = []) {
    this.positions = positions;
    this.holes = holes;
  }
}

class FakePolygonGeometry {
  polygonHierarchy!: FakePolygonHierarchy;
  constructor(opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }
}

class FakeInstance {
  geometry!: FakePolygonGeometry;
  id!: { kind: string; idx: number };
  constructor(opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }
}

class FakePrimitive {
  ready = false;
  geometryInstances!: FakeInstance[];
  constructor(opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }
}

const C = {
  Cartesian3: FakeCartesian3,
  Color: class {
    static fromBytes(r: number, g: number, b: number, a: number) {
      return { r, g, b, a };
    }
  },
  Transforms: { eastNorthUpToFixedFrame: (center: FakeCartesian3) => center },
  Matrix4: { multiplyByPoint: (enu: FakeCartesian3) => enu },
  PolygonHierarchy: FakePolygonHierarchy,
  PolygonGeometry: FakePolygonGeometry,
  PolygonOutlineGeometry: FakePolygonGeometry,
  GeometryInstance: FakeInstance,
  ColorGeometryInstanceAttribute: { fromColor: (c: unknown) => c },
  ShowGeometryInstanceAttribute: class {},
  PerInstanceColorAppearance: class {},
  Primitive: FakePrimitive,
} as unknown as typeof import("@cesium/engine");

/** The primitives a family added, in the order it added them, so a rebuild is countable. */
function stage() {
  const added: FakePrimitive[] = [];
  const scene = {
    primitives: { add: (p: FakePrimitive) => (added.push(p), p), remove: () => true },
  } as unknown as import("@cesium/engine").Scene;
  const family = new AreaFamily("region", C, scene, (kind, idx) => ({ kind, idx }), new Timeline());
  return { added, family };
}

const window = (): WindowInfo =>
  ({ startFrame: 0, count: 1, id: 1, mode: "replace", totalFrames: 1, dtSeconds: 60,
     epoch: null as never });

/** A `2 x V` ring of degrees, as the wire delivers one: row-major, so the shape is reversed. */
const ring = (...lonlat: number[]): NdArray =>
  ({ data: Float64Array.from(lonlat), shape: [lonlat.length / 2, 2] });

const extent = (...box: number[]): NdArray =>
  ({ data: Float64Array.from(box), shape: [box.length / 4, 4] });

// A square with a square hole in it, and a triangle beside it: two regions of different vertex
// counts, which is the ragged case a computed footprint never has.
const SQUARE = ring(0, 0, 10, 0, 10, 10, 0, 10);
const HOLE = ring(4, 4, 6, 4, 6, 6, 4, 6);
const TRIANGLE = ring(20, 0, 30, 0, 25, 10);
const BOXES = extent(0, 10, 0, 10, 20, 30, 0, 10);

test("a region is drawn from the rings it is given, holes and all", () => {
  const { added, family } = stage();
  family.onWindow({
    kind: "region",
    boundary: [[SQUARE, HOLE], [TRIANGLE]],
    extent: BOXES,
    heightM: 3000,
  }, window());

  const instances = added[0].geometryInstances;
  assert.equal(instances.length, 2, "one instance per region, whatever its vertex count");

  const first = instances[0].geometry.polygonHierarchy;
  assert.deepEqual(first.positions.map((p) => [p.lon, p.lat, p.height]),
                   [[0, 0, 3000], [10, 0, 3000], [10, 10, 3000], [0, 10, 3000]],
                   "the outer ring, lifted to the family's height");
  assert.equal(first.holes.length, 1, "every ring after the first is a hole");
  assert.deepEqual(first.holes[0].positions.map((p) => [p.lon, p.lat]),
                   [[4, 4], [6, 4], [6, 6], [4, 6]]);

  const second = instances[1].geometry.polygonHierarchy;
  assert.equal(second.positions.length, 3);
  assert.equal(second.holes.length, 0);

  // The pick id is the one an area family has always stamped, so Julia answers a hover on region i
  // exactly as it answers one on footprint i.
  assert.deepEqual(instances.map((g) => g.id), [{ kind: "region", idx: 0 }, { kind: "region", idx: 1 }]);
});

test("an edge hanging off a region joins the middle of its extent", () => {
  const { family } = stage();
  family.onWindow({ kind: "region", boundary: [[SQUARE, HOLE], [TRIANGLE]], extent: BOXES }, window());
  assert.deepEqual(family.positions.map((p) => [p.lon, p.lat]), [[5, 5], [25, 5]]);
});

test("a repeated boundary leaves the tessellation standing, and a changed one rebuilds it", () => {
  const { added, family } = stage();
  const send = (boundary: NdArray[][]) =>
    family.onWindow({ kind: "region", boundary, extent: BOXES }, window());

  send([[SQUARE, HOLE], [TRIANGLE]]);
  send([[SQUARE, HOLE], [TRIANGLE]]);
  assert.equal(added.length, 1, "the same rings twice re-tessellate nothing");

  // A ring of the same vertex count, moved: the digest reads the coordinates, not just the shape.
  send([[SQUARE, HOLE], [ring(20, 0, 30, 0, 25, 20)]]);
  assert.equal(added.length, 2);
  // And one that loses its hole.
  send([[SQUARE], [ring(20, 0, 30, 0, 25, 20)]]);
  assert.equal(added.length, 3);
});

test("a height per entity lifts each footprint on its own, and a changed one re-tessellates", () => {
  const { added, family } = stage();
  const send = (heightM: unknown) =>
    family.onWindow({ kind: "region", boundary: [[SQUARE, HOLE], [TRIANGLE]], extent: BOXES,
                      heightM }, window());

  send({ data: Float64Array.from([3000, 9000]), shape: [2] });
  const instances = added[0].geometryInstances;
  const heightsOf = (i: number) =>
    instances[i].geometry.polygonHierarchy.positions.map((p) => p.height);
  assert.deepEqual(heightsOf(0), [3000, 3000, 3000, 3000], "the first region takes the first height");
  assert.deepEqual(instances[0].geometry.polygonHierarchy.holes[0].positions.map((p) => p.height),
                   [3000, 3000, 3000, 3000], "and its hole is lifted with it");
  assert.deepEqual(heightsOf(1), [9000, 9000, 9000], "the second takes the second");
  // Both regions span 10°, so both follow the globe and read one height for the whole surface.
  const surface = (i: number) =>
    (instances[i].geometry as unknown as Record<string, unknown>).height;
  assert.deepEqual([surface(0), surface(1)], [3000, 9000]);

  send({ data: Float64Array.from([3000, 9000]), shape: [2] });
  assert.equal(added.length, 1, "the same heights twice re-tessellate nothing");
  send({ data: Float64Array.from([3000, 4000]), shape: [2] });
  assert.equal(added.length, 2, "a height is a vertex coordinate, so a changed one rebuilds");
});

// How a footprint meets the globe. A polygon built from its vertices exactly is a flat plane
// chording the ellipsoid, which is right for a hexagon and buries the middle of a continent.

/** What a built instance says about tessellation: exact vertices, or a surface Cesium subdivides. */
const shapeOf = (added: FakePrimitive[], at = 0) => {
  const g = added[at].geometryInstances[0].geometry as unknown as Record<string, unknown>;
  return { perPositionHeight: g.perPositionHeight, height: g.height, granularity: g.granularity };
};

const CELL = ring(12.5, 41.9);
const TINY = ring(0, 0, 0.1, 0, 0.1, 0.1);
const TINY_BOX = extent(0, 0.1, 0, 0.1);

test("a hexagon footprint stays far below the span that makes a polygon follow the globe", () => {
  // Both numbers move independently, and crossing them re-tessellates every footprint in the scene.
  assert.ok(spanDegrees(DEFAULT_RADIUS) * 20 < DRAPE_SPAN_DEG,
            `a ${DEFAULT_RADIUS} m footprint spans ${spanDegrees(DEFAULT_RADIUS)}°, against a ` +
            `${DRAPE_SPAN_DEG}° threshold`);
});

test("a footprint follows the globe when it spans enough of one to sag visibly", () => {
  const small = stage();
  const black: NdArray = { data: Uint8Array.from([0, 0, 0, 255]), shape: [4] };
  small.family.onWindow({ kind: "region", center: CELL, outline: black }, window());
  assert.deepEqual(shapeOf(small.added),
                   { perPositionHeight: true, height: undefined, granularity: undefined },
                   "a hexagon keeps the corners it was computed with");
  // The outline is a second primitive and must chord or follow with the fill, or it floats off it.
  assert.deepEqual(shapeOf(small.added, 1).perPositionHeight, true);

  const big = stage();
  big.family.onWindow({ kind: "region", boundary: [[SQUARE]], extent: extent(0, 10, 0, 10),
                        heightM: 3000 }, window());
  const shape = shapeOf(big.added);
  assert.equal(shape.perPositionHeight, undefined, "a 10° region is subdivided across the globe");
  assert.equal(shape.height, 3000, "and takes one height for the whole surface");
  assert.ok((shape.granularity as number) > 0);
  // How finely a polygon drapes is a different question from whether it drapes, and tying the two
  // together meshes a continent as finely as a hexagon: millions of triangles for sag no screen can
  // show.
  assert.notEqual(shape.granularity, (DRAPE_SPAN_DEG * Math.PI) / 180,
                  "the mesh cell must not be derived from the drape threshold");
});

test("the caller sets the mesh cell, and changing it re-tessellates", () => {
  const s = stage();
  const region = (meshDeg?: number) =>
    ({ kind: "region", boundary: [[SQUARE]], extent: extent(0, 10, 0, 10), meshDeg });
  const cell = () => shapeOf(s.added, s.added.length - 1).granularity as number;
  s.family.onWindow(region(), window());
  const byDefault = cell();

  s.family.onWindow(region(0.25), window());
  assert.equal(cell(), (0.25 * Math.PI) / 180, "the caller's cell is used");
  assert.notEqual(cell(), byDefault);

  // The cell is how the geometry is made, so it belongs in the rebuild key beside `drape`. A window
  // that changes it and repeats the same rings must re-tessellate rather than stand.
  const before = s.added.length;
  s.family.onWindow(region(2), window());
  assert.ok(s.added.length > before, "a changed mesh cell rebuilds the geometry");
  assert.equal(cell(), (2 * Math.PI) / 180);
});

test("drape decides it instead, whichever way the span would have gone", () => {
  const forced = stage();
  forced.family.onWindow({ kind: "region", center: CELL, drape: true }, window());
  assert.equal(shapeOf(forced.added).perPositionHeight, undefined);

  const flat = stage();
  flat.family.onWindow({ kind: "region", boundary: [[SQUARE]], extent: extent(0, 10, 0, 10),
                         drape: false }, window());
  assert.equal(shapeOf(flat.added).perPositionHeight, true);
});

test("each region is decided on its own span, and a changed drape re-tessellates", () => {
  const { added, family } = stage();
  family.onWindow({ kind: "region", boundary: [[SQUARE], [TINY]],
                    extent: extent(0, 10, 0, 10, 0, 0.1, 0, 0.1) }, window());
  const [wide, narrow] = added[0].geometryInstances.map(
    (g) => (g.geometry as unknown as Record<string, unknown>).perPositionHeight);
  assert.equal(wide, undefined);
  assert.equal(narrow, true);

  family.onWindow({ kind: "region", boundary: [[TINY]], extent: TINY_BOX }, window());
  family.onWindow({ kind: "region", boundary: [[TINY]], extent: TINY_BOX, drape: true }, window());
  assert.equal(added.length, 3, "the same rings drawn a different way are a different tessellation");
});

test("an area family with nothing standing says so, whichever geometry it was owed", () => {
  const { family } = stage();
  assert.throws(
    () => family.onWindow({ kind: "region", color: { data: Float64Array.from([1, 2, 3, 4]), shape: [1, 4] } },
                          { ...window(), mode: "append" }),
    /no boundary/,
  );
  family.onWindow({ kind: "region", boundary: [[SQUARE]], extent: extent(0, 10, 0, 10) }, window());
  // Once the regions stand, a window that omits them only recolours them.
  family.onWindow({ kind: "region", show: { data: Uint8Array.from([1]), shape: [1] } },
                  { ...window(), mode: "append" });
});
