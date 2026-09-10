// core/src/once.ts
function sayOnce(emit) {
  const said = /* @__PURE__ */ new Set();
  return (key, message) => {
    if (said.has(key)) return;
    said.add(key);
    emit(message);
  };
}

// core/src/codec.ts
function blockAt(a, k, baseRank, count) {
  const { data, shape } = a;
  if (shape.length <= baseRank) {
    return { data, offset: 0, len: data.length, keyframed: false };
  }
  if (shape.length !== baseRank + 1) {
    throw new Error(`codec: shape [${shape}] is more than one rank above base rank ${baseRank}`);
  }
  if (shape[0] !== count) {
    throw new Error(`codec: shape [${shape}] has ${shape[0]} keyframes, the window carries ${count}`);
  }
  if (k < 0 || k >= count) return null;
  let len = 1;
  for (let axis = 1; axis < shape.length; axis++) len *= shape[axis];
  return { data, offset: k * len, len, keyframed: true };
}
function isNdArray(v) {
  const o = v;
  return !!o && typeof o === "object" && ArrayBuffer.isView(o.data) && Array.isArray(o.shape);
}
var numbers = (v) => v === void 0 ? [] : isNdArray(v) ? Array.from(v.data) : v;

// primitives/src/knobs.ts
var at = (s, i, j = 0) => s.data[s.offset + i * s.stride + j];
var whole = (data, stride) => ({ data, offset: 0, stride, length: stride === 0 ? Infinity : data.length / stride });
var constant = (slice) => ({ keyframed: false, frame: () => slice });
function knob(raw, s) {
  const { itemLen, count, what, n, module = "primitives" } = s;
  const name = `${module}: ${what}`;
  if (raw === null || raw === void 0) return null;
  if (typeof raw === "number") {
    if (itemLen !== 1) {
      throw new Error(`${name} takes ${itemLen} components, not one number`);
    }
    return constant(whole([raw], 0));
  }
  if (Array.isArray(raw)) {
    if (raw.length !== count) {
      throw new Error(`${name} has ${raw.length} keyframes, the window carries ${count}`);
    }
    const slices = raw.map((one, k) => {
      if (!isNdArray(one)) throw new Error(`${name} keyframe ${k} is not an array`);
      if (one.data.length % itemLen !== 0) {
        throw new Error(`${name} keyframe ${k} has ${one.data.length} values, not whole groups of ${itemLen}`);
      }
      return whole(one.data, itemLen);
    });
    return { keyframed: true, frame: (k) => slices[k] ?? null };
  }
  if (!isNdArray(raw)) throw new Error(`${name} is neither a number nor an array`);
  const { data, shape } = raw;
  const dims = shape.length;
  const want = (expected, form) => {
    if (data.length !== expected) {
      throw new Error(`${name} as ${form} wants ${expected} values, got ${data.length}`);
    }
  };
  if (itemLen > 1 && dims === 1) {
    want(itemLen, "one value for the family");
    return constant(whole(data, 0));
  }
  const entityDims = itemLen > 1 ? 2 : 1;
  if (dims === entityDims) {
    if (n !== void 0) want(n * itemLen, "one value per entity");
    else if (data.length % itemLen !== 0) want(data.length, "one value per entity");
    return constant(whole(data, itemLen));
  }
  if (dims === entityDims + 1) {
    let first;
    try {
      first = blockAt(raw, 0, entityDims, count);
    } catch (err) {
      throw new Error(`${name}, ${err.message}`);
    }
    if (first && n !== void 0 && first.len !== n * itemLen) {
      want(count * n * itemLen, "one value per entity per keyframe");
    }
    return {
      keyframed: true,
      frame: (k) => {
        const block = blockAt(raw, k, entityDims, count);
        return block && {
          data: block.data,
          offset: block.offset,
          stride: itemLen,
          length: block.len / itemLen
        };
      }
    };
  }
  throw new Error(`${name} has shape [${shape}], which is none of the forms for a family of ${n ?? "?"} over ${count} keyframes`);
}

