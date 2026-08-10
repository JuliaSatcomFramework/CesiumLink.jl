// Runnable check for the Core camera authority. Run: node lib/core/src/camera.test.mjs
// (transpiles camera.ts in-memory via esbuild — no Cesium, no WebGL, a faked canvas and camera.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const src = await readFile(new URL("./camera.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { createCameraAuthority } = await import("data:text/javascript," + encodeURIComponent(code));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
/** The fake's identity matrix. Any object carrying the flag reads as one, as a clone of it would. */
const IDENTITY = { identity: true };
const isIdentity = (m) => m?.identity === true;

// A stub scene: a canvas that records its capture listeners so the test can deliver a DOM event the
// way a browser does, and a camera that records every flight instead of flying one.
function harness(window = null, keyframe = null) {
  const captured = [];
  const canvas = {
    addEventListener: (type, fn, capture) => captured.push([type, fn, capture]),
    removeEventListener: (type, fn) => {
      const i = captured.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) captured.splice(i, 1);
    },
  };
  const flights = [];
  let cancels = 0;
  // A camera that records instead of moving. Its `transform` is the follow frame, and the fake
  // builds a frame as the position it was made from, which is what the follow tests assert on.
  const seats = [];
  const ticks = [];
  const camera = {
    transform: IDENTITY,
    position: v3(), direction: v3(0, 0, -1), up: v3(0, 1, 0), right: v3(1, 0, 0),
    // Where the camera sits in the frame it rides. An approach reads these for the seat it starts
    // from, the way Cesium reports them against whatever transform is installed.
    heading: 0, pitch: 0,
    positionWC: v3(7000000, 0, 800),
    flyTo: (o) => flights.push(o),
    cancelFlight: () => { cancels++; },
    // What Cesium's own HomeButton calls. Nothing here watches it, which is the point.
    flyHome: () => flights.push({ home: true }),
    lookAtTransform: (transform, offset) => {
      camera.transform = transform;
      seats.push({ frame: transform, offset: offset ?? null });
    },
  };
  const scene = {
    canvas,
    camera,
    ellipsoid: { name: "wgs84" },
    preUpdate: {
      addEventListener: (fn) => {
        ticks.push(fn);
        return () => {
          const i = ticks.indexOf(fn);
          if (i >= 0) ticks.splice(i, 1);
        };
      },
    },
  };
  const C = {
    Cartesian3: Object.assign(
      function Cartesian3(x, y, z) { return v3(x, y, z); },
      {
        fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
        fromRadians: (lon, lat, height) => ({ lon, lat, height }),
        clone: (a, out) => Object.assign(out ?? v3(), { x: a.x, y: a.y, z: a.z }),
        cross: (a, b, out) => Object.assign(out, { x: 0, y: 0, z: a.x * b.y - a.y * b.x }),
        distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
        magnitude: (a) => Math.hypot(a.x, a.y, a.z),
      },
    ),
    Matrix4: Object.assign(
      function Matrix4() { return IDENTITY; },
      // By value, not by reference: Cesium's `_setTransform` clones what it is handed, so the
      // identity a camera carries is never the identity object that was passed in.
      { IDENTITY, equals: (a, b) => isIdentity(a) === isIdentity(b), clone: (a) => a },
    ),
    // A frame is recorded as the position it was built from — the fake has no matrix arithmetic and
    // the tests only ask which position the camera was handed.
    Transforms: { eastNorthUpToFixedFrame: (p, ellipsoid) => ({ at: { ...p }, ellipsoid }) },
    HeadingPitchRange: function HeadingPitchRange(heading, pitch, range) {
      return { heading, pitch, range };
    },
    Rectangle: { fromDegrees: (west, south, east, north) => ({ west, south, east, north }) },
    // The fake carries a position's components straight through as lon/lat/height, so a test reads
    // which point the camera was sent to rather than any geodesy.
    Cartographic: { fromCartesian: (p) => ({ longitude: p.x, latitude: p.y, height: p.z }) },
    Math: { toRadians: (d) => d * 2, PI_OVER_TWO: Math.PI / 2 },
    JulianDate: { equals: (a, b) => a.t === b.t },
  };
  let win = window;
  let key = keyframe;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  // The clock move a keyed stop makes. It records rather than moves, and a case that wants the
  // crossing that follows calls `keyframeCrossed` itself, the way the tick would.
  const moves = [];
  const authority = createCameraAuthority(scene, C, {
    window: () => win,
    keyframe: () => key,
    goToKeyframe: (index) => moves.push(index),
  });
  return {
    camera: authority,
    scene,
    flights,
    warnings,
    moves,
    seats,
    /** Run one render tick, the way `CesiumWidget.render` raises `preUpdate`. */
    tick: () => { for (const fn of [...ticks]) fn(); },
    ticking: () => ticks.length,
    /** The anchor position the frame on the camera was built from, or null with no frame. */
    frameAt: () => camera.transform?.at ?? null,
    cancels: () => cancels,
    registered: () => captured.map(([t, , c]) => `${t}:${c === true}`),
    setWindow: (w) => { win = w; },
    setKeyframe: (k) => { key = k; },
    dom: (type) => {
      for (const [t, fn] of captured) if (t === type) fn({ type });
    },
    restore: () => { console.warn = realWarn; },
  };
}

