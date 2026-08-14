import test from "node:test";
import assert from "node:assert/strict";
import type { AnchorResolver } from "../../core/src/camera.ts";
import type { ModuleContext } from "../../core/src/module-host.ts";
import { windowCoverage } from "../../core/src/testing.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

// `positionOf` is what a float anchored to an entity resolves through, so it has to answer for every
// kind of family the renderer draws — a node, an area and an edge alike. The families here are the
// real ones, reaching Cesium only through the namespace they are handed, so what is under test is
// the whole path from a delivered window to the position an anchor lands on.

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
  static midpoint(a: FakeCartesian3, b: FakeCartesian3, result: FakeCartesian3) {
    result.x = (a.x + b.x) / 2;
    result.y = (a.y + b.y) / 2;
    result.z = (a.z + b.z) / 2;
    return result;
  }
}

class FakeCollection {
  readonly items: Record<string, unknown>[] = [];
  get length() {
    return this.items.length;
  }
  add(opts: Record<string, unknown>) {
    this.items.push({ ...opts });
    return this.items[this.items.length - 1];
  }
  get(i: number) {
    return this.items[i];
  }
  removeAll() {
    this.items.length = 0;
  }
}

const C = {
  Cartesian3: FakeCartesian3,
  Color: class {
    static fromBytes(r: number, g: number, b: number, a: number) {
      return { r, g, b, a };
    }
  },
  Material: { fromType: (type: string) => ({ type, destroy() {} }) },
  BillboardCollection: FakeCollection,
  PolylineCollection: FakeCollection,
  // The footprint corners say nothing about where the anchor lands; only the centre does.
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

// The marker glyphs are drawn onto a canvas once, which is the only thing here that wants a DOM.
(globalThis as Record<string, unknown>).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }),
  }),
};

const { default: primitives, positionOf, countOf, edgeEndpoints, pickIdOf, showOf } =
  await import("./index.ts");

/** Two keyframes of a satellite travelling from the origin to x = 100, and three standing cells. */
const SCENE = {
  nodes: [{
    kind: "sat",
    position: { data: Float64Array.from([0, 0, 0, 100, 0, 0]), shape: [2, 1, 3] },
  }],
  areas: [{
    kind: "cell",
    center: { data: Float64Array.from([10, 40, 11, 41, 12, 42]), shape: [3, 2] },
    radius: 12000,
    heightM: 3000,
  }],
  edges: [{
    kind: "link",
    from: "cell",
    to: "sat",
    // Cell 1 → satellite 0, the only link in the family.
    pairs: { data: Uint32Array.from([1, 0]), shape: [1, 2] },
  }],
};

const window = (): WindowInfo =>
  ({ startFrame: 0, count: 2, id: 1, mode: "replace", totalFrames: 2, dtSeconds: 60,
     epoch: null as never });

/** The same scene under a mask: the satellite hidden, and the middle cell of the three. */
const MASKED = {
  nodes: [{ ...SCENE.nodes[0], show: { data: Uint8Array.from([0]), shape: [1] } }],
  areas: [{ ...SCENE.areas[0], show: { data: Uint8Array.from([1, 0, 1]), shape: [3] } }],
  edges: SCENE.edges,
};

/** The module set up against a viewer that records nothing but lets a window and a tick through. */
function viewer(scene: unknown = SCENE) {
  const windows: ((w: WindowInfo, payload: unknown) => void)[] = [];
  const frames: ((f: { index: number; alpha: number }) => void)[] = [];
  const keyframe: ((index: number) => void)[] = [];
  const covers = windowCoverage();
  const resolvers: AnchorResolver[] = [];
  const ctx = {
    anchors: (resolve: AnchorResolver) => (resolvers.push(resolve), () => {}),
    Cesium: C,
    scene: { primitives: { add: <T>(p: T) => p, remove: () => true } },
    frame: null,
    pickId: (kind: string, idx: number) => ({ kind, idx }),
    onWindow: (cb: (w: WindowInfo, payload: unknown) => void) => (windows.push(cb), () => {}),
    onKeyframe: (cb: (index: number) => void) => (keyframe.push(cb), () => {}),
    placement: covers.placement,
    onFrame: (cb: (f: { index: number; alpha: number }) => void) => (frames.push(cb), () => {}),
    perWindow: <T>() => new Timeline<T>(),
  } as unknown as ModuleContext;
  const teardown = primitives.setup(ctx);
  const info = window();
  covers.deliver(info);
  /** Deliver a window. A second one replaces the first, so a family it does not name is pruned. */
  const deliver = (payload: unknown) => {
    for (const cb of windows) cb(info, payload);
    // The Core's own guarantee, modelled: a replace fires a crossing at the index the clock is on.
    for (const cb of keyframe) cb(info.startFrame);
  };
  deliver(scene);
  return {
    /** Blend the satellite `alpha` of the way from the first keyframe to the second. */
    tick: (alpha: number) => {
      for (const cb of frames) cb({ index: 0, alpha });
    },
    deliver,
    /** Ask this module for a ride, the way the Core asks when a viewpoint applies. */
    anchor: (target: string) => resolvers[0](target),
    teardown,
  };
}

