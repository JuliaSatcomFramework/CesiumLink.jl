// Core-level windows: one `window` message carries a run of keyframes for the whole scene, with each
// module's payload addressed to it by name. Every module's data for the same frames therefore arrives
// together, so a scene and an overlay drawn on it cannot disagree about which window they describe.
//
// This file owns the whole of how a window becomes rendered keyframes: the *declared range* (epoch,
// keyframe step, total count) stated up front, the shared clock configured to loop over it, the
// delivered buffer and its coverage, the asking that tops it up, and the per-tick fan-out. The Core
// owns all of it; a module owns only its own arrays and the interpolation over them. Modules see
// three callbacks — one per delivered window, one per render tick with the bracketing absolute index
// and a blend fraction, and one per crossing into a keyframe — and never install a window or declare
// a schedule themselves.
//
// Coverage drives the asking: `onNeed` names the absolute index a window should start at and how many
// frames it should carry, both as playback nears the edge of the buffer it is heading for and when an
// instant outside it is scrubbed to. An uncovered instant paints nothing and holds the clock, so
// starvation reads as a pause on the last delivered frame rather than as a gap in the motion.
// Coverage is a *bounded* window that travels with the clock: it grows at the end playback is moving
// toward and is dropped from the other, so the buffer stays the same size whichever way the clock
// runs and reversing direction costs nothing until an edge is approached.
//
// No payload is ever inspected here beyond decoding its arrays, so this stays schema-agnostic and
// unit-testable with a stub clock — it touches Cesium only through the injected namespace `C`.
//
// A static scene is a window of one frame; a window is the only carrier of scene data there is.

import type { Clock, JulianDate } from "@cesium/engine";
// The extension is spelled out because a module's test imports this file directly, and `node --test`
// resolves a specifier literally.
import { decodeArrays } from "./codec.ts";
import { NO_BYTES } from "./transport.ts";

export type Disposable = () => void;

/**
 * How a window joins the buffer. `append` is a streaming advance: it preserves the index space, and
 * it extends coverage where it continues the frames already held. `replace` is a control re-push: it
 * clears coverage and may re-index. There is no third mode.
 */
export type InstallMode = "replace" | "append";

/** What a delivered window says about itself. Absolute indices, within the declared range. */
export interface WindowInfo {
  /** Absolute index of the payload's first frame. */
  startFrame: number;
  /** Keyframes in this window; every payload describes this many. */
  count: number;
  /** The window's identity, for supersession guards, or null if the server named none. */
  id: number | null;
  mode: InstallMode;
  /** The declared range — what the clock and ruler span, however little has been delivered. */
  totalFrames: number;
  dtSeconds: number;
  /** Mission time of absolute frame 0. */
  epoch: JulianDate;
}

/**
 * Where an absolute keyframe's values live: the window that carried it, and the offset within that
 * window's arrays. Every module needs this same mapping and none of them can derive it more cheaply
 * than the Core, which computed it to build the window in the first place.
 */
export interface Placement {
  window: WindowInfo;
  /** Window-relative keyframe index — `index - window.startFrame`, which is what a payload is cut by. */
  k: number;
}

/** What a module holds for one keyframe: the value its window carried, and the offset within it. */
export interface At<W> {
  w: W;
  /** Window-relative keyframe index, which is what a payload's per-keyframe arrays are cut by. */
  k: number;
}

/**
 * A store for what a window handed one module, keyed on the window itself. A module puts in whatever
 * it wants to address by window — a cast payload, or state it built from one — so the Core retains
 * nothing it was not handed.
 *
 * Key on the window object, never on `startFrame`. A control re-push gives the same absolute indices
 * to a different window, so a number-keyed map addresses the wrong one across the seam. The
 * `WeakMap` is also why this carries no retention bound of its own: a value becomes unreachable
 * exactly when the Core drops the last keyframe naming its window. The two cannot disagree about
 * how far back values reach.
 */