/** A window as `windows.deliver` builds it: the declared grid an `at` index is counted on. */
const win = (t, dtSeconds = 60, totalFrames = 100) => ({
  epoch: { t }, dtSeconds, totalFrames, startFrame: 0, count: totalFrames, id: null, mode: "replace",
});

const point = (lon, lat, height = 0) => ({ lon, lat, height });

// --- a viewpoint applies while the server holds the camera, and is ignored once the user takes it ---
{
  const h = harness(win(0));
  assert.equal(h.camera.serverHolds, true, "the server holds the camera at startup (ADR-0017)");
  h.camera.declare({ track: [{ destination: point(10, 20, 300) }] });
  assert.equal(h.flights.length, 1, "an unscheduled viewpoint applies on arrival");
  assert.deepEqual(h.flights[0].destination, { lon: 10, lat: 20, height: 300 });
  assert.equal(h.camera.hasTrack, true);
  assert.deepEqual(h.camera.viewpoint.destination, point(10, 20, 300));

  h.dom("pointerdown");
  assert.equal(h.camera.serverHolds, false, "canvas input takes the hold");
  assert.equal(h.cancels(), 1, "and cancels the flight in progress");

  h.camera.declare({ track: [{ destination: point(1, 2) }] });
  assert.equal(h.flights.length, 1, "a viewpoint arriving after that is an offer, and is not applied");
  assert.deepEqual(h.camera.viewpoint.destination, point(1, 2),
    "but it is still the viewpoint that applies now, which is where rejoining goes");
  h.restore();
}

// --- every canvas gesture detaches, in the capture phase; a second one is harmless ---
{
  const h = harness(win(0));
  assert.deepEqual(h.registered().sort(),
    ["mousedown:true", "pointerdown:true", "wheel:true"].sort(),
    "drag and wheel, in the capture phase, on the canvas, and no key");
  h.dom("wheel");
  assert.equal(h.camera.serverHolds, false, "the wheel detaches");
  h.dom("mousedown");
  assert.equal(h.cancels(), 1, "a gesture arriving after the detach cancels nothing");
  h.restore();
}

// --- furniture does not detach: nothing here watches the camera move ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(0, 0) }] });
  // The HomeButton flies the camera. That is a flight like the Core's own, which is exactly why the
  // hold is read off canvas input rather than off `camera.moveStart`.
  h.scene.camera.flyHome();
  assert.equal(h.camera.serverHolds, true, "the home button does not detach");
  h.camera.declare({ track: [{ destination: point(5, 5) }] });
  assert.equal(h.flights.length, 3, "so the next viewpoint still applies (2 viewpoints + the home)");
  h.restore();
}

// --- take re-applies and re-takes the hold ---
{
  const h = harness(win(0));
  h.dom("pointerdown");
  assert.equal(h.camera.serverHolds, false);
  h.camera.declare({ track: [{ destination: point(3, 4), take: true }] });
  assert.equal(h.camera.serverHolds, true, "a viewpoint carrying take re-attaches");
  assert.deepEqual(h.flights.at(-1).destination, point(3, 4), "and then applies");
  h.restore();
}

