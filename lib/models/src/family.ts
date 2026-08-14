// One model family: one Cesium `Entity` per entity of the family it stands on.
//
// A model is not batched. Cesium draws it as a primitive of its own through the entity visualizers,
// and a spike measured 5 draw commands for one model in range and 0 for one out of it. `range` is
// therefore required, and it is what keeps a modelled constellation affordable.
//
// Nothing here holds a position, an identity or a mask of its own. The family named by `of` holds
// all three, and this reads them through the anchor surface `primitives` publishes — every frame,
// because a window may prune or resize that family under this one. See ADR-0022 and ADR-0023.

import type { Cartesian3, Entity, EntityCollection, Quaternion } from "@cesium/engine";
import { numbers, type NdArray } from "../../core/src/codec.ts";
import { sayOnce } from "../../core/src/once.ts";
import type { Placement, Timeline, WindowInfo } from "../../core/src/windows.ts";
import { at, knob, type Knob, type Slice } from "../../primitives/src/knobs.ts";
import { axesQuaternion, frameNamed, frameQuaternion,
         type CesiumRuntime, type FrameName } from "./frames.ts";

/** A model family as Julia sends it. */
export interface ModelSpec {
  kind: string;
  /** The `primitives` node family the models stand on. */
  of: string;
  /** A same-origin `assets/<mount>/<file>`, which `ctx.assetUrl` turns into a URL for this host. */
  uri: string;
  /** `[near_m, far_m]`: the camera distance a model draws in. Required, and never a default. */
  range: number[] | NdArray;
  /** `"ecef"`, `"enu"`, `"nadir"` or `"velocity"`. Absent means `"ecef"`. */
  frame?: string;
  /** A quaternion knob, `4 x N` or `4 x N x count`, in Cesium's own order: x, y, z, w. */
  orientation?: unknown;
  /** Heading, pitch and roll in degrees: one fixed correction for the file's own forward axis. */
  axes?: number[] | NdArray;
  scale?: number;
  /** The size below which a model stops shrinking, in pixels. */
  minimumPixelSize?: number;
  show?: unknown;
}

/** What a peer publishes about the entities a model family stands on. */
export interface Anchors {
  positionOf(kind: string, idx: number): Cartesian3 | undefined;
  pickIdOf(kind: string, idx: number): object | undefined;
  showOf(kind: string, idx: number): boolean | undefined;
  countOf(kind: string): number | undefined;
}

/** What one window says about a family: the two knobs that switch at a keyframe crossing. */
interface ModelWindow {
  orientation: Knob | null;
  show: Knob | null;
}

/** An entity carrying the stamp of the entity it is anchored to, which is not Cesium's own field. */
type Anchored = Entity & { pickId?: object };

export class ModelFamily {
  readonly kind: string;
  private readonly C: CesiumRuntime;
  private readonly entities: EntityCollection;
  private readonly anchors: Anchors;
  private readonly assetUrl: (path: string) => string | null;
  private readonly timeline: Timeline<ModelWindow>;

  /** The last window's declaration, which is what a rebuild is made from. */
  private spec: ModelSpec | null = null;
  /** The shape the standing entities were built for. A rebuild happens when this changes. */
  private built = "";
  /** Entities in the anchor family when the build ran, which is how many models stand. */
  private count = 0;
  private readonly made: Anchored[] = [];
  private orientationAt: Slice | null = null;
  private showAt: Slice | null = null;
  /** Reports each fault one time. The key states which fault this is. */
  private readonly say: (key: string, message: string) => void;
  /** Where each model stood on the previous tick, for the `velocity` frame only. */
  private readonly wasAt: (Cartesian3 | null)[] = [];
  /** The step each model last took, which is the direction the `velocity` frame faces. */
  private readonly stepAt: (Cartesian3 | null)[] = [];
  private turn: Quaternion | null = null;
  private body: Quaternion | null = null;

