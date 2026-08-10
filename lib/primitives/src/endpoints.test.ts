import test from "node:test";
import assert from "node:assert/strict";
import { AreaFamily } from "./areas.ts";
import { EdgeFamily, type EndpointFamily } from "./edges.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

/** The store the Core hands a family; each family gets its own. */

// An edge family joins two endpoint families, and either of them may be an area: a node contributes
// its position, an area its footprint centre. The area half is the real `AreaFamily` here, because
// the claim under test is that the centres it tessellates about are the objects an edge hangs off.
// It reaches Cesium only through the namespace it is handed, so no WebGL is involved.

class FakeCartesian3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static fromDegrees(lon: number, lat: number, height = 0) {
    return new FakeCartesian3(lon, lat, height);
  }
}

class FakePolyline {
  /** How often the follow reassigned this line's geometry, which is what `onFrame` does. */
  follows = -1;
  #positions: FakeCartesian3[] = [];
  get positions() {
    return this.#positions;
  }
  set positions(p: FakeCartesian3[]) {
    this.#positions = p;
    this.follows++;
  }
  width = 1;
  show = true;
  material: unknown;
  _material: unknown;
  constructor(opts: Record<string, unknown>) {
    Object.assign(this, opts);
    this._material = this.material;
  }
}

class FakePolylineCollection {
  readonly lines: FakePolyline[] = [];
  get length() {
    return this.lines.length;
  }
  add(opts: Record<string, unknown>) {
    const line = new FakePolyline(opts);
    this.lines.push(line);
    return line;
  }
  get(i: number) {
    return this.lines[i];
  }
  removeAll() {
    this.lines.length = 0;
  }
}

const C = {
  Cartesian3: FakeCartesian3,
  PolylineCollection: FakePolylineCollection,
  Color: class {
    static fromBytes(r: number, g: number, b: number, a: number) {
      return { r, g, b, a };
    }
  },
  Material: { fromType: (type: string) => ({ type, destroy() {} }) },
  // The footprint corners are irrelevant to the endpoint; only the centre they are placed about is.
  Transforms: { eastNorthUpToFixedFrame: (center: FakeCartesian3) => center },
  Matrix4: { multiplyByPoint: (enu: FakeCartesian3) => enu },
  PolygonHierarchy: class {},
  PolygonGeometry: class {},
  PolygonOutlineGeometry: class {},
  GeometryInstance: class {},
  ColorGeometryInstanceAttribute: { fromColor: (c: unknown) => c },
  ShowGeometryInstanceAttribute: class {},
  PerInstanceColorAppearance: class {},
  Primitive: class {
    ready = false;
  },
} as unknown as typeof import("@cesium/engine");

const scene = {
  primitives: { add: <T>(p: T) => p, remove: () => true },
} as unknown as import("@cesium/engine").Scene;

const window = (): WindowInfo =>
  ({ startFrame: 0, count: 1, id: 1, mode: "replace", totalFrames: 1, dtSeconds: 60,
     epoch: null as never });

/** Two satellites that move, which is all an edge reads of the family at its other end. */
const movingNodes = (): EndpointFamily => ({
  positions: [new FakeCartesian3(1, 1, 1), new FakeCartesian3(2, 2, 2)] as never[],
  moving: true,
});

/** Three footprints at (10,40), (11,41), (12,42), lifted 3 km. */
function cells(): AreaFamily {
  const family = new AreaFamily("cell", C, scene, (kind, idx) => ({ kind, idx }), new Timeline());
  family.onWindow({
    kind: "cell",
    center: { data: Float64Array.from([10, 40, 11, 41, 12, 42]), shape: [3, 2] },
    radius: 12000,
    sides: 6,
    heightM: 3000,
  }, window());
  return family;
}

test("an area family offers the centre it tessellated each footprint about", () => {
  const family = cells();
  assert.equal(family.positions.length, 3);
  assert.deepEqual(
    family.positions.map((p) => [p.x, p.y, p.z]),
    [[10, 40, 3000], [11, 41, 3000], [12, 42, 3000]],
    "the centre carries the height the footprint was lifted to",
  );
  assert.equal(family.moving, false, "footprints are tessellated once and never move");
});

test("an area family with nothing standing says so, rather than sizing arrays against no entities", () => {
  const family = new AreaFamily("cell", C, scene, (kind, idx) => ({ kind, idx }), new Timeline());
  // What an append carries for a family whose centres rode the replace this client never received.
  assert.throws(
    () => family.onWindow(
      { kind: "cell", color: { data: Float64Array.from([1, 2, 3, 4]), shape: [1, 4] } },
      { ...window(), mode: "append" }),
    /no footprint centres/,
  );
  // Once they are standing, a window that omits them is the ordinary streaming case.
  const standing = cells();
  standing.onWindow({ kind: "cell", show: { data: Uint8Array.from([1, 0, 1]), shape: [3] } },
                    { ...window(), mode: "append" });
});

test("an edge over an area endpoint resolves the centre, and it is the family's own object", () => {
  const areas = cells();
  const nodes = movingNodes();
  const win = window();
  const edges = new EdgeFamily("user", C, scene,
    (kind) => (kind === "cell" ? areas : nodes), (kind, idx) => ({ kind, idx }), new Timeline());
  edges.onWindow({
    kind: "user",
    from: "cell",
    to: "sat",
    // Cell 2 → satellite 0, cell 0 → satellite 1.
    pairs: { data: Uint32Array.from([2, 0, 0, 1]), shape: [2, 2] },
  }, win);
  edges.onKeyframe({ window: win, k: 0 });

  const ends = edges.endpointsOf(0)!;
  assert.equal(ends[0], areas.positions[2], "the very object the area holds, not a copy of it");
  assert.equal(ends[1], nodes.positions[0]);
  assert.deepEqual(edges.endpointsOf(1)![0], areas.positions[0]);
});

test("one moving end is enough to keep an edge following it", () => {
  const areas = cells();
  const follow = (to: EndpointFamily, ticks = 1) => {
    const collection: FakePolylineCollection[] = [];
    const scene2 = {
      primitives: { add: (p: FakePolylineCollection) => (collection.push(p), p), remove: () => true },
    } as unknown as import("@cesium/engine").Scene;
    const win = window();
    const edges = new EdgeFamily("user", C, scene2,
      (kind) => (kind === "cell" ? areas : to), (kind, idx) => ({ kind, idx }), new Timeline());
    edges.onWindow({
      kind: "user", from: "cell", to: "sat",
      pairs: { data: Uint32Array.from([0, 0]), shape: [1, 2] },
    }, win);
    edges.onKeyframe({ window: win, k: 0 });
    for (let i = 0; i < ticks; i++) edges.onFrame();
    return collection[0].lines[0].follows;
  };

  assert.equal(follow(movingNodes()), 1,
               "an edge from a standing area to a moving node still follows the node");
  assert.equal(follow(movingNodes(), 3), 3, "and it follows it on every tick");
  // Two standing ends owe one read all the same: a line is added against position objects the
  // node families fill on the tick after, so a rebuild is what makes the read due, not the motion.
  // Without it an edge between two standing families draws at the centre of the globe.
  assert.equal(follow({ positions: areas.positions, moving: false }), 1);
  assert.equal(follow({ positions: areas.positions, moving: false }, 3), 1,
               "and it is owed once per rebuild, not once per tick");
});