// --- rejoin takes the hold and flies to where the track is now ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(0, 0), at: 0 }, { destination: point(9, 9), at: 5 }] });
  h.camera.keyframeCrossed(0);
  h.dom("pointerdown");
  const before = h.flights.length;
  // The track keeps running while the viewer holds the camera, so rejoin has a well-defined target
  // at every instant.
  h.camera.keyframeCrossed(6);
  assert.equal(h.flights.length, before, "a crossing moves nothing while the viewer holds it");
  assert.deepEqual(h.camera.viewpoint.destination, point(9, 9),
    "but the applicable viewpoint is recomputed anyway");
  h.camera.rejoin();
  assert.equal(h.camera.serverHolds, true);
  assert.deepEqual(h.flights.at(-1).destination, point(9, 9),
    "rejoin goes where the track is now, not where it was when the user left");
  h.restore();
}

// --- an at entry applies on the crossing, and scrubbing backwards re-applies the earlier one ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0), at: 0 },
      { destination: point(10, 0), at: 10 },
      { destination: point(20, 0), at: 20 },
    ],
  });
  assert.equal(h.flights.length, 0, "a keyframe-keyed entry waits for its crossing");
  h.camera.keyframeCrossed(5);
  assert.deepEqual(h.flights.at(-1).destination, point(0, 0), "the latest entry at or before 5");
  h.camera.keyframeCrossed(6);
  assert.equal(h.flights.length, 1, "still the applied one, so nothing re-flies");
  h.camera.keyframeCrossed(20);
  assert.deepEqual(h.flights.at(-1).destination, point(20, 0));
  h.camera.keyframeCrossed(12);
  assert.deepEqual(h.flights.at(-1).destination, point(10, 0),
    "scrubbing backwards returns the camera to the viewpoint that keyframe was authored with");
  assert.equal(h.flights.length, 3);
  h.restore();
}

// --- a track landing on a clock already past its first entries does not wait for a crossing ---
{
  // What a retained track replayed on reconnect, or a track declared over a paused scene, arrives
  // into. The next crossing may never come, and rejoin needs a target at every instant.
  const h = harness(win(0), 15);
  h.camera.declare({
    track: [{ destination: point(0, 0), at: 0 }, { destination: point(10, 0), at: 10 }],
  });
  assert.deepEqual(h.flights.at(-1).destination, point(10, 0),
    "the entry the clock already stands past applies at once");
  assert.deepEqual(h.camera.viewpoint.destination, point(10, 0));
  h.restore();
}

// --- an after entry fires on its own timer, and a replaced track cancels it ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [{ destination: point(1, 1), after: 0.02 }, { destination: point(2, 2), after: 0.06 }],
  });
  assert.equal(h.flights.length, 0, "a wall-paced entry waits for its own timer");
  await sleep(40);
  assert.deepEqual(h.flights.at(-1).destination, point(1, 1), "the first offset elapsed");
  // Absolute offsets, not cumulative: the second is 60 ms from the declaration, not from the first.
  h.camera.declare({ track: [{ destination: point(7, 7) }] });
  await sleep(60);
  assert.equal(h.flights.length, 2, "a replaced track cancels the timers the last one left");
  assert.deepEqual(h.flights.at(-1).destination, point(7, 7));
  h.restore();
}

// --- an empty track clears whatever is held ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(4, 4) }] });
  assert.equal(h.camera.hasTrack, true);
  h.camera.declare({ track: [] });
  assert.equal(h.camera.hasTrack, false, "an empty track clears the track");
  assert.equal(h.camera.viewpoint, null, "and there is nothing to rejoin to");
  assert.equal(h.camera.serverHolds, true, "clearing the track says nothing about the hold");
  h.restore();
}

// --- a re-grid drops the track; a longer mission does not ---
{
  const h = harness(win(0, 60, 100));
  h.camera.declare({ track: [{ destination: point(0, 0), at: 10 }] });

  h.setWindow(win(0, 60, 500));
  h.camera.windowDelivered();
  assert.equal(h.camera.hasTrack, true, "a grown totalFrames leaves keyframe 10 where it was");

  h.setWindow(win(0, 60, 500));
  h.camera.windowDelivered();
  assert.equal(h.camera.hasTrack, true, "and a re-push on the same grid is not a re-grid either");

  h.setWindow(win(1, 60, 500)); // a different epoch
  h.camera.windowDelivered();
  assert.equal(h.camera.hasTrack, false, "a changed startTime drops the track");
  assert.ok(h.warnings.some((w) => /camera track dropped/.test(w)), "and says so");

  const h2 = harness(win(0, 60, 100));
  h2.camera.declare({ track: [{ destination: point(0, 0), at: 10 }] });
  h2.setWindow(win(0, 30, 100)); // a different step
  h2.camera.windowDelivered();
  assert.equal(h2.camera.hasTrack, false, "a changed dtSeconds drops it too");
  h2.restore(); // innermost first, or the swap of the one outside it is what is put back
  h.restore();
}

