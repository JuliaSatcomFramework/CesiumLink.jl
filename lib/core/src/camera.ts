// The camera, owned by the Core. One `core/camera` command carries a whole **camera track** — a
// declared list of viewpoints, each scheduled against the scene clock, against a wall-clock offset,
// or against nothing at all — and one boolean says who holds the camera (ADR-0017, ADR-0018).
//
// The camera is user state, not scene state. A viewpoint the server sends is an offer: the Core
// applies it while the server holds the camera and ignores it once the user takes the camera. Only a
// viewpoint carrying `take`, or `rejoin()`, gives the hold back.
//
// What takes the hold is DOM input on the canvas, read in the capture phase, the way `picking.ts`
// reads modifiers and for the same reason: intent is read off the event rather than inferred from
// camera state. Watching `camera.moveStart` cannot tell the Core's own flight from the home button's
// flight, which is also a flight. The canvas is the camera's surface; furniture is chrome, so no
// button ever detaches.
//
// Cesium-injected (`C`) like the pointer dispatch, so scheduling and authority unit-test without WebGL.

import type { Cartesian3, JulianDate, Scene } from "@cesium/engine";
import type { WindowInfo } from "./windows";

/** A point on the globe, in degrees. `height` is metres above the ellipsoid and defaults to 0. */
export interface GlobePoint {
  lon: number;
  lat: number;
  height?: number;
}