const xyz = (p: { x: number; y: number; z: number } | undefined) => p && [p.x, p.y, p.z];

test("an anchor resolves against a node, an area and an edge family alike", () => {
  const v = viewer();
  v.tick(0);

  assert.deepEqual(xyz(positionOf("sat", 0)), [0, 0, 0]);
  assert.deepEqual(xyz(positionOf("cell", 1)), [11, 41, 3000],
                   "an area answers with the centre its footprint stands on");
  assert.deepEqual(xyz(positionOf("link", 0)), [5.5, 20.5, 1500],
                   "and an edge with the midpoint of the link, so a float on a link sits on it");
  v.teardown();
});

test("an area anchor is the family's own position, not a copy taken once", () => {
  const v = viewer();
  const first = positionOf("cell", 1);
  assert.equal(first, positionOf("cell", 1), "the same object every time it is asked");
  assert.equal(first, edgeEndpoints("link", 0)![0],
               "and the very object the edge over that cell hangs off");

  // What moving a position does: the anchor follows because it is that object, not a copy of it.
  (first as { x: number }).x = 99;
  assert.deepEqual(xyz(positionOf("cell", 1)), [99, 41, 3000]);
  v.teardown();
});

test("an edge anchor follows its ends between keyframes rather than standing where it was", () => {
  const v = viewer();
  v.tick(0);
  assert.deepEqual(xyz(positionOf("link", 0)), [5.5, 20.5, 1500]);
  v.tick(0.5);
  assert.deepEqual(xyz(positionOf("sat", 0)), [50, 0, 0], "the satellite is halfway across");
  assert.deepEqual(xyz(positionOf("link", 0)), [30.5, 20.5, 1500],
                   "and the midpoint is recomputed from where its ends are now");
  v.teardown();
});

test("a kind nothing owns resolves to nothing, and so does an index nobody has", () => {
  const v = viewer();
  v.tick(0);
  assert.equal(positionOf("nobody", 0), undefined);
  assert.equal(positionOf("cell", 3), undefined, "one past the last footprint");
  assert.equal(positionOf("sat", 7), undefined);
  assert.equal(positionOf("link", 1), undefined, "one past the only edge");
  v.teardown();
  assert.equal(positionOf("cell", 1), undefined, "and nothing at all once the module is unloaded");
});

// `pickIdOf` and `showOf` are the other half of the anchor surface: a module drawing a model or a
// sensor cone over a satellite borrows the satellite's identity, so one click reports one entity.
// The stamp is whatever `ctx.pickId` minted for the family — this fake makes it `{kind, idx}` — and
// what matters is that the very object the family stamped its primitive with comes back.

test("an anchor borrows the stamp the family put on its own primitive", () => {
  const v = viewer();
  const sat = pickIdOf("sat", 0);
  assert.deepEqual(sat, { kind: "sat", idx: 0 },
                   "the satellite's own stamp, for a model drawn over it to set as its id");
  assert.equal(pickIdOf("sat", 0), sat, "the same object every time, never a fresh lookalike");
  assert.deepEqual(pickIdOf("cell", 2), { kind: "cell", idx: 2 },
                   "and an area family answers the same way");
  v.teardown();
});

test("an anchor reads whether its entity is drawn, so it can hide with it", () => {
  const v = viewer();
  assert.equal(showOf("sat", 0), true, "a family under no mask draws every entity");
  assert.equal(showOf("cell", 1), true);
  v.teardown();

  const masked = viewer(MASKED);
  assert.equal(showOf("sat", 0), false, "the satellite is masked, so anything anchored to it hides");
  assert.deepEqual([showOf("cell", 0), showOf("cell", 1), showOf("cell", 2)], [true, false, true],
                   "and an area mask is read per entity");
  assert.deepEqual(pickIdOf("sat", 0), { kind: "sat", idx: 0 },
                   "a masked entity keeps its index and its stamp — a mask is not a removal");
  masked.teardown();
});