// --- a track declared before the first window adopts that window's grid ---
{
  const h = harness(null);
  h.camera.declare({ track: [{ destination: point(0, 0), at: 10 }] });
  h.setWindow(win(0));
  h.camera.windowDelivered();
  assert.equal(h.camera.hasTrack, true, "the first window states the grid rather than changing it");
  h.setWindow(win(3));
  h.camera.windowDelivered();
  assert.equal(h.camera.hasTrack, false, "the one after it can change it");
  h.restore();
}

// --- both at and after on one entry warns and takes at ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(8, 8), at: 4, after: 0.01 }] });
  assert.ok(h.warnings.some((w) => /both at and after/.test(w)));
  await sleep(40);
  assert.equal(h.flights.length, 0, "the after was dropped, so no timer fired");
  h.camera.keyframeCrossed(4);
  assert.deepEqual(h.flights.at(-1).destination, point(8, 8), "and the at is what schedules it");
  h.restore();
}

// --- an at beyond the declared range warns, and names the timeless case ---
{
  const h = harness(win(0, 60, 1));
  h.camera.declare({ track: [{ destination: point(0, 0), at: 3 }] });
  const w = h.warnings.find((x) => /past the declared range/.test(x));
  assert.ok(w, "an at beyond totalFrames warns");
  assert.match(w, /after/, "and the message says what an author should have used instead");
  assert.equal(h.camera.hasTrack, true, "the entry stays; it simply never applies");
  h.restore();
}

// --- a bad destination drops that entry and keeps the rest ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: { x: 1, y: 2 } },
      { destination: { west: -10, south: -5, east: 10, north: 5 } },
    ],
  });
  assert.ok(h.warnings.some((w) => /states neither a destination nor a follow anchor/.test(w)));
  assert.equal(h.camera.hasTrack, true, "the usable entry survives");
  assert.deepEqual(h.flights.at(-1).destination, { west: -10, south: -5, east: 10, north: 5 },
    "an extent becomes a Rectangle, which Cesium turns into a view that frames it");
  h.restore();
}

// --- a non-string label costs the label and never the viewpoint ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(6, 6), label: 42 }] });
  assert.ok(h.warnings.some((w) => /non-string label/.test(w)), "and says so");
  assert.equal("label" in h.camera.viewpoint, false, "the label is dropped");
  assert.deepEqual(h.flights.at(-1).destination, point(6, 6), "and the viewpoint still applies");
  h.camera.declare({ track: [{ destination: point(6, 6), label: "Rome meridian" }] });
  assert.equal(h.camera.viewpoint.label, "Rome meridian", "a stated label is kept as declared");
  h.restore();
}

// --- the stops the Core exposes are the declared track, and the applied index moves with it ---
{
  const h = harness(win(0));
  assert.deepEqual(h.camera.stops, [], "no track, no stops");
  assert.equal(h.camera.appliedIndex, -1, "and nothing applied");
  h.camera.declare({
    track: [
      { destination: point(0, 0), at: 0, label: "the whole ring" },
      { destination: point(10, 0), at: 10 },
      { destination: { x: 1 } }, // dropped, so the list is what the viewer can actually fly
      { destination: point(20, 0), at: 20, label: "New York meridian" },
    ],
  });
  assert.deepEqual(h.camera.stops.map((v) => v.label),
    ["the whole ring", undefined, "New York meridian"],
    "in declared order, each with its own label, and the unusable entry is not a row");
  assert.equal(h.camera.appliedIndex, -1, "nothing renders before the first viewpoint applies");
  h.camera.keyframeCrossed(10);
  assert.equal(h.camera.appliedIndex, 1, "a crossing moves the applied index");
  h.camera.keyframeCrossed(0);
  assert.equal(h.camera.appliedIndex, 0, "and scrubbing back moves it back");
  h.restore();
}

// --- an after timer moves the applied index too ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [{ destination: point(1, 1) }, { destination: point(2, 2), after: 0.02 }],
  });
  assert.equal(h.camera.appliedIndex, 0, "the unscheduled entry applied on arrival");
  await sleep(40);
  assert.equal(h.camera.appliedIndex, 1, "and the wall-clock offset elapsed");
  h.restore();
}