/** A geographic extent, in degrees. Cesium turns it into a view that frames it. */
export interface GlobeExtent {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Where an anchor is now, or null where it is gone. Asked afresh every tick, so what comes back
 * follows whatever interpolation the module that owns the anchor runs.
 */
export type AnchorPosition = () => Cartesian3 | null;

/** What a module answers with for a target name it knows, or null for one it does not. */
export type AnchorResolver = (target: string) => AnchorPosition | null;

/**
 * Ride an anchor instead of standing at a destination. `module` addresses a loaded module the way a
 * command does; `target` is opaque — the Core passes it to that module's resolver and never reads it
 * (ADR-0006).
 */
export interface FollowAnchor {
  module: string;
  target: string;
}

/**
 * A request to ride an anchor: what to ride, and how to sit on it. Every offset field is optional,
 * and a request that states none mounts the camera exactly where it already stands, which is what
 * "hold station on that" means when the caller says nothing else.
 */
export interface FollowRequest extends FollowAnchor {
  /** Metres from the anchor. Absent keeps the distance the camera is at now. */
  range?: number;
  /** Degrees, in the anchor's local east-north-up frame. */
  orientation?: { heading?: number; pitch?: number };
  /** Flight seconds into the offset. `0` or absent cuts straight in. */
  duration?: number;
}

/** One entry of a camera track: where to look, and when. Degrees throughout, seconds for time. */
export interface Viewpoint {
  /** Where to stand. A viewpoint that rides an anchor states `follow` in place of it. */
  destination?: GlobePoint | GlobeExtent;
  /** What this viewpoint rides. The Core resolves it when the stop applies, never when it arrives. */
  follow?: FollowAnchor;
  /** Metres from the anchor, for a viewpoint that rides one. Ignored without `follow`. */
  range?: number;
  /** Degrees. Each angle is optional, and an angle left out keeps the one Cesium would choose. */
  orientation?: { heading?: number; pitch?: number; roll?: number };
  /** Flight time in seconds. `0` is a hard cut; absent leaves Cesium's distance-based default. */
  duration?: number;
  /** Absolute keyframe index to apply on. Excludes `after`. */
  at?: number;
  /** Seconds after the track was declared. Absolute per entry, not cumulative. Excludes `at`. */
  after?: number;
  /** Take the hold back from the viewer before applying this one. */
  take?: boolean;
  /** What the stop list calls this stop. Decoration: a row with none falls back to its schedule. */
  label?: string;
}

/**
 * Who is moving the camera, and what the server asked for. The camera-follow indicator and its stop
 * list render from exactly this.
 */
export interface CameraAuthority {
  /** True while the server holds the camera, so the Core applies a viewpoint that arrives. */
  readonly serverHolds: boolean;
  /** True while a non-empty track is installed. */
  readonly hasTrack: boolean;
  /**
   * The viewpoint the schedule says applies now, or null before the first applies. Recomputed while
   * the viewer holds the camera too, so rejoining goes where the track is now rather than where it
   * was when the user left.
   */
  readonly viewpoint: Viewpoint | null;
  /**
   * The whole installed track, in declared order, which is what the stop list renders. The same
   * array the scheduling reads, so the list is not a second source of truth.
   */
  readonly stops: readonly Viewpoint[];
  /** Index into `stops` of the one applied now, or -1 before the first applies. */
  readonly appliedIndex: number;
  /**
   * What the camera rides now, or null. This is a reference frame and not a third authority state:
   * it says what the camera moves relative to, while `serverHolds` says whether an arriving viewpoint
   * applies. The two are independent, and canvas input changes only the second.
   */
  readonly following: FollowAnchor | null;
  /** Ride an anchor, or clear the frame when handed null. */
  follow(request: FollowRequest | null): void;
  /**
   * Register a module's anchor resolver, keyed by the module's own id. Returns a Disposable that
   * unregisters. The Core calls it when a stop applies, and never reads the target string.
   */
  registerAnchors(module: string, resolve: AnchorResolver): () => void;
  /** Take the hold back and fly to `viewpoint`, in a short fixed flight. */
  rejoin(): void;
  /**
   * Put the tour at stop `i`, which is what clicking its row does. It takes the hold exactly as
   * `rejoin` does, and it flies in the same fixed time.
   *
   * A stop keyed `at` a keyframe moves the clock there, and the crossing rule carries the scene with
   * it. A stop paced `after` wall seconds re-arms the later ones from now, so the tour carries on
   * from there rather than ending. A stop scheduled by neither re-arms the whole wall-paced tour
   * from its start, because that stop is where the tour opens.
   */
  goToStop(i: number): void;
  /**
   * The instant the armed `after` timer for stop `i` fires at, in milliseconds on the wall clock, or
   * null where that stop has no timer armed. The countdown reads this, so it states the same
   * deadline the arming wrote rather than a second copy of the schedule.
   */
  deadlineAt(i: number): number | null;
  /** Called whenever any of the readable values changes. */
  onChange(cb: () => void): () => void;
  /** Install a whole `core/camera` payload, replacing whatever is held. An empty track clears it. */
  declare(payload: unknown): void;
  /** Report a keyframe crossing, which is what an `at` entry is scheduled against. */
  keyframeCrossed(index: number): void;
  /** Report a delivered window, which is where a re-grid becomes visible. */
  windowDelivered(): void;
  destroy(): void;
}

/**
 * The canvas input that takes the hold. Pointer input only: Cesium binds no key to the camera, so a
 * key press over the globe belongs to whatever module bound it, and detaching on one would end a
 * tour the user never touched. This listens for both spellings of the press, for the reason
 * `picking.ts` states: Cesium takes its input from pointer events where the browser has them and
 * suppresses the compatibility mouse events, so neither spelling alone sees every gesture. A second
 * detach for one press costs nothing.
 */
const INPUT_EVENTS = ["pointerdown", "mousedown", "wheel"];

/**
 * Seconds the flight back to the track takes. Fixed, and not the entry's own `duration`: the entry's
 * duration paces a tour, and rejoining is not part of the tour.
 */
const REJOIN_SECONDS = 1.5;

const isExtent = (d: unknown): d is GlobeExtent =>
  ["west", "south", "east", "north"].every(
    (k) => typeof (d as Record<string, unknown>)?.[k] === "number",
  );

const isPoint = (d: unknown): d is GlobePoint =>
  typeof (d as GlobePoint)?.lon === "number" && typeof (d as GlobePoint)?.lat === "number";

/** A bare vector for `Cartesian3.clone` to write into, which needs no Cesium to build. */
const v3 = () => ({ x: 0, y: 0, z: 0 }) as unknown as Cartesian3;

/** Where a camera sits relative to what it rides: two angles and a distance, radians and metres. */
type Seat = { heading: number; pitch: number; range: number };

const isAnchor = (a: unknown): a is FollowAnchor =>
  typeof (a as FollowAnchor)?.module === "string" && typeof (a as FollowAnchor)?.target === "string";

/** What the Core's clock says. `window` is the window last delivered, which states the declared
 * range an `at` index counts in and the grid a re-grid changes; `keyframe` is where the clock is. */
export interface SceneClock {
  window(): WindowInfo | null;
  keyframe(): number | null;
  /** Move the clock onto absolute keyframe `index`, which is what puts the tour at a keyed stop. */
  goToKeyframe(index: number): void;
}

/** Create the Core's camera authority over a scene. */
export function createCameraAuthority(
  scene: Scene,
  C: typeof import("@cesium/engine"),
  clock: SceneClock,
): CameraAuthority {
  // The server holds it at startup, or a viewpoint sent before anyone touches anything never lands
  // and a tour is dead before it begins (ADR-0017).
  let serverHolds = true;
  let track: Viewpoint[] = [];
  /** Index into `track` of the entry the schedule last applied, or -1 before the first. */
  let appliedIndex = -1;
  let timers: ReturnType<typeof setTimeout>[] = [];
  /**
   * When each armed `after` timer fires, in milliseconds on the wall clock, by index into `track`.
   * `arm` is the only writer and the countdown is the only other reader, so the panel predicts the
   * flight the timer actually makes.
   */
  const deadlines = new Map<number, number>();
  // The keyframe grid the installed track's `at` indices are counted on. Null until a window states
  // one, so a track declared before the first window adopts that window's grid instead of dropping.
  let grid: { epoch: JulianDate; dtSeconds: number } | null = null;
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.warn(`camera: onChange listener threw: ${err}`);
      }
    }
  };

  // --- The follow frame -------------------------------------------------------------------------
  //
  // While a frame is installed the Core hands the camera a fresh east-north-up frame at the anchor
  // every tick, on `scene.preUpdate`. That hook is the right one and the ordering is already
  // correct: a module blends its positions on `clock.onTick`, and `CesiumWidget.render` ticks the
  // clock before it renders, so the position the camera reads is the one this tick draws.
  //
  // `camera.lookAtTransform(frame)` on its own does NOT hold station. It keeps the camera's position
  // in the WORLD and re-expresses it in the new frame, so the camera stands still while the anchor
  // moves out from under it — measured drift for a satellite in low orbit is the satellite's own
  // speed, about 7.6 km every second. Handing it the offset as well does hold station, but it re-aims
  // the camera at the frame origin every tick, which erases a drag before the next frame draws.
  //
  // So the pose is carried across the handover by hand. `position`, `direction` and `up` are already
  // in frame coordinates while a transform is installed, so keeping them is a save and a restore.
  // `right` is not one of the three and is recomputed from the other two.
  const resolvers = new Map<string, AnchorResolver>();
  let following: FollowRequest | null = null;
  let anchorAt: AnchorPosition | null = null;
  let stopTicking: (() => void) | null = null;
  // Written into by `Cartesian3.clone`, which sets x, y and z on whatever it is handed, so these
  // need no constructor. One frame scratch, built on the first mount: a scene that never rides
  // anything never allocates it, and one that does reuses it every tick.
  const pose = { p: v3(), d: v3(), u: v3() };
  let frameScratch: ReturnType<typeof C.Transforms.eastNorthUpToFixedFrame> | null = null;
  /**
   * The move into a stated seat, while it runs: where the camera sat when it began, where it is
   * going, and the wall-clock span between. Null whenever the camera is not closing on a seat.
   */
  let approach: { from: Seat; to: Seat; t0: number; ms: number } | null = null;
  /**
   * The camera's height above the ellipsoid when it got on, in metres, or null while it rides
   * nothing. Getting off deliberately returns to it, so a ride reads as an excursion from the
   * altitude the reader came in at rather than as a one-way trip.
   */
  let heightOnMounting: number | null = null;

  const frameAt = (p: Cartesian3) => {
    frameScratch ??= new C.Matrix4();
    return C.Transforms.eastNorthUpToFixedFrame(p, scene.ellipsoid, frameScratch);
  };

  /** Whether a request says where to sit, as against only what to ride. */
  const statesASeat = (req: FollowRequest) =>
    req.range !== undefined || req.orientation?.heading !== undefined ||
    req.orientation?.pitch !== undefined;

  /** The short way round a circle: a turn from 350° to 10° is 20°, and never 340°. */
  const shortest = (d: number) => {
    const m = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return m > Math.PI ? m - Math.PI * 2 : m;
  };

  /** The seat `t` of the way from `a` to `b`, `t` already eased. */
  const between = (a: Seat, b: Seat, t: number) =>
    new C.HeadingPitchRange(
      a.heading + shortest(b.heading - a.heading) * t,
      a.pitch + (b.pitch - a.pitch) * t,
      a.range + (b.range - a.range) * t,
    );

  /** Where the camera sits in the frame it rides, which is where an approach starts from. */
  const seatNow = () => ({
    heading: scene.camera.heading,
    pitch: scene.camera.pitch,
    range: C.Cartesian3.magnitude(scene.camera.position),
  });

  const ride = () => {
    const at = anchorAt?.();
    // The family shrank under the anchor, or the module unloaded. Let go rather than freeze on the
    // last position it answered with.
    if (!at) {
      unfollow(`the anchor stopped answering`);
      return;
    }
    // Something else took the frame — the home button flies with `endTransform: Matrix4.IDENTITY`,
    // and so does anything else that means to leave. Let go instead of fighting it back every tick.
    const cam = scene.camera;
    if (C.Matrix4.equals(cam.transform, C.Matrix4.IDENTITY)) {
      unfollow();
      return;
    }
    if (approach) {
      // Closing on the seat inside the frame, so every step of the move is relative to the thing
      // being ridden and the camera arrives on it rather than beside it.
      const raw = (Date.now() - approach.t0) / approach.ms;
      const t = raw >= 1 ? 1 : raw * raw * (3 - 2 * raw);
      cam.lookAtTransform(frameAt(at), between(approach.from, approach.to, t));
      if (raw >= 1) approach = null;
      return;
    }
    C.Cartesian3.clone(cam.position, pose.p);
    C.Cartesian3.clone(cam.direction, pose.d);
    C.Cartesian3.clone(cam.up, pose.u);
    cam.lookAtTransform(frameAt(at));
    C.Cartesian3.clone(pose.p, cam.position);
    C.Cartesian3.clone(pose.d, cam.direction);
    C.Cartesian3.clone(pose.u, cam.up);
    C.Cartesian3.cross(pose.d, pose.u, cam.right);
  };

  /** Seat the camera on the anchor and start riding it. */
  const mount = (req: FollowRequest, at: AnchorPosition) => {
    const here = at();
    if (!here) return;
    const cam = scene.camera;
    const duration = req.duration ?? 0;
    // Read before the frame goes on, and while the camera still stands where the reader left it.
    heightOnMounting = C.Cartographic.fromCartesian(cam.positionWC, scene.ellipsoid)?.height ?? null;
    if (!statesASeat(req)) {
      // Nothing stated: mount in place. `lookAtTransform` keeps the camera's world position, so the
      // view does not move and starts riding from exactly where the user left it. There is nowhere
      // to fly to either, so a duration on such a request has nothing to pace.
      cam.lookAtTransform(frameAt(here));
    } else if (duration > 0) {
      // The frame goes on first, and the camera then closes on the seat inside it, tick by tick.
      //
      // The alternative is a world-space flight, and it cannot be made to work: `flyTo` is aimed
      // once, at a point that stops being where the anchor is the moment the anchor moves. A
      // satellite crossing 9° of longitude a second is most of a continent away by the time a
      // four-second flight lands, so the camera flies at empty ground and then snaps onto the thing.
      // Predicting the arrival only shrinks that error — riding first removes it.
      cam.lookAtTransform(frameAt(here));
      approach = { from: seatNow(), to: seatOf(req, here), t0: Date.now(), ms: duration * 1000 };
    } else {
      cam.lookAtTransform(frameAt(here), seatOf(req, here));
    }
    anchorAt = at;
    following = req;
    stopTicking = scene.preUpdate.addEventListener(ride);
    changed();
  };

  const startFollow = (req: FollowRequest) => {
    unfollow();
    const resolve = resolvers.get(req.module);
    if (!resolve) {
      console.warn(
        `core: camera cannot follow ${req.module}/${req.target} — no module ${req.module} offers ` +
          `an anchor resolver. The stop does nothing.`,
      );
      return;
    }
    const at = resolve(req.target);
    if (!at || !at()) {
      console.warn(
        `core: camera cannot follow ${req.module}/${req.target} — ${req.module} knows no such ` +
          `anchor now. The stop does nothing.`,
      );
      return;
    }
    mount(req, at);
  };

  /** How the request wants the camera to sit, against an anchor at `anchor`. */
  const seatOf = (req: FollowRequest, anchor: Cartesian3) => {
    const a = angles(req);
    return new C.HeadingPitchRange(
      a.heading ?? 0,
      a.pitch ?? -C.Math.PI_OVER_TWO,
      // No range stated keeps the distance the camera is at, so an offset that names only an angle
      // swings around the anchor instead of also rushing at it.
      req.range ?? C.Cartesian3.distance(scene.camera.positionWC, anchor),
    );
  };

  /** Let go of the anchor. Clears the frame, so nothing the camera does next is relative to it. */
  /**
   * Get off deliberately, which is the panel's control and a `follow: null` statement.
   *
   * Clearing the frame on its own leaves the camera hanging wherever the ride had it, tilted, aimed
   * at a thing that is already leaving. So it stands over the ground the anchor is above, looking
   * straight down and north up, at the height it had when it got on: the place the reader was
   * watching, at the altitude they came in from.
   *
   * Nothing else takes this route. A flight has its own destination, the home button is already
   * flying when the tick notices, and an anchor that stops answering has no ground to stand over.
   */
  const getOff = () => {
    const over = following ? anchorAt?.() ?? null : null;
    const height = heightOnMounting;
    unfollow();
    if (!over || height === null) return;
    const under = C.Cartographic.fromCartesian(over, scene.ellipsoid);
    if (!under) return;
    scene.camera.flyTo({
      destination: C.Cartesian3.fromRadians(under.longitude, under.latitude, height, scene.ellipsoid),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
      duration: REJOIN_SECONDS,
    });
  };

  const unfollow = (why?: string) => {
    stopTicking?.();
    stopTicking = null;
    approach = null;
    heightOnMounting = null;
    if (!following) return;
    if (why) console.warn(`core: camera stopped following ${following.module}/${following.target} — ${why}`);
    following = null;
    anchorAt = null;
    scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
    changed();
  };

  /** The angles an author stated, in radians, as Cesium wants them. */
  const angles = (v: { orientation?: { heading?: number; pitch?: number; roll?: number } }) => {
    const out: Record<string, number> = {};
    for (const k of ["heading", "pitch", "roll"] as const) {
      const deg = v.orientation?.[k];
      if (typeof deg === "number") out[k] = C.Math.toRadians(deg);
    }
    return out;
  };

  const fly = (v: Viewpoint) => {
    const d = v.destination;
    if (d === undefined) return;
    // A flight is computed in world coordinates whatever frame is installed, but the frame outlives
    // it, and a camera left in the frame of an anchor it has flown away from orbits that anchor on
    // the next drag. So a flight lets go first.
    unfollow();
    const options: Parameters<Scene["camera"]["flyTo"]>[0] = {
      destination: isExtent(d)
        ? C.Rectangle.fromDegrees(d.west, d.south, d.east, d.north)
        : C.Cartesian3.fromDegrees(d.lon, d.lat, d.height ?? 0),
    };
    // Each angle is carried over only where the author states it. Substituting a default for the
    // two an author left out levels a camera that asked to keep its tilt.
    if (v.orientation) options.orientation = angles(v);
    // Absent means Cesium's distance-based default, so the field is omitted rather than defaulted.
    if (typeof v.duration === "number") options.duration = v.duration;
    scene.camera.flyTo(options);
  };

  /** Apply a viewpoint: ride what it names, or fly where it points. */
  const go = (v: Viewpoint) => {
    if (v.follow) {
      startFollow({
        ...v.follow,
        range: v.range,
        orientation: v.orientation,
        duration: v.duration,
      });
    } else {
      fly(v);
    }
  };

  /** The schedule says entry `i` applies now. The move is the server's only if it holds. */
  const apply = (i: number) => {
    appliedIndex = i;
    const v = track[i];
    if (v.take) serverHolds = true;
    if (serverHolds) go(v);
    changed();
  };

  /**
   * Apply the latest entry the clock reaches at absolute keyframe `index` — the greatest `at` at or
   * below it — unless that entry is the applied one already.
   *
   * An entry scheduled by neither `at` nor `after` is the viewpoint the track opens on, and it
   * counts as keyed before every keyframe. So a clock that wraps at the end of a looping range, or
   * that scrubs back past the first keyed stop, returns to the opening viewpoint instead of holding
   * the last stop the tour reached.
   */
  const applyAt = (index: number) => {
    let pick = -1;
    let latest = -Infinity;
    track.forEach((v, i) => {
      if (v.after !== undefined) return;
      const at = v.at ?? -Infinity;
      if (at > index) return;
      if (at >= latest) {
        latest = at;
        pick = i;
      }
    });
    if (pick >= 0 && pick !== appliedIndex) apply(pick);
  };

  const detach = () => {
    // Abandoned wherever the camera has got to, and the ride goes on: a drag detaches and does not
    // dismount. Cleared ahead of the guard below, because a user already holding the camera can
    // still be part-way into a seat a later stop asked for.
    approach = null;
    if (!serverHolds) return;
    serverHolds = false;
    // Or the user's drag fights an easing camera for the rest of the flight.
    scene.camera.cancelFlight();
    changed();
  };

  const canvas = scene.canvas;
  for (const t of INPUT_EVENTS) canvas.addEventListener(t, detach, true);

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    deadlines.clear();
  };

  /**
   * Arm the wall-paced entries, counted from now. It first disarms every timer already standing, so
   * what it writes is the whole schedule.
   *
   * `base` is the `after` offset that "now" stands for. A declaration passes 0. A viewer who clicks
   * a stop passes that stop's own offset, so the rest of the tour keeps the gaps the author wrote.
   * `skip` is the entry the caller applies itself.
   *
   * Absolute per entry, never cumulative: a slow flight must not push the rest of the tour later.
   */
  const arm = (base: number, skip = -1) => {
    clearTimers();
    const now = Date.now();
    track.forEach((v, i) => {
      if (i === skip || v.after === undefined || v.after < base) return;
      const ms = (v.after - base) * 1000;
      deadlines.set(i, now + ms);
      timers.push(
        setTimeout(() => {
          deadlines.delete(i);
          apply(i);
        }, ms),
      );
    });
  };

  const drop = (why: string) => {
    console.warn(`core: camera track dropped — ${why}`);
    clearTimers();
    track = [];
    appliedIndex = -1;
    grid = null;
    changed();
  };

  /** One entry off the wire, or null where it is unusable. Warns and drops; never throws. */
  const validate = (raw: unknown, i: number): Viewpoint | null => {
    const e = (raw ?? {}) as Viewpoint;
    // A viewpoint states one of the two: where to stand, or what to ride. The anchor is not checked
    // against anything here — it is resolved when the stop applies, because the entity it names may
    // not exist yet and a `:replace` window can renumber the family under it.
    if (!isAnchor(e.follow) && !isPoint(e.destination) && !isExtent(e.destination)) {
      console.warn(
        `core: camera viewpoint ${i} states neither a destination nor a follow anchor; a ` +
          `destination must be {lon, lat, height} or {west, south, east, north} in degrees, and a ` +
          `follow must be {module, target}. Dropped.`,
      );
      return null;
    }
    const v: Viewpoint = { ...e };
    if (v.at !== undefined && v.after !== undefined) {
      console.warn(`core: camera viewpoint ${i} carries both at and after; taking at=${v.at}.`);
      delete v.after;
    }
    if (v.at !== undefined && !Number.isInteger(v.at)) {
      console.warn(`core: camera viewpoint ${i} has a non-integer at=${v.at}; it is an absolute ` +
        `keyframe index. Dropped.`);
      return null;
    }
    if (v.after !== undefined && !(typeof v.after === "number" && v.after >= 0)) {
      console.warn(`core: camera viewpoint ${i} has a non-numeric after=${v.after}. Dropped.`);
      return null;
    }
    // A label is decoration and a destination is not, so a bad label costs the label only.
    if (v.label !== undefined && typeof v.label !== "string") {
      console.warn(
        `core: camera viewpoint ${i} has a non-string label=${JSON.stringify(v.label)}; the label ` +
          `is dropped and the viewpoint stands.`,
      );
      delete v.label;
    }
    const total = clock.window()?.totalFrames;
    if (v.at !== undefined && total !== undefined && v.at >= total) {
      console.warn(
        `core: camera viewpoint ${i} keys at keyframe ${v.at}, past the declared range of ` +
          `${total} keyframes, so it never applies. A timeless scene is one keyframe and has no ` +
          `axis to key on — schedule it with after instead.`,
      );
    }
    return v;
  };

  return {
    get serverHolds() {
      return serverHolds;
    },
    get hasTrack() {
      return track.length > 0;
    },
    get viewpoint() {
      return track[appliedIndex] ?? null;
    },
    get stops() {
      return track;
    },
    get appliedIndex() {
      return appliedIndex;
    },
    get following() {
      return following && { module: following.module, target: following.target };
    },
    follow(request) {
      if (request) startFollow(request);
      else getOff();
    },
    registerAnchors(module, resolve) {
      resolvers.set(module, resolve);
      return () => {
        if (resolvers.get(module) !== resolve) return;
        resolvers.delete(module);
        // The module that answered for what the camera rides has gone, so the getter it handed over
        // is no longer backed by anything.
        if (following?.module === module) unfollow(`the module ${module} stopped answering`);
      };
    },
    rejoin() {
      serverHolds = true;
      const v = track[appliedIndex];
      if (v) go({ ...v, duration: REJOIN_SECONDS });
      changed();
    },
    goToStop(i) {
      const v = track[i];
      if (!v) return;
      // Clicking a stop takes the hold exactly as rejoining does, which makes rejoin the special
      // case of clicking the stop that applies now. Without it a click while the viewer holds the
      // camera would do nothing, which reads as a broken button (ADR-0017).
      serverHolds = true;
      appliedIndex = i;
      // The fixed rejoin flight, not the entry's own duration: the duration paces a tour, and
      // navigating to a stop is not touring.
      go({ ...v, duration: REJOIN_SECONDS });
      // The clock move raises a crossing, and `applyAt` then finds this entry applied already, so
      // the scene follows the camera and nothing flies twice. A stop scheduled by neither is where
      // the tour opens, so the wall-paced stops are armed from offset zero: arming nothing there
      // would end the tour on the one click that asks to start it again.
      if (v.at !== undefined) clock.goToKeyframe(v.at);
      else arm(v.after ?? 0, i);
      changed();
    },
    deadlineAt(i) {
      return deadlines.get(i) ?? null;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    declare(payload) {
      const p = (payload ?? {}) as { track?: unknown; follow?: unknown };
      // Two statements on one topic. `follow` sets or clears the frame and leaves the track alone,
      // which is how a listener answers a click without wiping a tour it did not author.
      if ("follow" in p) {
        if (p.follow === null) getOff();
        else if (isAnchor(p.follow)) startFollow(p.follow as FollowRequest);
        else console.warn(`core: camera follow needs {module, target}, or null to let go; ignored`);
        if (!("track" in p)) return;
      }
      const raw = p.track;
      if (!Array.isArray(raw)) {
        console.warn(`core: camera payload has no track list; ignored`);
        return;
      }
      const next: Viewpoint[] = [];
      for (const [i, e] of raw.entries()) {
        const v = validate(e, i);
        if (v) next.push(v);
      }
      // A whole declared set, replaced wholesale: the timers the last one left are its own.
      clearTimers();
      track = next;
      appliedIndex = -1;
      const info = clock.window();
      grid = info ? { epoch: info.epoch, dtSeconds: info.dtSeconds } : null;
      // An entry with neither schedule applies on arrival; an `at` entry waits for its crossing.
      track.forEach((v, i) => {
        if (v.at === undefined && v.after === undefined) apply(i);
      });
      arm(0);
      // The clock may already stand past the first keyframed entries — a retained track replayed on
      // reconnect, or one declared over a paused scene. Waiting for the next crossing would leave
      // the camera, and rejoin's target, on nothing until the clock moves again.
      const index = clock.keyframe();
      if (index !== null) applyAt(index);
      changed();
    },
    // Evaluated afresh on every crossing, so scrubbing backwards moves the camera back to the
    // viewpoint that keyframe was authored with.
    keyframeCrossed: applyAt,
    windowDelivered() {
      const info = clock.window();
      if (!info || track.length === 0) return;
      if (!grid) {
        // The first window states the grid a track declared ahead of it is counted on.
        grid = { epoch: info.epoch, dtSeconds: info.dtSeconds };
        return;
      }
      // Keyframe 120 means `epoch + 120 × dtSeconds`, so only these two move it. A replace does not,
      // and neither does a longer mission: a grown totalFrames leaves keyframe 120 where it was.
      if (info.dtSeconds === grid.dtSeconds && C.JulianDate.equals(info.epoch, grid.epoch)) return;
      drop(
        `the keyframe grid changed (startTime or dtSeconds), so every at index now means a ` +
          `different instant. Re-declare the track after the window that establishes the new grid.`,
      );
    },
    destroy() {
      clearTimers();
      unfollow();
      resolvers.clear();
      listeners.clear();
      for (const t of INPUT_EVENTS) canvas.removeEventListener(t, detach, true);
    },
  };
}