// models/src/frames.ts
var NAMES = ["ecef", "enu", "nadir", "velocity"];
var frameNamed = (name) => typeof name === "string" && NAMES.includes(name) ? name : void 0;
var enuScratch = null;
var rotScratch = null;
var flip = null;
var dirScratch = null;
var STEP_EPSILON_M = 1e-6;
function frameQuaternion(C, frame, at2, step, result) {
  if (frame === "ecef") return C.Quaternion.clone(C.Quaternion.IDENTITY, result);
  if (frame === "velocity" && step && C.Cartesian3.magnitude(step) > STEP_EPSILON_M) {
    dirScratch = C.Cartesian3.normalize(step, dirScratch ?? new C.Cartesian3());
    rotScratch = C.Transforms.rotationMatrixFromPositionVelocity(
      at2,
      dirScratch,
      void 0,
      rotScratch ?? new C.Matrix3()
    );
    return C.Quaternion.fromRotationMatrix(rotScratch, result);
  }
  enuScratch = C.Transforms.eastNorthUpToFixedFrame(at2, void 0, enuScratch ?? new C.Matrix4());
  rotScratch = C.Matrix4.getMatrix3(enuScratch, rotScratch ?? new C.Matrix3());
  C.Quaternion.fromRotationMatrix(rotScratch, result);
  if (frame === "nadir") {
    flip = flip ?? C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_X, Math.PI, new C.Quaternion());
    C.Quaternion.multiply(result, flip, result);
  }
  return result;
}
function axesQuaternion(C, axes) {
  if (axes.length !== 3) return null;
  const hpr = new C.HeadingPitchRoll(
    C.Math.toRadians(axes[0]),
    C.Math.toRadians(axes[1]),
    C.Math.toRadians(axes[2])
  );
  return C.Quaternion.fromHeadingPitchRoll(hpr, new C.Quaternion());
}

