import test from "node:test";
import assert from "node:assert/strict";
import type { ModuleContext } from "../../core/src/module-host.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

// The whole path from a delivered window to what a model is drawn with, against a stubbed Cesium and
// a stubbed `primitives`. Nothing here reaches a GPU or a `.glb`.
//
// The stub's quaternions carry a label rather than components, so a composition reads back as the
// string `frame*attitude*axes`. That is what makes the order the three multiply in — the one thing
// this module decides about attitude — visible to an assertion.

class FakeCartesian3 {
  x: number;
  y: number;
  z: number;
  static UNIT_X = new FakeCartesian3(1, 0, 0);
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static clone(from: FakeCartesian3, result: FakeCartesian3) {
    result.x = from.x;
    result.y = from.y;
    result.z = from.z;
    return result;
  }
  static magnitude(v: FakeCartesian3) {
    return Math.hypot(v.x, v.y, v.z);
  }
  static normalize(v: FakeCartesian3, result: FakeCartesian3) {
    const m = FakeCartesian3.magnitude(v);
    result.x = v.x / m;
    result.y = v.y / m;
    result.z = v.z / m;
    return result;
  }
}

/** A rotation, as the name of what built it. */
class FakeQuaternion {
  x = 0;
  y = 0;
  z = 0;
  w = 1;
  tag = "";
  static IDENTITY = Object.assign(new FakeQuaternion(), { tag: "identity" });
  static clone(from: FakeQuaternion, result: FakeQuaternion) {
    result.tag = from.tag;
    return result;
  }
  static fromRotationMatrix(m: FakeMatrix, result: FakeQuaternion) {
    result.tag = m.tag;
    return result;
  }
  static fromAxisAngle(axis: FakeCartesian3, angle: number, result: FakeQuaternion) {
    result.tag = `turn(${axis.x},${axis.y},${axis.z}|${angle.toFixed(3)})`;
    return result;
  }
  static fromHeadingPitchRoll(hpr: { heading: number; pitch: number; roll: number },
                              result: FakeQuaternion) {
    result.tag = `hpr(${hpr.heading},${hpr.pitch},${hpr.roll})`;
    return result;
  }
  static multiply(left: FakeQuaternion, right: FakeQuaternion, result: FakeQuaternion) {
    const composed = `${label(left)}*${label(right)}`;
    result.tag = composed;
    return result;
  }
}

const label = (q: FakeQuaternion): string => q.tag || `q(${q.x},${q.y},${q.z},${q.w})`;

class FakeMatrix {
  tag = "";
}

class FakeHeadingPitchRoll {
  heading: number;
  pitch: number;
  roll: number;
  constructor(heading: number, pitch: number, roll: number) {
    this.heading = heading;
    this.pitch = pitch;
    this.roll = roll;
  }
}

class FakeCallback {
  cb: (time: unknown, result?: unknown) => unknown;
  isConstant: boolean;
  constructor(cb: (time: unknown, result?: unknown) => unknown, isConstant: boolean) {
    this.cb = cb;
    this.isConstant = isConstant;
  }
  /** What Cesium's visualizers do once a tick: ask, handing over somewhere to put the answer. */
  value(result?: unknown): unknown {
    return this.cb(null, result);
  }
}

/** The viewer's own entity collection, which outlives the module. */
class FakeEntities {
  readonly values: Record<string, unknown>[] = [];
  add(options: Record<string, unknown>) {
    const entity = { ...options };
    this.values.push(entity);
    return entity;
  }
  remove(entity: Record<string, unknown>) {
    const i = this.values.indexOf(entity);
    if (i >= 0) this.values.splice(i, 1);
    return i >= 0;
  }
}