export class Timeline<W> {
  private wins = new WeakMap<WindowInfo, W>();
  /** The most recently installed value, or undefined before the first. */
  latest: W | undefined;

  /** Record what `window` carried. */
  install(w: W, window: WindowInfo): void {
    this.wins.set(window, w);
    this.latest = w;
  }

  /** What this holds at a placement the Core resolved, or undefined where it holds nothing. */
  at(p: Placement | null | undefined): At<W> | undefined {
    // Presence decides, not truth: a module may store any `W`, and `0`, `false` and `""` are all
    // values a window legitimately hands over.
    if (!p || !this.wins.has(p.window)) return undefined;
    return { w: this.wins.get(p.window)!, k: p.k };
  }

  clear(): void {
    this.wins = new WeakMap();
    this.latest = undefined;
  }
}

/**
 * Where the clock is between keyframes: bracketing absolute `index`, blend `alpha` toward `index+1`.
 *
 * This is where the *clock* is, whether or not the buffer covers it — a scrub past the delivered
 * frames still reports where the user went. It is therefore not necessarily an index any module
 * holds data for; a module's own lookup misses and it draws nothing, which is the same thing the
 * held clock is already saying.
 */
export interface Frame {
  index: number;
  alpha: number;
}

// A timeline a server sent no epoch for still has to open somewhere.
const SYNTHETIC_EPOCH = "2020-01-01T00:00:00Z";

// The wall-clock seconds a keyframe interval plays over when the server states none — the pace is
// fixed in wall-clock time whatever the mission step, so a run is watchable at any `dtSeconds`.
const DEFAULT_INTERVAL_SECONDS = 1.5;

// Keyframes of lead time: the next window is asked for once playback is this close to the edge of
// the buffer it is heading for, so the server has a whole interval or two to answer before the
// buffer runs dry. One constant rather than a knob — a module that needs a different lead
// has not turned up, and the pace is fixed in wall-clock time per interval anyway.
const LOOKAHEAD_FRAMES = 2;

// Frames the delivered buffer holds at once. Playback eats into the buffer from one end and is
// topped up at the other, so the bound is applied by dropping from the end the clock is moving away
// from: the retained frames follow it whichever way it runs, and a scrub back within them costs
// nothing. Reversing direction moves no frames on its own — it only swaps which end grows and which
// is dropped as playback next approaches an edge.
const BUFFER_FRAMES = 8;

// Frames a window that lands somewhere new must carry: interpolation reads `frames[i]` and
// `frames[i+1]`, so a lone frame would leave positions frozen until the next window arrived. One
// frame is enough only where the window continues a buffer that already holds its neighbour.
const LANDING_FRAMES = 2;

type CesiumRuntime = typeof import("@cesium/engine");

/**
 * Bracketing keyframe for `elapsed` seconds into an evenly-spaced (`dt`) sequence of `n`
 * frames: index `i ∈ [0, n-2]` and blend `alpha ∈ [0, 1]` toward frame `i+1`. For `n ≥ 2`,
 * clamped at both ends so callers can always read `frames[i]` and `frames[i+1]`; for `n < 2`
 * it returns `{i:0, alpha:0}`, so the caller must tolerate a missing `frames[i+1]`.
 *
 * Exported only so the tests can exercise the clamping directly; nothing outside this file calls it,
 * and nothing outside a test should.
 */
export function bracket(elapsed: number, dt: number, n: number): { i: number; alpha: number } {
  if (n < 2 || dt <= 0) return { i: 0, alpha: 0 };
  const span = (n - 1) * dt;
  if (elapsed <= 0) return { i: 0, alpha: 0 };
  if (elapsed >= span) return { i: n - 2, alpha: 1 };
  const i = Math.floor(elapsed / dt);
  return { i, alpha: (elapsed - i * dt) / dt };
}