// models/src/family.ts
var ModelFamily = class {
  kind;
  C;
  entities;
  anchors;
  assetUrl;
  timeline;
  /** The last window's declaration, which is what a rebuild is made from. */
  spec = null;
  /** The shape the standing entities were built for. A rebuild happens when this changes. */
  built = "";
  /** Entities in the anchor family when the build ran, which is how many models stand. */
  count = 0;
  made = [];
  orientationAt = null;
  showAt = null;
  /** Reports each fault one time. The key states which fault this is. */
  say;
  /** Where each model stood on the previous tick, for the `velocity` frame only. */
  wasAt = [];
  /** The step each model last took, which is the direction the `velocity` frame faces. */
  stepAt = [];
  turn = null;
  body = null;
  constructor(kind, C, entities, anchors, assetUrl, warn, timeline) {
    this.kind = kind;
    this.C = C;
    this.entities = entities;
    this.anchors = anchors;
    this.assetUrl = assetUrl;
    this.say = sayOnce(warn);
    this.timeline = timeline;
  }
  /**
   * Take one window's declaration. The anchor is asked how many entities it holds here rather than
   * once at the first window: a replacing window may resize it, and nothing on the wire says how
   * many models a family covers.
   */
  onWindow(spec, win) {
    this.spec = spec;
    const n = this.anchors.countOf(spec.of);
    this.timeline.install({
      orientation: knob(spec.orientation, {
        itemLen: 4,
        n,
        count: win.count,
        module: "models",
        what: `${this.kind}.orientation`
      }),
      show: knob(spec.show, {
        itemLen: 1,
        n,
        count: win.count,
        module: "models",
        what: `${this.kind}.show`
      })
    }, win);
    this.reshape();
  }
  /** The attitude and the mask this keyframe carries — read per tick from what is cached here. */
  onKeyframe(where) {
    const place = this.timeline.at(where);
    if (!place) return;
    this.orientationAt = place.w.orientation?.frame(place.k) ?? null;
    this.showAt = place.w.show?.frame(place.k) ?? null;
  }
  /**
   * What has to be read live rather than held: the borrowed stamp, and the step the `velocity` frame
   * turns into a direction. The anchor is also asked its size again, because a window this family
   * was not named in can still resize the family it stands on.
   */
  onFrame() {
    const spec = this.spec;
    if (!spec) return;
    const n = this.anchors.countOf(spec.of);
    if (n === void 0) {
      this.say("anchor", `models: ${this.kind}: no family "${spec.of}" to stand on; nothing drawn`);
      return;
    }
    if (n !== this.count) this.reshape();
    const velocity = frameNamed(spec.frame) === "velocity";
    for (let i = 0; i < this.made.length; i++) {
      const stamp = this.anchors.pickIdOf(spec.of, i);
      if (this.made[i].pickId !== stamp) this.made[i].pickId = stamp;
      if (velocity) this.sample(spec.of, i);
    }
  }
  /** Rebuild where the family's shape changed, and leave the standing entities alone where it did not. */
  reshape() {
    const spec = this.spec;
    if (!spec) return;
    const n = this.anchors.countOf(spec.of);
    if (n === void 0) return;
    const signature = [
      n,
      spec.uri,
      spec.frame ?? "ecef",
      numbers(spec.axes),
      numbers(spec.range),
      spec.scale ?? "",
      spec.minimumPixelSize ?? ""
    ].join("|");
    if (signature === this.built) return;
    this.build(spec, n);
    this.built = signature;
  }
  build(spec, n) {
    const C = this.C;
    this.clear();
    const url = this.assetUrl(spec.uri);
    if (url === null) {
      this.say(
        `uri:${spec.uri}`,
        `models: ${this.kind}: "${spec.uri}" resolves to no URL for this host; no model drawn`
      );
    }
    const frame = frameNamed(spec.frame);
    if (spec.frame !== void 0 && frame === void 0) {
      this.say(
        `frame:${spec.frame}`,
        `models: ${this.kind}: frame "${spec.frame}" is none of ecef, enu, nadir, velocity; drawn in ecef`
      );
    }
    const turned = frame ?? "ecef";
    const axes = axesQuaternion(C, numbers(spec.axes));
    const range = numbers(spec.range);
    for (let i = 0; i < n; i++) {
      const entity = this.entities.add({
        position: new C.CallbackPositionProperty(() => this.anchors.positionOf(spec.of, i), false),
        orientation: new C.CallbackProperty(
          (_time, result) => this.pointing(spec.of, i, turned, axes, result),
          false
        ),
        model: url === null ? void 0 : {
          uri: url,
          // The whole reason a model family is affordable: out of range it is not drawn at all.
          distanceDisplayCondition: new C.DistanceDisplayCondition(range[0], range[1]),
          // `Entity.show` is a plain boolean and cannot follow the clock. This one is a Property.
          show: new C.CallbackProperty(() => this.shown(spec.of, i), false),
          scale: spec.scale,
          minimumPixelSize: spec.minimumPixelSize
        }
      });
      entity.pickId = this.anchors.pickIdOf(spec.of, i);
      this.made.push(entity);
      this.wasAt.push(null);
      this.stepAt.push(null);
    }
    this.count = n;
  }
  /**
   * Which way model `i` points: the frame it stands in, turned by the family's attitude, turned by
   * the fixed axes correction. An entity whose anchor is gone answers nothing, and Cesium then draws
   * it with the attitude it had.
   */
  pointing(of, i, frame, axes, result) {
    const C = this.C;
    const here = this.anchors.positionOf(of, i);
    if (!here) return void 0;
    const out = result ?? (this.turn = this.turn ?? new C.Quaternion());
    frameQuaternion(C, frame, here, this.stepAt[i] ?? null, out);
    const body = this.attitude(i);
    if (body) C.Quaternion.multiply(out, body, out);
    if (axes) C.Quaternion.multiply(out, axes, out);
    return out;
  }
  /** The family's own quaternion for entity `i` at the keyframe on screen, or nothing where it sent none. */
  attitude(i) {
    const s = this.orientationAt;
    if (!s || i >= s.length) return null;
    const q = this.body = this.body ?? new this.C.Quaternion();
    q.x = at(s, i, 0);
    q.y = at(s, i, 1);
    q.z = at(s, i, 2);
    q.w = at(s, i, 3);
    return q;
  }
  /** Both masks: this family's own, and whether the entity it stands on is drawn at all. */
  shown(of, i) {
    const s = this.showAt;
    if (s && i < s.length && at(s, i) === 0) return false;
    return this.anchors.showOf(of, i) === true;
  }
  /**
   * The step model `i` took since the previous tick, which is what the `velocity` frame is built
   * from. The anchor blends linearly between the two keyframes that bracket the tick, so a step
   * points exactly along the segment between them.
   *
   * Sampled here, once per tick, rather than inside the orientation callback: a callback Cesium
   * calls twice in one tick would read the second step as nothing and turn the model back to
   * east-north-up for that frame.
   *
   * A step of nothing leaves the previous direction standing. A held clock and a scene paused
   * between two windows both deliver the same position again, and a model must not turn for that.
   */
  sample(of, i) {
    const C = this.C;
    const here = this.anchors.positionOf(of, i);
    if (!here) return;
    const was = this.wasAt[i];
    if (!was) {
      this.wasAt[i] = C.Cartesian3.clone(here, new C.Cartesian3());
      return;
    }
    const dx = here.x - was.x, dy = here.y - was.y, dz = here.z - was.z;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const step = this.stepAt[i] ?? (this.stepAt[i] = new C.Cartesian3());
    step.x = dx;
    step.y = dy;
    step.z = dz;
    C.Cartesian3.clone(here, was);
  }
  clear() {
    for (const entity of this.made) this.entities.remove(entity);
    this.made.length = 0;
    this.wasAt.length = 0;
    this.stepAt.length = 0;
    this.count = 0;
  }
  destroy() {
    this.clear();
    this.timeline.clear();
    this.built = "";
    this.spec = null;
  }
};