const C = {
  Cartesian3: FakeCartesian3,
  Quaternion: FakeQuaternion,
  Matrix3: FakeMatrix,
  Matrix4: FakeMatrix,
  HeadingPitchRoll: FakeHeadingPitchRoll,
  Math: { toRadians: (deg: number) => deg },
  CallbackProperty: FakeCallback,
  CallbackPositionProperty: FakeCallback,
  DistanceDisplayCondition: class {
    near: number;
    far: number;
    constructor(near: number, far: number) {
      this.near = near;
      this.far = far;
    }
  },
  Transforms: {
    eastNorthUpToFixedFrame(at: FakeCartesian3, _e: unknown, result: FakeMatrix) {
      result.tag = `enu(${at.x},${at.y},${at.z})`;
      return result;
    },
    rotationMatrixFromPositionVelocity(at: FakeCartesian3, step: FakeCartesian3, _e: unknown,
                                       result: FakeMatrix) {
      result.tag = `vel(${at.x},${at.y},${at.z}|${step.x},${step.y},${step.z})`;
      return result;
    },
  },
} as unknown as typeof import("@cesium/engine");
// `Matrix4.getMatrix3` reads the rotation out of the frame; the stub's two matrix kinds are one class.
(C.Matrix4 as unknown as { getMatrix3: (a: FakeMatrix, b: FakeMatrix) => FakeMatrix }).getMatrix3 =
  (from, result) => {
    result.tag = from.tag;
    return result;
  };

const { default: models } = await import("./index.ts");

/** A stubbed `primitives`: one family of two entities, which the test may move, mask or take away. */
function anchorModule() {
  const state = {
    /** Null is a family that is gone, which is not a family of zero. */
    count: 2 as number | null,
    at: [new FakeCartesian3(1, 0, 0), new FakeCartesian3(2, 0, 0)],
    shown: [true, true],
    stamps: [{ kind: "sat", idx: 0 }, { kind: "sat", idx: 1 }],
  };
  const has = (kind: string, idx: number) =>
    kind === "sat" && state.count !== null && idx >= 0 && idx < state.count;
  return {
    state,
    exports: {
      countOf: (kind: string) => (kind === "sat" && state.count !== null ? state.count : undefined),
      positionOf: (kind: string, idx: number) => (has(kind, idx) ? state.at[idx] : undefined),
      pickIdOf: (kind: string, idx: number) => (has(kind, idx) ? state.stamps[idx] : undefined),
      showOf: (kind: string, idx: number) => (has(kind, idx) ? state.shown[idx] : undefined),
    },
  };
}

const window = (id = 1, mode: "replace" | "append" = "replace"): WindowInfo =>
  ({ startFrame: 0, count: 2, id, mode, totalFrames: 2, dtSeconds: 60, epoch: null as never });

interface Options {
  /** The peer this module anchors to, or null for a scene that declared none. */
  anchor?: { countOf(kind: string): number | undefined } | null;
  /** What `ctx.assetUrl` answers; null is a path this host cannot reach. */
  url?: string | null;
}

/** The module loaded against a viewer that records what it was handed. */
function viewer(payload: unknown, opts: Options = {}) {
  const windows: ((w: WindowInfo, payload: unknown) => void)[] = [];
  const keyframes: ((index: number) => void)[] = [];
  const frames: (() => void)[] = [];
  const covers = new Map<number, WindowInfo>();
  const entities = new FakeEntities();
  const warnings: string[] = [];
  const said = console.warn;
  console.warn = (message: string) => warnings.push(message);
  const anchor = opts.anchor === undefined ? anchorModule().exports : opts.anchor;
  const ctx = {
    Cesium: C,
    viewer: { entities },
    modules: { get: (id: string) => (id === "primitives" ? anchor ?? undefined : undefined) },
    assetUrl: () => (opts.url === undefined ? "https://host/assets/models/sat.glb" : opts.url),
    onWindow: (cb: (w: WindowInfo, p: unknown) => void) => (windows.push(cb), () => {}),
    onKeyframe: (cb: (index: number) => void) => (keyframes.push(cb), () => {}),
    onFrame: (cb: () => void) => (frames.push(cb), () => {}),
    placement: (index: number) => {
      const w = covers.get(index);
      return w ? { window: w, k: index - w.startFrame } : null;
    },
    perWindow: <T>() => new Timeline<T>(),
  } as unknown as ModuleContext;
  const teardown = models.setup(ctx);
  const deliver = (p: unknown, info = window()) => {
    for (let k = 0; k < info.count; k++) covers.set(info.startFrame + k, info);
    for (const cb of windows) cb(info, p);
    for (const cb of keyframes) cb(info.startFrame);
  };
  deliver(payload);
  return {
    entities,
    warnings,
    deliver,
    /** One render tick, which is where a borrowed stamp and a velocity step are read. */
    tick: () => {
      for (const cb of frames) cb();
    },
    /** Where the keyframe crossing takes the family, for a knob that switches at one. */
    cross: (index: number) => {
      for (const cb of keyframes) cb(index);
    },
    teardown: () => {
      teardown();
      console.warn = said;
    },
  };
}