// A camera rides an entity of this module by name, and the name is one kind and one index. The two
// tests below are about that name; the rest are about what it resolves to.

test("the entity a click reports, written as a target, rides that same entity", () => {
  const v = viewer();
  v.tick(0);

  // The stamp a family puts on its own primitive carries the index the wire carries, counted from
  // 0. `from_wire_index` adds one on the way into a Julia listener, so the author who builds a
  // target out of `ev.entity.idx` counts from 1. The round trip has to land on the entity clicked.
  const clicked = pickIdOf("cell", 1) as { kind: string; idx: number };
  const at = v.anchor(`${clicked.kind}[${clicked.idx + 1}]`);

  assert.ok(at, "the target an author builds out of a pointer event resolves");
  assert.equal(at(), positionOf("cell", clicked.idx),
               "and rides the very position of the entity clicked, not the one beside it");

  // What the base guards against: read as a 0-based index the same number is the next footprint
  // along, and it is a real footprint, so nothing else in this file would notice.
  assert.deepEqual(xyz(v.anchor(`cell[${clicked.idx}]`)!()), [10, 40, 3000],
                   "cell[1] is the first footprint, so cell[2] is the one this click reported");
  v.teardown();
});

test("a target this module cannot answer for resolves to nothing", () => {
  const v = viewer();
  v.tick(0);
  assert.equal(v.anchor("sat"), null, "a kind with no index");
  assert.equal(v.anchor("sat[]"), null);
  assert.equal(v.anchor("sat[one]"), null);
  assert.equal(v.anchor("sat[0]"), null, "counting starts at 1, so nothing is entity zero");
  assert.equal(v.anchor("nobody[1]"), null, "a kind no family owns");
  assert.equal(v.anchor("cell[4]"), null, "one past the last footprint");
  v.teardown();
  assert.equal(v.anchor("sat[1]"), null, "and nothing at all once the module is unloaded");
});

test("a ride reads where the entity is now, not where it stood when the camera mounted", () => {
  const v = viewer();
  v.tick(0);
  const at = v.anchor("sat[1]")!;
  assert.deepEqual(xyz(at()), [0, 0, 0]);
  v.tick(0.5);
  assert.deepEqual(xyz(at()), [50, 0, 0], "the same getter, and the satellite has moved");
  assert.deepEqual(xyz(v.anchor("link[1]")!()), [30.5, 20.5, 1500],
                   "and a camera rides the midpoint of a link, recomputed for every call");
  v.teardown();
});

test("a ride answers nothing once a window prunes the family under it, and never throws", () => {
  const v = viewer();
  v.tick(0);
  const at = v.anchor("sat[1]")!;
  assert.ok(at(), "riding the satellite while the satellite is drawn");

  // A replacing window that names no satellites: the family has no author left, so it goes. The
  // getter says so, and the Core lets the camera go.
  v.deliver({ areas: SCENE.areas });
  assert.equal(at(), null);
  assert.equal(v.anchor("sat[1]"), null, "and the name cannot be taken up again");
  v.teardown();
});

test("the anchor surface answers nothing for a kind, an index or a family that is gone", () => {
  const v = viewer();
  assert.equal(pickIdOf("nobody", 0), undefined);
  assert.equal(showOf("nobody", 0), undefined);
  assert.equal(pickIdOf("sat", 7), undefined, "an index the family does not have");
  assert.equal(showOf("cell", 3), undefined, "one past the last footprint");
  assert.equal(pickIdOf("link", 0), undefined,
               "an edge is a line between two entities, not something to anchor to");
  v.teardown();
  assert.equal(pickIdOf("sat", 0), undefined, "and nothing at all once the module is unloaded");
  assert.equal(showOf("sat", 0), undefined);
});

// `countOf` is what says how many. A model family stands on a node family and carries no positions,
// so without this it has no count at all when it declares neither an orientation nor a mask.

test("an anchor says how many entities it holds", () => {
  const v = viewer();
  assert.equal(countOf("sat"), 1, "one satellite over two keyframes, not two entities");
  assert.equal(countOf("cell"), 3, "and an area family answers the same way");
  assert.equal(countOf("link"), undefined,
               "an edge family owns no entities, so there is nothing to draw one per");
  assert.equal(countOf("nobody"), undefined,
               "and a kind nothing owns answers nothing, which is not a family of zero");
  v.teardown();
  assert.equal(countOf("sat"), undefined, "nothing at all once the module is unloaded");
});