// models/src/index.ts
var ANCHOR = "primitives";
var src_default = {
  setup(ctx) {
    const families = /* @__PURE__ */ new Map();
    const warn = (message) => console.warn(message);
    const say = sayOnce(warn);
    let peer;
    const owner = () => {
      peer = peer ?? ctx.modules.get(ANCHOR);
      if (!peer || typeof peer.countOf !== "function") {
        say(ANCHOR, `models: the scene declares no ${ANCHOR} module, so nothing is anchored`);
        return {};
      }
      return peer;
    };
    const anchors = {
      positionOf: (kind, idx) => owner().positionOf?.(kind, idx),
      pickIdOf: (kind, idx) => owner().pickIdOf?.(kind, idx),
      showOf: (kind, idx) => owner().showOf?.(kind, idx),
      countOf: (kind) => owner().countOf?.(kind)
    };
    const disposables = [
      ctx.onWindow((w, payload) => {
        const specs = (payload ?? {}).models ?? [];
        if (w.mode === "replace") {
          const named = new Set(specs.map((s) => s.kind));
          for (const [kind, family] of families) {
            if (named.has(kind)) continue;
            family.destroy();
            families.delete(kind);
          }
        }
        for (const spec of specs) {
          let family = families.get(spec.kind);
          if (!family) {
            family = new ModelFamily(
              spec.kind,
              ctx.Cesium,
              ctx.viewer.entities,
              anchors,
              ctx.assetUrl,
              warn,
              ctx.perWindow()
            );
            families.set(spec.kind, family);
          }
          family.onWindow(spec, w);
        }
      }),
      ctx.onKeyframe((index) => {
        const at2 = ctx.placement(index);
        for (const family of families.values()) family.onKeyframe(at2);
      }),
      ctx.onFrame(() => {
        for (const family of families.values()) family.onFrame();
      })
    ];
    return () => {
      for (const dispose of disposables) dispose();
      for (const family of families.values()) family.destroy();
      families.clear();
      peer = void 0;
    };
  }
};
export {
  src_default as default
};
//# sourceMappingURL=models.js.map