const SPEC = {
  kind: "sat_body",
  of: "sat",
  uri: "assets/models/sat.glb",
  range: [0, 2000000],
};

const scene = (extra: Record<string, unknown> = {}) => ({ models: [{ ...SPEC, ...extra }] });

/** What Cesium asks the entity for on a tick: where it is, which way it points, whether it draws. */
const asked = (entity: Record<string, unknown>) => {
  const model = entity.model as { show?: FakeCallback; uri?: string } | undefined;
  return {
    at: (entity.position as FakeCallback).value() as FakeCartesian3 | undefined,
    pointing: ((entity.orientation as FakeCallback).value(new FakeQuaternion()) as FakeQuaternion
              | undefined)?.tag,
    shown: model?.show?.value(),
    uri: model?.uri,
  };
};

test("a family stands on its anchor and follows that family's position", () => {
  const anchor = anchorModule();
  const v = viewer(scene(), { anchor: anchor.exports });
  assert.equal(v.entities.values.length, 2, "one model per entity of the family it stands on");
  assert.equal(asked(v.entities.values[0]).uri, "https://host/assets/models/sat.glb",
               "the uri went through ctx.assetUrl rather than to the payload's own path");
  assert.deepEqual(asked(v.entities.values[1]).at, new FakeCartesian3(2, 0, 0));

  // The anchor's own position object, moved by its per-tick interpolation. Nothing is copied here.
  anchor.state.at[1].x = 55;
  assert.deepEqual(asked(v.entities.values[1]).at, new FakeCartesian3(55, 0, 0),
                   "and it follows, because the model asks the anchor on every tick");
  v.teardown();
});

test("how many models to build comes from the anchor, not from a knob", () => {
  const anchor = anchorModule();
  anchor.state.count = 3;
  anchor.state.at.push(new FakeCartesian3(3, 0, 0));
  anchor.state.shown.push(true);
  anchor.state.stamps.push({ kind: "sat", idx: 2 });
  // Neither optional knob is written, so nothing but the anchor says how big this family is.
  const v = viewer(scene(), { anchor: anchor.exports });
  assert.equal(v.entities.values.length, 3);
  v.teardown();
});

test("a family whose anchor never existed draws nothing and says so once", () => {
  const v = viewer(scene({ of: "nobody" }));
  assert.equal(v.entities.values.length, 0, "there is nothing to draw one per");
  v.tick();
  v.tick();
  assert.equal(v.warnings.length, 1, "a family draws every frame; a fault says itself once");
  assert.match(v.warnings[0], /no family "nobody"/);
  v.teardown();
});

test("a scene that declares models and not primitives draws nothing and says so once", () => {
  const v = viewer(scene(), { anchor: null });
  assert.equal(v.entities.values.length, 0);
  v.tick();
  v.tick();
  // Two faults, and the second follows from the first: no module to ask, and so no family to stand
  // on. Each is said once however many frames are drawn.
  assert.match(v.warnings[0], /declares no primitives module/);
  assert.match(v.warnings[1], /no family "sat"/);
  assert.equal(v.warnings.length, 2);
  v.teardown();
});