  constructor(kind: string, C: CesiumRuntime, entities: EntityCollection, anchors: Anchors,
              assetUrl: (path: string) => string | null, warn: (message: string) => void,
              timeline: Timeline<ModelWindow>) {
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
  onWindow(spec: ModelSpec, win: WindowInfo): void {
    this.spec = spec;
    const n = this.anchors.countOf(spec.of);
    this.timeline.install({
      orientation: knob(spec.orientation, { itemLen: 4, n, count: win.count, module: "models",
                                            what: `${this.kind}.orientation` }),
      show: knob(spec.show, { itemLen: 1, n, count: win.count, module: "models",
                              what: `${this.kind}.show` }),
    }, win);
    this.reshape();
  }

  /** The attitude and the mask this keyframe carries — read per tick from what is cached here. */
  onKeyframe(where: Placement | null): void {
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
  onFrame(): void {
    const spec = this.spec;
    if (!spec) return;
    const n = this.anchors.countOf(spec.of);
    if (n === undefined) {
      // The family is gone, not empty. The models stay where they are and hide themselves, and they
      // draw again with no rebuild if a later window brings the family back.
      this.say("anchor", `models: ${this.kind}: no family "${spec.of}" to stand on; nothing drawn`);
      return;
    }
    if (n !== this.count) this.reshape();
    const velocity = frameNamed(spec.frame) === "velocity";
    for (let i = 0; i < this.made.length; i++) {
      // Re-read every frame: a rebuilt anchor family mints new stamps, and it may be rebuilt by a
      // window this family was not named in.
      const stamp = this.anchors.pickIdOf(spec.of, i);
      if (this.made[i].pickId !== stamp) this.made[i].pickId = stamp;
      if (velocity) this.sample(spec.of, i);
    }
  }

  /** Rebuild where the family's shape changed, and leave the standing entities alone where it did not. */
  private reshape(): void {
    const spec = this.spec;
    if (!spec) return;
    const n = this.anchors.countOf(spec.of);
    if (n === undefined) return;
    // Everything a standing entity is born with. The attitude and the mask are not here: they are
    // read per tick off entities that never have to be built again.
    const signature = [n, spec.uri, spec.frame ?? "ecef", numbers(spec.axes), numbers(spec.range),
                       spec.scale ?? "", spec.minimumPixelSize ?? ""].join("|");
    if (signature === this.built) return;
    this.build(spec, n);
    this.built = signature;
  }

  private build(spec: ModelSpec, n: number): void {
    const C = this.C;
    this.clear();
    const url = this.assetUrl(spec.uri);
    if (url === null) {
      // The anchor's own marker is still on screen, which is the fallback ADR-0020 sets for imagery
      // and the same one a missing model falls to.
      this.say(`uri:${spec.uri}`,
               `models: ${this.kind}: "${spec.uri}" resolves to no URL for this host; no model drawn`);
    }
    const frame = frameNamed(spec.frame);
    if (spec.frame !== undefined && frame === undefined) {
      this.say(`frame:${spec.frame}`,
               `models: ${this.kind}: frame "${spec.frame}" is none of ecef, enu, nadir, ` +
               `velocity; drawn in ecef`);
    }
    const turned = frame ?? "ecef";
    const axes = axesQuaternion(C, numbers(spec.axes));
    const range = numbers(spec.range);
    for (let i = 0; i < n; i++) {
      // A `CallbackPositionProperty`, never a `Cartesian3` written per frame: assigning a position
      // replaces the property object, which restarts the geometry and draws nothing at all.
      const entity = this.entities.add({
        position: new C.CallbackPositionProperty(() => this.anchors.positionOf(spec.of, i), false),
        orientation: new C.CallbackProperty(
          (_time, result) => this.pointing(spec.of, i, turned, axes, result as Quaternion), false),
        model: url === null ? undefined : {
          uri: url,
          // The whole reason a model family is affordable: out of range it is not drawn at all.
          distanceDisplayCondition: new C.DistanceDisplayCondition(range[0], range[1]),
          // `Entity.show` is a plain boolean and cannot follow the clock. This one is a Property.
          show: new C.CallbackProperty(() => this.shown(spec.of, i), false),
          scale: spec.scale,
          minimumPixelSize: spec.minimumPixelSize,
        },
      }) as Anchored;
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
  private pointing(of: string, i: number, frame: FrameName, axes: Quaternion | null,
                   result: Quaternion): Quaternion | undefined {
    const C = this.C;
    const here = this.anchors.positionOf(of, i);
    if (!here) return undefined;
    const out = result ?? (this.turn = this.turn ?? new C.Quaternion());
    frameQuaternion(C, frame, here, this.stepAt[i] ?? null, out);
    const body = this.attitude(i);
    if (body) C.Quaternion.multiply(out, body, out);
    if (axes) C.Quaternion.multiply(out, axes, out);
    return out;
  }

  /** The family's own quaternion for entity `i` at the keyframe on screen, or nothing where it sent none. */
  private attitude(i: number): Quaternion | null {
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
  private shown(of: string, i: number): boolean {
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
  private sample(of: string, i: number): void {
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

  private clear(): void {
    for (const entity of this.made) this.entities.remove(entity);
    this.made.length = 0;
    this.wasAt.length = 0;
    this.stepAt.length = 0;
    this.count = 0;
  }

  destroy(): void {
    this.clear();
    this.timeline.clear();
    this.built = "";
    this.spec = null;
  }
}