// --- orientation is degrees, and duration passes through only when it is stated ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(0, 0), orientation: { heading: 45, pitch: -30 } }] });
  assert.deepEqual(h.flights.at(-1).orientation, { heading: 90, pitch: -60 },
    "degrees in, radians out (the stub doubles), and an angle left out is left to Cesium");
  assert.equal("duration" in h.flights.at(-1), false,
    "an absent duration leaves Cesium's distance-based default");
  h.camera.declare({ track: [{ destination: point(0, 0), duration: 0 }] });
  assert.equal(h.flights.at(-1).duration, 0, "0 is a hard cut, and must not read as absent");
  h.restore();
}

// --- onChange fires for everything the indicator renders ---
{
  const h = harness(win(0));
  let seen = 0;
  const off = h.camera.onChange(() => { seen++; });
  h.camera.declare({ track: [{ destination: point(0, 0) }] });
  assert.ok(seen > 0, "a declared track is a change");
  const afterDeclare = seen;
  h.dom("pointerdown");
  assert.ok(seen > afterDeclare, "so is losing the hold");
  off();
  const afterOff = seen;
  h.camera.rejoin();
  assert.equal(seen, afterOff, "a disposed listener is not called again");
  h.restore();
}

// --- a payload that is not a track is ignored, and never throws ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ destination: point(0, 0) }] });
  h.camera.declare({});
  h.camera.declare(null);
  assert.equal(h.camera.hasTrack, true, "a malformed payload leaves the installed track alone");
  assert.ok(h.warnings.some((w) => /no track list/.test(w)));
  h.restore();
}

// --- clicking a keyframed stop moves the clock, takes the hold, and flies the fixed rejoin time ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0), at: 0, duration: 30 },
      { destination: point(9, 9), at: 40, duration: 30 },
    ],
  });
  h.camera.keyframeCrossed(0);
  h.dom("pointerdown");
  assert.equal(h.camera.serverHolds, false, "the viewer has the camera");

  h.camera.goToStop(1);
  assert.equal(h.camera.serverHolds, true, "clicking a stop takes the hold, exactly as rejoin does");
  assert.deepEqual(h.moves, [40], "and the clock moves onto the keyframe the stop is keyed at");
  assert.deepEqual(h.flights.at(-1).destination, point(9, 9));
  assert.equal(h.flights.at(-1).duration, 1.5,
    "in the fixed rejoin time: the entry's own duration paces a tour, and navigating is not touring");
  assert.equal(h.camera.appliedIndex, 1, "and the stop clicked is the applied one");

  // The clock move raises the crossing, which must find the stop applied already rather than fly it
  // a second time with its authored duration.
  const flown = h.flights.length;
  h.camera.keyframeCrossed(40);
  assert.equal(h.flights.length, flown, "the crossing that follows the clock move flies nothing");
  h.restore();
}

// --- clicking a wall-paced stop re-arms the later ones from the click ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0), after: 0 },
      { destination: point(1, 1), after: 0.06 },
      { destination: point(2, 2), after: 0.1 },
    ],
  });
  await sleep(80);
  assert.deepEqual(h.flights.at(-1).destination, point(1, 1), "the tour reached its middle stop");
  assert.equal(h.camera.deadlineAt(1), null, "a stop already applied has no timer left");

  // Back to the opening stop. The rest of the tour is armed again with the gaps the author wrote.
  h.camera.goToStop(0);
  assert.equal(h.camera.appliedIndex, 0, "the tour is back at the stop clicked");
  await sleep(80);
  assert.deepEqual(h.flights.at(-1).destination, point(1, 1),
    "the middle stop is 60 ms from the click, so it fires again rather than being skipped");
  assert.equal(h.camera.appliedIndex, 1);
  await sleep(60);
  assert.deepEqual(h.flights.at(-1).destination, point(2, 2), "and the tour carries on to the end");
  h.restore();
}

// --- clicking a stop scheduled by neither flies to it and nothing else ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [{ destination: point(3, 3) }, { destination: point(4, 4), at: 10 }],
  });
  h.camera.goToStop(0);
  assert.deepEqual(h.moves, [], "an unscheduled stop moves no clock");
  assert.deepEqual(h.flights.at(-1).destination, point(3, 3));
  assert.equal(h.flights.at(-1).duration, 1.5, "and flies in the fixed rejoin time like the rest");
  h.camera.goToStop(7);
  assert.equal(h.camera.appliedIndex, 0, "a stop that is not there is not a flight either");
  h.restore();
}