test("a family whose anchor disappears draws nothing, and draws again when it comes back", () => {
  const anchor = anchorModule();
  const v = viewer(scene(), { anchor: anchor.exports });
  const standing = [...v.entities.values];
  assert.deepEqual(asked(standing[0]).shown, true);

  anchor.state.count = null;
  v.tick();
  assert.equal(asked(standing[0]).at, undefined, "nowhere to stand");
  assert.equal(asked(standing[0]).shown, false, "and nothing drawn");
  assert.equal(v.warnings.length, 1);

  anchor.state.count = 2;
  v.tick();
  assert.equal(asked(standing[0]).shown, true, "drawn again");
  assert.deepEqual(v.entities.values, standing, "and the same entities, with no rebuild");
  assert.equal(v.warnings.length, 1, "and the fault is not reported a second time");
  v.teardown();
});

test("a uri this host cannot reach draws no model and says so once", () => {
  const v = viewer(scene(), { url: null });
  assert.equal(v.entities.values.length, 2, "the entities still stand where the anchor does");
  assert.equal(v.entities.values[0].model, undefined, "and draw no model at all");
  v.tick();
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /assets\/models\/sat\.glb/);
  v.teardown();
});

test("the entity carries the anchor's stamp, never one of its own", () => {
  const anchor = anchorModule();
  const v = viewer(scene(), { anchor: anchor.exports });
  assert.equal(v.entities.values[1].pickId, anchor.state.stamps[1],
               "the very object primitives stamped its billboard with, so one click is one entity");

  // A window this family was not named in may rebuild the anchor, which mints new stamps.
  anchor.state.stamps[1] = { kind: "sat", idx: 1 };
  v.tick();
  assert.equal(v.entities.values[1].pickId, anchor.state.stamps[1], "re-read every frame");
  v.teardown();
});

test("a model is drawn only where its own mask and its anchor's both say so", () => {
  const anchor = anchorModule();
  const v = viewer(scene({ show: { data: Uint8Array.from([1, 0]), shape: [2] } }),
                   { anchor: anchor.exports });
  assert.deepEqual([asked(v.entities.values[0]).shown, asked(v.entities.values[1]).shown],
                   [true, false], "the family's own knob hides the second");

  anchor.state.shown[0] = false;
  assert.equal(asked(v.entities.values[0]).shown, false,
               "and the anchor's mask hides the first, so a model never outlives its marker");
  v.teardown();
});

test("range is what a model costs nothing outside", () => {
  const v = viewer(scene());
  const model = v.entities.values[0].model as { distanceDisplayCondition: { near: number; far: number } };
  assert.equal(model.distanceDisplayCondition.near, 0);
  assert.equal(model.distanceDisplayCondition.far, 2000000);
  v.teardown();
});

// The four frames, and the order the three rotations multiply in. `enu` is built from where the
// entity is now, so a frame follows the entity rather than standing where a keyframe left it.

test("each frame builds the rotation it says", () => {
  const ecef = viewer(scene({ frame: "ecef" }));
  assert.equal(asked(ecef.entities.values[0]).pointing, "identity",
               "ecef is the identity, so a quaternion in that frame is absolute");
  ecef.teardown();

  const enu = viewer(scene({ frame: "enu" }));
  assert.equal(asked(enu.entities.values[1]).pointing, "enu(2,0,0)",
               "east-north-up at the position the anchor is at now");
  enu.teardown();

  const nadir = viewer(scene({ frame: "nadir" }));
  assert.equal(asked(nadir.entities.values[0]).pointing, "enu(1,0,0)*turn(1,0,0|3.142)",
               "east-north-up turned half a turn about east, which puts +Z toward the centre");
  nadir.teardown();

  const anchor = anchorModule();
  const velocity = viewer(scene({ frame: "velocity" }), { anchor: anchor.exports });
  velocity.tick();
  anchor.state.at[0].x = 4;
  velocity.tick();
  assert.equal(asked(velocity.entities.values[0]).pointing, "vel(4,0,0|1,0,0)",
               "the direction the position took between two ticks, as a unit vector");
  velocity.teardown();
});