/** The `window` message's params, as they arrive (arrays still encoded). */
interface WireWindow {
  startFrame?: number;
  count?: number;
  mode?: string;
  window?: number | null;
  totalFrames?: number;
  dtSeconds?: number;
  intervalSeconds?: number;
  startTime?: string;
  payloads?: Record<string, unknown>;
}

interface WindowsDeps {
  clock: Clock;
  C: CesiumRuntime;
  /** The buffer should cover `count` frames from absolute `startFrame`. */
  onNeed(startFrame: number, count: number): void;
  /** A newly declared range: point the shared timeline ruler at it. */
  onRange(start: JulianDate, stop: JulianDate): void;
  /**
   * The playback state changed: the signed clock `multiplier` — its sign is the direction and its
   * size the speed — and whether the user wants playback on. The first tick calls this too, so the
   * opening state reaches the server without waiting for someone to change it.
   */
  onClock?(multiplier: number, playing: boolean): void;
  /**
   * The clock crossed into absolute keyframe `index`. Every crossing the modules are driven by, and
   * only those: an instant the buffer does not cover raises `onNeed` instead, so this says the
   * clock is running over frames the scene can paint.
   */
  onCrossing?(index: number): void;
  onWarn?(message: string): void;
}

export interface Windows {
  /**
   * Where the clock is now, or null before the first tick of a declared range. This is the frame the
   * user is on — the one an outgoing event is stamped with, so a control answered by the server gets
   * a window that repaints (see `Frame`).
   */
  readonly frame: Frame | null;
  /** The window the scene currently shows, or null before the first is delivered. */
  readonly info: WindowInfo | null;
  /** Deliver this module's payload from each window that carries one. */
  onWindow(moduleId: string, cb: (w: WindowInfo, payload: unknown) => void): Disposable;
  onFrame(cb: (f: Frame) => void): Disposable;
  /**
   * A handler for each crossing into an absolute keyframe. A handler registered after a crossing
   * already happened is called for that one on the microtask that follows, so neither registration
   * order nor the order a module registers its own callbacks in decides whether it has drawn.
   */
  onKeyframe(cb: (index: number) => void): Disposable;
  /**
   * The window carrying absolute keyframe `index` and the offset within it, or null where no
   * retained window covers it. This is the mapping every module needs to read its own arrays, and
   * the Core is the only thing that can answer it without a second copy of the bookkeeping.
   */
  placement(index: number): Placement | null;
  /** The mission instant absolute keyframe `index` was computed for, or null before any window. */
  keyframeTime(index: number): JulianDate | null;
  /** Move the clock onto absolute keyframe `index` and park it there. */
  goToKeyframe(index: number): void;
  /**
   * Install a `window` message, straight off the wire, with the region its arrays point into.
   * A message carrying no arrays needs no region.
   */
  deliver(params: unknown, region?: Uint8Array): void;
  dispose(): void;
}

/** Parse an optional ISO-8601 mission epoch, falling back to the synthetic one on absent/bad input. */
function parseEpoch(C: CesiumRuntime, startTime: string | undefined, warn: (m: string) => void) {
  try {
    return C.JulianDate.fromIso8601(startTime ?? SYNTHETIC_EPOCH);
  } catch {
    warn(`window: unparseable startTime ${JSON.stringify(startTime)} — using synthetic epoch`);
    return C.JulianDate.fromIso8601(SYNTHETIC_EPOCH);
  }
}