// --- the deadlines the arming writes are the only ones ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0), after: 5 },
      { destination: point(1, 1), at: 10 },
      { destination: point(2, 2) },
    ],
  });
  assert.equal(h.camera.deadlineAt(1), null, "a keyframed stop has no wall-clock deadline (ADR-0018)");
  assert.equal(h.camera.deadlineAt(2), null, "and neither has one that applied on arrival");
  assert.ok(h.camera.deadlineAt(0) - Date.now() > 4000, "the wall-paced one carries its own");
  h.camera.declare({ track: [{ destination: point(0, 0) }] });
  assert.equal(h.camera.deadlineAt(0), null,
    "and a replaced track drops the deadlines with the timers they belong to");
  h.restore();
}

// --- the follow frame: a moving anchor moves the frame, every tick ---
{
  const h = harness(win(0));
  // One anchor that moves, read live, so the test sees whether the frame is rebuilt or reused.
  let t = 0;
  const asked = [];
  h.camera.registerAnchors("primitives", (target) => {
    if (target !== "sat[7]") return null;
    return () => { asked.push(1); return v3(t, 0, 0); };
  });

  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  assert.deepEqual(h.camera.following, { module: "primitives", target: "sat[7]" },
    "a follow statement installs the frame");
  assert.equal(h.camera.hasTrack, false, "and declares no track");
  assert.equal(h.camera.serverHolds, true, "follow is a frame, not an authority state (ADR-0017)");
  assert.deepEqual(h.frameAt(), v3(0, 0, 0), "the frame stands at the anchor");
  assert.equal(h.seats.at(-1).offset, null,
    "a request stating no seat mounts in place, which keeps the camera where the user left it");

  t = 100;
  h.tick();
  assert.deepEqual(h.frameAt(), v3(100, 0, 0), "the frame follows the anchor on the next tick");
  t = 250;
  h.tick();
  assert.deepEqual(h.frameAt(), v3(250, 0, 0), "and reads the position afresh every tick");
  h.restore();
}

// --- a drag detaches and does not dismount ---
{
  const h = harness(win(0));
  h.camera.registerAnchors("primitives", () => () => v3(1, 0, 0));
  h.camera.declare({ track: [{ destination: point(9, 9) }] });
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  assert.equal(h.camera.hasTrack, true, "a follow statement leaves a declared track alone");

  h.dom("pointerdown");
  assert.equal(h.camera.serverHolds, false, "canvas input still takes the hold");
  assert.deepEqual(h.camera.following, { module: "primitives", target: "sat[7]" },
    "and the frame stays: the user keeps riding and now steers");
  assert.equal(h.ticking(), 1, "the per-tick update is still running");
  h.restore();
}

// --- a flight lets go of the frame before it starts ---
{
  const h = harness(win(0));
  h.camera.registerAnchors("primitives", () => () => v3(1, 0, 0));
  h.camera.declare({ track: [{ destination: point(9, 9) }] });
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  const before = h.seats.length;

  h.camera.rejoin();
  assert.equal(h.camera.following, null, "rejoining lets go of the anchor");
  assert.equal(h.ticking(), 0, "and stops the per-tick update");
  // The order is the assertion: a flight computed with the frame still installed leaves the camera
  // orbiting an anchor it has flown away from.
  assert.equal(h.seats.length, before + 1, "exactly one call cleared the frame");
  assert.equal(h.seats.at(-1).frame.identity, true, "and it cleared to the identity matrix");
  assert.deepEqual(h.flights.at(-1).destination, point(9, 9), "and only then did it fly");
  h.restore();
}

// --- home clears the frame, and the tick lets go rather than fighting it back ---
{
  const h = harness(win(0));
  h.camera.registerAnchors("primitives", () => () => v3(1, 0, 0));
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  // What `Camera.flyHome` does: it flies with `endTransform: Matrix4.IDENTITY`, so the frame is
  // gone before the next tick runs. Nothing in the Core routes that button.
  h.scene.camera.transform = { identity: true };
  h.tick();
  assert.equal(h.camera.following, null, "a frame taken away elsewhere dismounts the camera");
  assert.equal(h.ticking(), 0);
  h.restore();
}