test("a velocity frame keeps the direction it had while the clock is held", () => {
  const anchor = anchorModule();
  const v = viewer(scene({ frame: "velocity" }), { anchor: anchor.exports });
  v.tick();
  anchor.state.at[0].x = 4;
  v.tick();
  // The same position again, which is what a held clock delivers. A step of nothing has no
  // direction, and turning the model back to east-north-up for it would be a visible flick.
  v.tick();
  assert.equal(asked(v.entities.values[0]).pointing, "vel(4,0,0|1,0,0)");
  v.teardown();
});

test("a standing family has no direction to face, so it falls back to east-north-up", () => {
  const v = viewer(scene({ frame: "velocity" }));
  v.tick();
  assert.equal(asked(v.entities.values[0]).pointing, "enu(1,0,0)");
  v.teardown();
});

test("a frame, an attitude and an axes correction multiply in that order", () => {
  const v = viewer(scene({
    frame: "enu",
    axes: [90, 0, 0],
    orientation: { data: Float64Array.from([0, 0, 0, 1, 9, 9, 9, 9]), shape: [2, 4] },
  }));
  assert.equal(asked(v.entities.values[0]).pointing, "enu(1,0,0)*q(0,0,0,1)*hpr(90,0,0)",
               "the frame turns the attitude, and the file's own axes correction applies first");
  v.teardown();
});

test("a frame nothing knows is drawn in ecef, and says so once", () => {
  const v = viewer(scene({ frame: "sideways" }));
  assert.equal(asked(v.entities.values[0]).pointing, "identity");
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /ecef, enu, nadir, velocity/);
  v.teardown();
});

// What a rebuild costs is the entities themselves, so only the family's shape may cause one.

test("a shape change rebuilds the entities and an attribute change does not", () => {
  const anchor = anchorModule();
  const v = viewer(scene(), { anchor: anchor.exports });
  const standing = [...v.entities.values];

  v.deliver(scene({ orientation: { data: Float64Array.from([0, 0, 0, 1, 0, 0, 1, 0]), shape: [2, 4] },
                    show: { data: Uint8Array.from([1, 1]), shape: [2] } }), window(2));
  assert.deepEqual(v.entities.values, standing, "an attitude and a mask are read off standing entities");

  v.deliver(scene({ scale: 1000 }), window(3));
  assert.notDeepEqual(v.entities.values, standing, "a scale is what an entity is born with");
  assert.equal(v.entities.values.length, 2, "and the old entities went out as the new ones came in");

  const rebuilt = [...v.entities.values];
  anchor.state.count = 1;
  v.tick();
  assert.equal(v.entities.values.length, 1,
               "a window may resize the anchor under a family this window never named");
  assert.notDeepEqual(v.entities.values, rebuilt);
  v.teardown();
});

test("a replacing window that does not name a family takes its entities out", () => {
  const v = viewer(scene());
  assert.equal(v.entities.values.length, 2);
  v.deliver({ models: [] }, window(2));
  assert.equal(v.entities.values.length, 0);
  v.teardown();
});

test("teardown takes back every entity, because the collection outlives the module", () => {
  const v = viewer(scene());
  assert.equal(v.entities.values.length, 2);
  v.teardown();
  assert.equal(v.entities.values.length, 0);
});

test("a velocity frame is built from a direction, never from a step in metres", () => {
  // `rotationMatrixFromPositionVelocity` carries the magnitude of the vector it is given into the
  // matrix, so a raw step scales the rotation by however many metres the entity moved. Cesium then
  // sizes the model by the square of the quaternion's norm: measured on a real scene as a 24 km
  // aircraft drawn ten thousand kilometres long, with nothing in any log to say why.
  const anchor = anchorModule();
  const v = viewer(scene({ frame: "velocity" }), { anchor: anchor.exports });
  v.tick();
  anchor.state.at[0].x = 7_500_000;
  v.tick();
  const [, step] = /vel\([^|]*\|([^)]*)\)/.exec(asked(v.entities.values[0]).pointing)!;
  const [x, y, z] = step.split(",").map(Number);
  assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12,
            `a step of 7500 km must reach Cesium as a unit vector, got [${step}]`);
  v.teardown();
});