export function createWindows(deps: WindowsDeps): Windows {
  const { clock, C } = deps;
  const warn = deps.onWarn ?? ((m: string) => console.warn(m));

  // Per module: the callbacks wanting that module's payload. Fanned out only to ids the window's
  // payload map names, so a module absent from it is not called for that window.
  const windowCbs = new Map<string, Set<(w: WindowInfo, payload: unknown) => void>>();
  const frameCbs = new Set<(f: Frame) => void>();
  const keyframeCbs = new Set<(index: number) => void>();

  // The declared range the clock is currently configured for; a window declaring a different one is a
  // different run, so the clock is reconfigured rather than stretched under the scene. Null until the
  // first window, which is what stops the tick loop reporting a frame of a range nobody declared.
  let range: { totalFrames: number; dtSeconds: number; intervalSeconds: number } | null = null;
  let epoch: JulianDate | null = null;
  let info: WindowInfo | null = null;
  // Where the clock is, updated every tick whether or not the buffer covers it. One index, so the
  // frame an event is stamped with and the frame the modules are driven by cannot drift apart.
  let frame: Frame | null = null;
  // Absolute indices the delivered buffer covers, or null while it is empty.
  let coverage: { first: number; last: number } | null = null;
  // The last index a crossing was reported for; -1 means none yet, so the first covered tick fires
  // one whatever index it lands on.
  let lastI = -1;
  // The absolute start of the window already asked for, or -1 when nothing is pending. Cleared by
  // every install, so a request the server never answered is re-sent rather than lost.
  let asked = -1;
  // The clock is held while the buffer does not reach the current instant, and lifts as soon as
  // that instant is covered.
  //
  // The hold clears `canAnimate`, never `shouldAnimate`. Cesium ticks only when both are set, and
  // documents `canAnimate` for exactly this ("data is being buffered"), which leaves `shouldAnimate`
  // meaning one thing: whether the user wants playback. That separation is the whole point. One flag
  // carrying both loses a pause pressed during a hold — the hold has already written false, so the
  // press changes nothing this code can see, and the release puts playback back on. There is nothing
  // to remember and nothing to restore: whatever the user last asked for is still sitting in
  // `shouldAnimate`, including a control operated while paused, which stays paused.
  let stalled = false;
  let installed = false;
  // Per module: the last payload delivered to it, with the window it arrived on — a module that
  // finishes importing after a window landed is handed it on registration rather than staring at an
  // empty scene until the next one. The window travels with the payload because an `append` updates
  // only the modules it names, so the newest window is not the one every held payload came from.
  // One window per module — enough for the opening `replace`, which is what a late import
  // actually races. A module that misses an intermediate `append` sees the gap close on the next one.
  let held = new Map<string, { info: WindowInfo; payload: unknown }>();
  // Absolute keyframe index → the window carrying it. Every module reads its own arrays through
  // this, so it is kept once here rather than rebuilt identically in each of them.
  //
  // It holds exactly what `coverage` claims, no more and no less. Coverage says *which* frames the
  // clock can be run over; this says which window each of them came from, and several windows can
  // sit inside one coverage after an append. Anything outside coverage is unreachable — a tick
  // there paints nothing and holds the clock while the Core asks for a window — so retaining it
  // would pin payloads nothing can read. Deriving the bound from coverage rather than stating a
  // second one is what stops the two disagreeing about how far back values reach.
  let frames = new Map<number, WindowInfo>();

  const each = <T>(cbs: Iterable<(arg: T) => void>, arg: T, what: string) => {
    for (const cb of [...cbs]) {
      try {
        cb(arg);
      } catch (err) {
        // One module's throwing callback must not take down the frame loop or the other modules.
        warn(`window: ${what} callback threw: ${err}`);
      }
    }
  };

  // Crossings reported so far. A late handler is told the one already on screen, and this is how it
  // learns whether a real one reached it first — the index alone cannot say, because a re-push
  // re-fires the very index the handler is waiting to be told about.
  // The playback state last reported upward. Undefined until the first tick, which is what makes
  // that tick state the opening values rather than compare against a guess.
  let saidMultiplier: number | undefined;
  let saidPlaying: boolean | undefined;
  /**
   * Report the clock's direction, speed and play/pause when either has changed. Read every tick
   * because nothing announces a write to them: the Animation widget, a scrub and this file all set
   * them directly. Only a change is sent, so a still clock costs nothing — but a shuttle-ring drag
   * writes a new multiplier per rendered frame and sends one event per frame while it lasts.
   */
  const reportClock = (c: Clock) => {
    const playing = !!c.shouldAnimate;
    if (c.multiplier === saidMultiplier && playing === saidPlaying) return;
    saidMultiplier = c.multiplier;
    saidPlaying = playing;
    try {
      deps.onClock?.(c.multiplier, playing);
    } catch (err) {
      warn(`window: onClock threw: ${err}`);
    }
  };

  let crossings = 0;
  const fireKeyframe = (i: number) => {
    crossings++;
    // The clock first, always. A window declaring a new range writes the multiplier and the play
    // flag itself and then crosses, all before the next tick — so a crossing published on its own
    // would reach the server under the direction and speed of the run that just ended. The change
    // check makes this free on the crossings a tick already reported the clock for.
    reportClock(clock);
    try {
      deps.onCrossing?.(i);
    } catch (err) {
      warn(`window: onCrossing(${i}) threw: ${err}`);
    }
    each(keyframeCbs, i, "onKeyframe");
  };

  const covers = (i: number) => coverage !== null && i >= coverage.first && i <= coverage.last;
  const keyframeTime = (index: number) =>
    range === null || epoch === null
      ? null
      : C.JulianDate.addSeconds(epoch, index * range.dtSeconds, new C.JulianDate());
  // Call after every change to the hold flag. A clock running over frames nothing can paint
  // advances the ruler across an empty scene, so it stays down until the hold clears.
  const applyHold = () => {
    clock.canAnimate = !stalled;
  };
  /** Ask for `count` frames from absolute `from`, once — a repeat every tick would flood. */
  const need = (from: number, count: number) => {
    if (range === null || from === asked || from >= range.totalFrames || from < 0) return;
    asked = from;
    try {
      deps.onNeed(from, count);
    } catch (err) {
      warn(`window: onNeed(${from}) threw: ${err}`);
    }
  };

  function tick(c: Clock): void {
    reportClock(c);
    // Nothing is declared until the first window lands, and a clock ticking before then is running
    // over a range this file never configured.
    if (range === null) return;
    const { totalFrames: n, dtSeconds } = range;
    const elapsed = C.JulianDate.secondsDifference(c.currentTime, c.startTime);
    const { i, alpha } = bracket(elapsed, dtSeconds, n);
    frame = { index: i, alpha };
    if (!covers(i)) {
      // Paint nothing and hold: the last delivered frame stands, so an undelivered instant reads as
      // a pause rather than as the wrong frame or a stutter. Nothing is held before the first
      // install — the opening window is already on its way, and holding here would leave the clock
      // restored to the "not started yet" state it was declared in.
      if (!installed) return;
      // Held on every uncovered tick, not just the first: nothing else stops the clock being
      // started again while the buffer is still short of where it is.
      stalled = true;
      applyHold();
      // The buffer holds nothing next to this instant, so the window that covers it has to bring its
      // own successor to interpolate toward.
      need(i, LANDING_FRAMES);
      return;
    }
    if (stalled) {
      stalled = false;
      applyHold();
    }
    // Ask for the continuation before the buffer runs dry, so a streaming advance lands while there
    // are still frames to play — on the side the clock is heading for. A clock running backwards
    // consumes the buffer from its first frame down, and asking ahead of it would top up the end it
    // is moving away from while it starved at the one it is moving toward. Nothing to ask for once
    // coverage reaches that end of the run. One frame either way: it continues a buffer that already
    // holds the neighbour to interpolate with, so nothing more is produced before the clock can use it.
    if (c.multiplier >= 0) {
      if (coverage!.last < n - 1 && i >= coverage!.last - LOOKAHEAD_FRAMES) need(coverage!.last + 1, 1);
    } else if (coverage!.first > 0 && i <= coverage!.first + LOOKAHEAD_FRAMES) {
      need(coverage!.first - 1, 1);
    }
    if (i !== lastI) {
      // Advance before the call so a persistently-throwing crossing is attempted once, not re-fired
      // every tick. The callback is synchronous and, absent a throw, non-bailing — discrete state
      // (colours, link membership) must not lag a keyframe behind.
      lastI = i;
      fireKeyframe(i);
    }
    each(frameCbs, { index: i, alpha }, "onFrame");
  }
  const removeTick = clock.onTick.addEventListener(tick);

  /**
   * Point the clock at a newly declared range and drop everything the previous one had. Nothing of
   * the old run survives a range change, so a window declaring one joins as a `replace` whatever it
   * asked for — there is no buffer left to extend.
   */
  function declareRange(
    declared: NonNullable<typeof range>,
    start: JulianDate,
  ): void {
    const { totalFrames: n, dtSeconds, intervalSeconds } = declared;
    range = declared;
    epoch = start;
    // A degenerate single-frame range has zero span; keep the range ≥ 1s so the clock isn't empty.
    const spanSeconds = Math.max((n - 1) * dtSeconds, 1);
    // The clock owns three independent instants: Cesium advances currentTime in place, so it must not
    // alias startTime or stopTime. addSeconds into a fresh result is a clone.
    clock.startTime = C.JulianDate.addSeconds(start, 0, new C.JulianDate());
    clock.stopTime = C.JulianDate.addSeconds(start, spanSeconds, new C.JulianDate());
    clock.currentTime = C.JulianDate.addSeconds(start, 0, new C.JulianDate());
    clock.clockRange = C.ClockRange.LOOP_STOP;
    clock.clockStep = C.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    clock.multiplier = dtSeconds / intervalSeconds;
    // The range is declared but no frame is delivered yet; the first install decides whether it plays.
    clock.shouldAnimate = false;
    clock.canAnimate = true;
    frame = null;
    coverage = null;
    lastI = -1;
    asked = -1;
    stalled = false;
    installed = false;
    deps.onRange(clock.startTime, clock.stopTime);
  }

  /**
   * Add a window to the buffer, lifting any hold on the clock. Returns the absolute index the
   * crossing this install implies must fire at, or null where it implies none. The caller fires it,
   * because it must reach the modules only once the placements match the new coverage.
   */
  function install(win: WindowInfo): number | null {
    const end = win.startFrame + win.count - 1;
    const wasSpan = coverage === null ? 0 : coverage.last - coverage.first + 1;
    let extended = true;
    if (win.mode === "append" && coverage !== null && win.startFrame === coverage.last + 1) {
      // A streaming advance extends coverage and must not disturb the reported index — the user
      // asked for nothing, so nothing may move at the seam (ADR-0008). Only a window that
      // continues the buffer extends it: one that leaves a gap or overlaps cannot be interpolated
      // across, so it starts a fresh buffer instead of claiming coverage of frames nobody holds.
      coverage = { first: coverage.first, last: end };
    } else if (win.mode === "append" && coverage !== null && end === coverage.first - 1) {
      // The same advance, on the other side: a clock running backwards is served windows that
      // continue the buffer downwards, and they extend it exactly as forward ones do.
      coverage = { first: win.startFrame, last: coverage.last };
    } else {
      // A window that continues nothing starts the buffer afresh and may re-index, so the crossing
      // below is re-fired for the index the clock is already at.
      coverage = { first: win.startFrame, last: end };
      extended = false;
    }
    // Bound what streaming accumulates, dropping from the end the clock is moving away from — the
    // frames it is least likely to want next, and the ones the server's own window has already let
    // go. Only an extension is bounded: a server that delivers a whole run in one window is handed
    // it entire, so the bound governs what the buffer grows to rather than what it was given.
    const cap = Math.max(BUFFER_FRAMES, wasSpan);
    if (extended && coverage.last - coverage.first + 1 > cap) {
      const trimmed = clock.multiplier >= 0
        ? { first: coverage.last - cap + 1, last: coverage.last }
        : { first: coverage.first, last: coverage.first + cap - 1 };
      // The bound must never drop the frame the clock stands on. The continuation is asked for
      // `LOOKAHEAD_FRAMES` before the edge, so it lands while the clock is still short of it, and a
      // bound of one window's length would otherwise leave coverage holding the new window alone.
      // The clock would then be outside the buffer it just grew: it stalls, asks for a window it
      // was already given, and crosses the seam a second time. Keep the frames it has yet to play
      // through, and a streaming advance costs one window's work at the seam rather than three.
      const i = frame?.index;
      if (i !== undefined) {
        if (clock.multiplier >= 0) trimmed.first = Math.min(trimmed.first, i);
        else trimmed.last = Math.max(trimmed.last, i + 1);
      }
      coverage = trimmed;
    }
    // A window answers whatever was pending; the next tick decides what to ask for next.
    asked = -1;
    stalled = false;
    applyHold();
    // The opening window is what decides whether a declared range plays at all; after that,
    // `shouldAnimate` is the user's and an arriving window never writes it.
    if (!installed) clock.shouldAnimate = win.totalFrames > 1;
    installed = true;
    // A window that extends the buffer implies no crossing: it adds later keyframes, and the window
    // that already drew the current index still carries it.
    if (extended) return null;
    // Any other window re-indexes, so every module must restyle for wherever the clock already
    // sits. The Core reports that crossing rather than leaving each module to draw once by hand:
    // waiting for the next tick shows one frame of unstyled scene.
    const i = frame?.index ?? win.startFrame;
    if (!covers(i)) {
      // The new buffer says nothing about where the clock is, so no module can draw that index yet.
      // Leave the crossing unreported: `lastI` of -1 makes the first tick a window covers it fire
      // one, which a crossing consumed here would have suppressed for good.
      lastI = -1;
      return null;
    }
    // `lastI` takes the index rather than -1, which is what stops the next tick firing the same
    // crossing a second time.
    lastI = i;
    return i;
  }

  function deliver(params: unknown, region: Uint8Array = NO_BYTES): void {
    const p = (params ?? {}) as WireWindow;
    const startFrame = p.startFrame;
    const count = p.count;
    if (!Number.isInteger(startFrame) || !Number.isInteger(count) || count! < 1 || startFrame! < 0) {
      warn(`window: startFrame/count must be a 0-based index and a positive count; ignored`);
      return;
    }
    const totalFrames = Number.isInteger(p.totalFrames) ? p.totalFrames! : startFrame! + count!;
    const dtSeconds = typeof p.dtSeconds === "number" && p.dtSeconds > 0 ? p.dtSeconds : 1;
    const intervalSeconds =
      typeof p.intervalSeconds === "number" && p.intervalSeconds > 0
        ? p.intervalSeconds
        : DEFAULT_INTERVAL_SECONDS;
    let mode: InstallMode = p.mode === "append" ? "append" : "replace";

    const declared = { totalFrames, dtSeconds, intervalSeconds };
    const parsed = parseEpoch(C, p.startTime, warn);
    const sameRange =
      range !== null && epoch !== null &&
      range.totalFrames === declared.totalFrames && range.dtSeconds === declared.dtSeconds &&
      range.intervalSeconds === declared.intervalSeconds &&
      C.JulianDate.equals(epoch, parsed);
    if (!sameRange) {
      mode = "replace";
      declareRange(declared, parsed);
    }

    const next: WindowInfo = {
      startFrame: startFrame!,
      count: count!,
      id: p.window ?? null,
      mode,
      totalFrames,
      dtSeconds,
      epoch: parsed,
    };
    // The whole of the Core's payload knowledge: every `{$wire}` object becomes a typed array, at
    // whatever depth it sits. Nothing else about a payload is interpreted here.
    const payloads = (decodeArrays(p.payloads ?? {}, region) ?? {}) as Record<string, unknown>;
    info = next;
    // A replace may re-index, so nothing addressed against what came before survives it.
    if (mode === "replace") {
      held = new Map();
      frames = new Map();
    }
    for (const [id, payload] of Object.entries(payloads)) held.set(id, { info: next, payload });
    // A re-delivered keyframe belongs to whichever window carried it last.
    for (let k = 0; k < next.count; k++) frames.set(next.startFrame + k, next);

    // Hand the modules their arrays before the buffer claims coverage of them: installing lifts a
    // stall, and a tick must never find coverage the modules cannot yet draw.
    for (const [id, payload] of Object.entries(payloads)) {
      const cbs = windowCbs.get(id);
      if (!cbs) continue;
      for (const cb of [...cbs]) {
        try {
          cb(next, payload);
        } catch (err) {
          warn(`module ${id}: onWindow threw: ${err}`);
        }
      }
    }
    const crossing = install(next);
    // Installing is what decides the new coverage, so the placements follow it rather than a bound
    // of their own: a streamed window trims the frames the buffer just let go, and a window
    // carrying a whole run keeps every frame of it, because coverage claims every frame of it.
    for (const index of frames.keys()) {
      if (index < coverage!.first || index > coverage!.last) frames.delete(index);
    }
    // The crossing follows the trim, so a module that reads `placement` while it runs sees exactly
    // the coverage the next tick would, and never a window the trim is about to drop.
    if (crossing !== null) fireKeyframe(crossing);
  }

  const remover = <T>(set: Set<T>, cb: T): Disposable => {
    set.add(cb);
    return () => set.delete(cb);
  };

  return {
    get frame() {
      return frame;
    },
    get info() {
      return info;
    },
    onWindow(moduleId, cb) {
      let cbs = windowCbs.get(moduleId);
      if (!cbs) windowCbs.set(moduleId, (cbs = new Set()));
      cbs.add(cb);
      // A module whose import finished after the window landed is handed it here, so registration
      // order does not decide whether it has a scene.
      const last = held.get(moduleId);
      if (last) {
        try {
          cb(last.info, last.payload);
        } catch (err) {
          warn(`module ${moduleId}: onWindow threw: ${err}`);
        }
      }
      return () => cbs.delete(cb);
    },
    onFrame: (cb) => remover(frameCbs, cb),
    onKeyframe(cb) {
      const dispose = remover(keyframeCbs, cb);
      // A module whose import finished after the window landed is handed that window through
      // `onWindow`. The crossing it implies is handed over here, one microtask later. The wait is
      // what frees the module from registering its two callbacks in a set order: `onWindow`
      // delivers its held payload at once, so the store holds the window either way.
      const missed = lastI;
      const before = crossings;
      if (missed >= 0) {
        queueMicrotask(() => {
          // A real crossing has reached this handler already, or it is disposed. Either way it
          // wants nothing.
          if (crossings === before && keyframeCbs.has(cb)) each([cb], missed, "onKeyframe");
        });
      }
      return dispose;
    },
    placement(index) {
      const window = frames.get(index);
      return window ? { window, k: index - window.startFrame } : null;
    },
    keyframeTime,
    goToKeyframe(index) {
      const time = keyframeTime(index);
      if (!time) return;
      clock.currentTime = time;
      // Parked, and staying parked: moving the clock deliberately is a pause in the same sense the
      // widget's button is, so a stall that lifts afterwards finds a paused clock and leaves it
      // paused.
      clock.shouldAnimate = false;
    },
    deliver,
    dispose() {
      removeTick();
      clock.shouldAnimate = false;
      clock.canAnimate = true;
      range = null;
      epoch = null;
      info = null;
      frame = null;
      coverage = null;
      lastI = -1;
      asked = -1;
      stalled = false;
      installed = false;
      held = new Map();
      frames = new Map();
      windowCbs.clear();
      frameCbs.clear();
      keyframeCbs.clear();
    },
  };
}