// --- a stop that cannot resolve does nothing, and never throws ---
{
  const h = harness(win(0));
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  assert.equal(h.camera.following, null, "no module of that id offers a resolver");
  assert.equal(h.warnings.length, 1, "it warns once");
  assert.match(h.warnings.at(-1), /no module primitives offers an anchor resolver/);

  h.camera.registerAnchors("primitives", (target) => (target === "sat[7]" ? () => v3(1) : null));
  h.camera.declare({ follow: { module: "primitives", target: "sat[99]" } });
  assert.equal(h.camera.following, null, "and a target the module does not know is the same");
  assert.equal(h.seats.length, 0, "neither of them touched the camera");
  assert.equal(h.flights.length, 0);
  h.restore();
}

// --- an anchor that stops answering clears the frame ---
{
  const h = harness(win(0));
  let alive = true;
  h.camera.registerAnchors("primitives", () => () => (alive ? v3(1, 0, 0) : null));
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  assert.ok(h.camera.following, "riding it while it is there");

  alive = false;
  h.tick();
  assert.equal(h.camera.following, null, "the family shrank under it, so the camera lets go");
  assert.equal(h.ticking(), 0, "and stops asking");
  assert.match(h.warnings.at(-1), /stopped following primitives\/sat\[7\] — the anchor stopped/);
  h.restore();
}

// --- a seat with a duration is approached inside the frame, never flown to in world space ---
{
  const h = harness(win(0));
  let x = 0;
  h.camera.registerAnchors("primitives", () => () => v3(x, 0, 0));
  h.camera.declare({
    track: [{
      follow: { module: "primitives", target: "sat[7]" },
      range: 400000,
      orientation: { heading: 0, pitch: -45 },
      duration: 0.08,
    }],
  });
  // A world flight is aimed once, at a point that stops being where the anchor is the moment the
  // anchor moves. The camera would fly at empty ground and then snap onto the thing, so it rides
  // first and closes on the seat inside the frame instead.
  assert.equal(h.flights.length, 0, "a seat with a duration is not flown to in world coordinates");
  assert.deepEqual(h.camera.following, { module: "primitives", target: "sat[7]" },
    "the frame goes on first, so the camera is riding before it has finished arriving");

  x = 5000;
  h.tick();
  assert.deepEqual(h.frameAt(), v3(5000, 0, 0), "and the approach rides the anchor as it moves");
  assert.notDeepEqual(h.seats.at(-1).offset, { heading: 0, pitch: -90, range: 400000 },
    "part of the way there, and not yet at the seat the stop asked for");

  await new Promise((r) => setTimeout(r, 120));
  x = 9000;
  h.tick();
  assert.deepEqual(h.frameAt(), v3(9000, 0, 0));
  assert.deepEqual(h.seats.at(-1).offset, { heading: 0, pitch: -90, range: 400000 },
    "and lands on that seat, against the anchor wherever it has got to by then");
  h.restore();
}

// --- a drag abandons the approach where it is, and does not dismount ---
{
  const h = harness(win(0));
  h.camera.registerAnchors("primitives", () => () => v3(1, 0, 0));
  h.camera.declare({
    track: [{ follow: { module: "primitives", target: "sat[7]" }, range: 100, duration: 2 }],
  });
  h.dom("pointerdown");
  const seated = h.seats.length;
  h.tick();
  assert.ok(h.camera.following, "the user grabbed the view mid-approach and rides it from there");
  assert.equal(h.seats.length, seated + 1, "the tick still hands the frame over every tick");
  assert.equal(h.seats.at(-1).offset, null,
    "but it stops driving the seat, so the drag is not fought back for the rest of the move");
  h.restore();
}

// --- getting off stands over the ground the anchor was above, at the height it got on from ---
{
  const h = harness(win(0));
  // The fake reads a position's components as lon/lat/height, so the anchor is over (12, 41) and
  // the camera got on from 800 m up.
  h.camera.registerAnchors("primitives", () => () => v3(12, 41, 0));
  h.camera.declare({
    track: [{ follow: { module: "primitives", target: "sat[7]" }, range: 400000 }],
  });
  const flown = h.flights.length;

  h.camera.follow(null);
  assert.equal(h.camera.following, null, "the frame is gone");
  assert.equal(h.seats.at(-1).frame.identity, true, "cleared before anything flies, as a flight is");
  assert.equal(h.flights.length, flown + 1, "and getting off is a flight of its own");
  assert.deepEqual(h.flights.at(-1).destination, { lon: 12, lat: 41, height: 800 },
    "over the ground the anchor is above, at the height the camera came in from");
  assert.deepEqual(h.flights.at(-1).orientation, { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    "straight down and north up, which is the one attitude that needs no explaining after a ride");
  assert.equal(h.flights.at(-1).duration, 1.5);
  h.restore();
}

// --- the ways off that are not deliberate fly nothing of their own ---
{
  const h = harness(win(0));
  let alive = true;
  h.camera.registerAnchors("primitives", () => () => (alive ? v3(12, 41, 0) : null));
  h.camera.declare({ track: [{ follow: { module: "primitives", target: "sat[7]" }, range: 4e5 }] });
  const flown = h.flights.length;

  alive = false;
  h.tick();
  assert.equal(h.camera.following, null, "an anchor that stopped answering still dismounts");
  assert.equal(h.flights.length, flown,
    "but there is no ground left to stand over, so nothing is flown");

  // The home button is already flying by the time the tick sees the frame taken away, and a second
  // flight would fight it.
  alive = true;
  h.camera.follow({ module: "primitives", target: "sat[7]", range: 4e5 });
  const before = h.flights.length;
  h.scene.camera.transform = { identity: true };
  h.tick();
  assert.equal(h.camera.following, null);
  assert.equal(h.flights.length, before, "home is left to finish its own flight");
  h.restore();
}

// --- follow: null lets go, and a withdrawn resolver does too ---
{
  const h = harness(win(0));
  const drop = h.camera.registerAnchors("primitives", () => () => v3(1, 0, 0));
  h.camera.declare({ follow: { module: "primitives", target: "sat[7]" } });
  let changes = 0;
  h.camera.onChange(() => { changes++; });

  h.camera.declare({ follow: null });
  assert.equal(h.camera.following, null, "a null follow lets go");
  assert.equal(changes, 1, "and says so, or the panel shows a stale state");

  h.camera.follow({ module: "primitives", target: "sat[7]" });
  assert.ok(h.camera.following, "and the method is the same statement");
  drop();
  assert.equal(h.camera.following, null, "unloading the module that answered lets go too");
  h.restore();
}

// --- a viewpoint that states neither a destination nor an anchor is dropped ---
{
  const h = harness(win(0));
  h.camera.declare({ track: [{ orientation: { heading: 90 } }, { destination: point(1, 1) }] });
  assert.equal(h.camera.stops.length, 1, "the one with neither is dropped and the other stands");
  assert.match(h.warnings[0], /states neither a destination nor a follow anchor/);
  h.restore();
}

// --- a clock that wraps goes back to the viewpoint the track opens on ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0), label: "the whole ring" },
      { destination: point(10, 0), at: 8 },
      { destination: point(20, 0), at: 27 },
    ],
  });
  assert.equal(h.camera.appliedIndex, 0, "the entry scheduled by neither applies on arrival");
  h.camera.keyframeCrossed(27);
  assert.equal(h.camera.appliedIndex, 2, "the tour reaches its last stop");
  // What a looping range does at the end of the declared window.
  h.camera.keyframeCrossed(0);
  assert.equal(h.camera.appliedIndex, 0, "and the wrap puts the camera back on the opening stop");
  assert.deepEqual(h.flights.at(-1).destination, point(0, 0));
  h.restore();
}

// --- clicking the opening stop of a wall-paced tour starts the tour again ---
{
  const h = harness(win(0));
  h.camera.declare({
    track: [
      { destination: point(0, 0) },
      { destination: point(1, 1), after: 0.06 },
      { destination: point(2, 2), after: 0.1 },
    ],
  });
  await sleep(120);
  assert.equal(h.camera.appliedIndex, 2, "the tour ran to its end");
  h.camera.goToStop(0);
  assert.equal(h.camera.appliedIndex, 0, "the tour is back where it opens");
  assert.deepEqual(h.moves, [], "which moves no clock: the stop is keyed at no keyframe");
  assert.ok(h.camera.deadlineAt(1) - Date.now() > 0, "and the stops after it count down again");
  await sleep(80);
  assert.equal(h.camera.appliedIndex, 1, "so the tour carries on rather than ending on the click");
  h.restore();
}

// --- destroy stops listening ---
{
  const h = harness(win(0));
  h.camera.destroy();
  assert.deepEqual(h.registered(), [], "every canvas listener is removed");
  h.restore();
}

console.log("camera.test.mjs: all assertions passed");
