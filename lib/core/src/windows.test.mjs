// Runnable check for Core-level windows: one `window` message carrying every module's payload, the
// declared range and clock behind it, the delivered buffer and its coverage, and the three time
// callbacks a module sees.
// Run: node lib/core/src/windows.test.mjs (bundles windows.ts in-memory via esbuild — no
// Cesium, no test framework.)
//
// Everything here drives `createWindows` and asserts through the interface the Core publishes.
// That is deliberate: the frame index used to be readable two ways, and the copy the tests asserted
// against was not the copy the Core stamped onto its events, so the two drifted apart unnoticed.
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const { outputFiles } = await esbuild.build({
  entryPoints: [new URL("./windows.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  write: false,
});
const { createWindows, bracket, Timeline } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

// --- bracket: evenly-spaced keyframe indexing, clamped so [i, i+1] is always readable (n ≥ 2) ---
{
  const dt = 240;
  const n = 4; // frames at t = 0,240,480,720; span = 720
  assert.deepEqual(bracket(-5, dt, n), { i: 0, alpha: 0 }, "below start clamps to frame 0");
  assert.deepEqual(bracket(0, dt, n), { i: 0, alpha: 0 });
  assert.deepEqual(bracket(720, dt, n), { i: 2, alpha: 1 }, "at end clamps to [n-2, 1]");
  assert.deepEqual(bracket(9999, dt, n), { i: 2, alpha: 1 });
  assert.deepEqual(bracket(120, dt, n), { i: 0, alpha: 0.5 });
  assert.deepEqual(bracket(240, dt, n), { i: 1, alpha: 0 });
  assert.deepEqual(bracket(600, dt, n), { i: 2, alpha: 0.5 });
  // Degenerate: no successor frame → pin to 0; the caller tolerates a missing frames[i+1].
  assert.deepEqual(bracket(50, dt, 1), { i: 0, alpha: 0 });
  assert.deepEqual(bracket(50, 0, n), { i: 0, alpha: 0 });
}

// A stub clock + Cesium namespace: JulianDates modelled as plain numbers (seconds since the epoch
// the ISO string names), so addSeconds is `+` and secondsDifference is `-`. Ticks are driven by
// setting currentTime and invoking the listener the playback registered.
function makeStub() {
  const listeners = [];
  const clock = {
    startTime: null, stopTime: null, currentTime: null,
    clockRange: null, clockStep: null, multiplier: 1, shouldAnimate: null, canAnimate: true,
    onTick: {
      addEventListener(fn) {
        listeners.push(fn);
        return () => {
          const k = listeners.indexOf(fn);
          if (k >= 0) listeners.splice(k, 1);
        };
      },
    },
  };
  function JulianDate() {}
  JulianDate.addSeconds = (a, s) => a + s;
  JulianDate.secondsDifference = (a, b) => a - b;
  JulianDate.fromIso8601 = (s) => {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`bad iso ${s}`);
    return t / 1000;
  };
  JulianDate.equals = (a, b) => a === b;
  const C = { JulianDate, ClockRange: { LOOP_STOP: "L" }, ClockStep: { SYSTEM_CLOCK_MULTIPLIER: "S" } };
  const tickAt = (elapsed) => {
    clock.currentTime = clock.startTime + elapsed;
    for (const fn of [...listeners]) fn(clock);
  };
  return { clock, C, tickAt };
}

const EPOCH = "2026-07-26T10:00:00Z";

/** A `window` message's params, with the fields every test repeats defaulted. */
const msg = (over) => ({
  startFrame: 0, count: 2, mode: "replace", window: 1,
  totalFrames: 10, dtSeconds: 60, intervalSeconds: 1, startTime: EPOCH,
  payloads: {}, ...over,
});

// Whether the clock is actually advancing: Cesium ticks only when both flags are set.
// `shouldAnimate` is the user's play/pause and nothing else writes it; `canAnimate` is the Core's
// hold. Telling the two apart is what lets a pause pressed during a hold survive the release.
const running = (clock) => clock.shouldAnimate && clock.canAnimate;

function harness(over = {}) {
  const stub = makeStub();
  const needs = [];
  const ranges = [];
  const clocks = [];
  const crossings = [];
  const warnings = [];
  const windows = createWindows({
    clock: stub.clock, C: stub.C,
    onNeed: (startFrame, count) => needs.push({ startFrame, count }),
    onRange: (start, stop) => ranges.push({ start, stop }),
    onClock: (multiplier, playing) => clocks.push({ multiplier, playing }),
    onCrossing: (index) => crossings.push(index),
    onWarn: (m) => warnings.push(m),
    ...over,
  });
  return { ...stub, windows, needs, ranges, clocks, crossings, warnings };
}

// --- one message, every module's payload, addressed by name ---------------------------------
{
  const h = harness();
  const seen = { a: [], b: [] };
  h.windows.onWindow("a", (w, p) => seen.a.push({ w, p }));
  h.windows.onWindow("b", (w, p) => seen.b.push({ w, p }));

  h.windows.deliver(msg({ startFrame: 4, count: 3, mode: "replace", window: 7,
                          payloads: { a: { hello: 1 } } }));

  assert.equal(seen.a.length, 1);
  assert.equal(seen.b.length, 0, "a module absent from the payload map is not called");
  const { w, p } = seen.a[0];
  assert.deepEqual(p, { hello: 1 }, "the payload reaches its module untouched");
  assert.equal(w.startFrame, 4);
  assert.equal(w.count, 3);
  assert.equal(w.id, 7, "the window's identity travels with it");
  assert.equal(w.mode, "replace");
  assert.equal(w.totalFrames, 10, "the declared range, not what was delivered");
  assert.equal(w.dtSeconds, 60);
  assert.equal(w.epoch, Date.parse(EPOCH) / 1000, "the epoch is absolute frame 0's mission time");
  assert.equal(h.windows.info, w, "ctx.window reads the window on screen");
  assert.equal(h.ranges.length, 1, "the declared range points the timeline ruler once");
}

// --- encoded arrays are decoded before a module sees them ------------------------------------
{
  const h = harness();
  let got = null;
  h.windows.onWindow("m", (_w, p) => { got = p; });
  const region = new Uint8Array(new Float32Array([0, 1.5, -2.5, 3]).buffer);
  h.windows.deliver(
    msg({ payloads: { m: { nested: [{ pos: { $wire: "f32", shape: [3], off: 4 } }] } } }),
    region,
  );
  const pos = got.nested[0].pos;
  assert.ok(pos.data instanceof Float32Array, "a `$wire` object anywhere becomes a typed array");
  assert.deepEqual([...pos.data], [1.5, -2.5, 3]);
  assert.deepEqual(pos.shape, [3]);
  assert.equal(pos.data.buffer, region.buffer, "the array is a view into the frame's region");
}

// --- a module that registers after the window landed is handed it ----------------------------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 8,
                          payloads: { late: { n: 1 }, other: {} } }));
  // An append that names only `other` must not re-stamp `late`'s payload with a window it never
  // rode: the two would then disagree about which frames the arrays cover.
  h.windows.deliver(msg({ startFrame: 2, count: 1, totalFrames: 8, mode: "append",
                          payloads: { other: {} } }));
  const seen = [];
  h.windows.onWindow("late", (w, p) => seen.push([w.startFrame, w.count, p]));
  assert.deepEqual(seen, [[0, 2, { n: 1 }]],
                   "an import that finished after the window gets it, with the window it rode");
}

// --- per-tick interpolation reported to the module, never throttled ---------------------------
{
  const h = harness();
  const frames = [];
  const crossings = [];
  h.windows.onFrame((f) => frames.push(f));
  h.windows.onKeyframe((i) => crossings.push(i));
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 3, dtSeconds: 60,
                          payloads: { m: {} } }));

  h.tickAt(0);
  h.tickAt(15);
  h.tickAt(30);
  h.tickAt(60);
  h.tickAt(90);
  assert.deepEqual(frames, [
    { index: 0, alpha: 0 }, { index: 0, alpha: 0.25 }, { index: 0, alpha: 0.5 },
    { index: 1, alpha: 0 }, { index: 1, alpha: 0.5 },
  ], "every tick reports the bracketing absolute index and the blend toward index+1");
  assert.deepEqual(crossings, [0, 1], "a crossing fires once per keyframe entered");
  assert.deepEqual(h.windows.frame, { index: 1, alpha: 0.5 }, "ctx.frame reads where the clock is");
}

// --- the crossing reaches every module, not only one driving a scene --------------------------
{
  const h = harness();
  const a = [], b = [];
  h.windows.onKeyframe((i) => a.push(i));
  h.windows.onKeyframe((i) => b.push(i));
  h.windows.deliver(msg({ count: 2, totalFrames: 4, payloads: { only: {} } }));
  h.tickAt(0);
  h.tickAt(60);
  assert.deepEqual(a, [0, 1]);
  assert.deepEqual(b, a, "a module carrying no payload at all still sees the crossings");
}

// --- append continues the buffer and preserves the index space --------------------------------
{
  const h = harness();
  const got = [];
  const frames = [];
  h.windows.onWindow("m", (w) => got.push([w.mode, w.startFrame, w.count, w.id]));
  h.windows.onFrame((f) => frames.push(f.index));
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 6, mode: "replace", window: 1,
                          payloads: { m: {} } }));
  h.tickAt(60);                       // frame 1, the end of what is covered
  h.windows.deliver(msg({ startFrame: 2, count: 1, totalFrames: 6, mode: "append", window: 1,
                          payloads: { m: {} } }));
  h.tickAt(120);                      // frame 2 — only the append can cover it
  h.tickAt(180);                      // frame 3 — nothing covers it
  assert.deepEqual(got, [["replace", 0, 2, 1], ["append", 2, 1, 1]]);
  assert.deepEqual(frames, [1, 2], "the seam is crossed without the index space shifting");
}

// --- append downwards, for a clock running backwards ------------------------------------------
{
  const h = harness();
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  h.windows.deliver(msg({ startFrame: 4, count: 2, totalFrames: 8, mode: "replace",
                          payloads: { m: {} } }));
  h.clock.multiplier = -1;
  h.tickAt(4 * 60);
  h.windows.deliver(msg({ startFrame: 3, count: 1, totalFrames: 8, mode: "append",
                          payloads: { m: {} } }));
  h.tickAt(3 * 60);
  assert.deepEqual(frames, [4, 3], "a window continuing the buffer downwards extends it too");
}

// --- replace installs a fresh buffer ----------------------------------------------------------
{
  const h = harness();
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 8, mode: "replace",
                          payloads: { m: {} } }));
  h.tickAt(0);
  h.windows.deliver(msg({ startFrame: 5, count: 2, totalFrames: 8, mode: "replace", window: 2,
                          payloads: { m: {} } }));
  h.tickAt(0);                        // frame 0 was in the old buffer and is not in the new one
  h.tickAt(5 * 60);
  assert.deepEqual(frames, [0, 5], "the replaced buffer covers only what the new window brought");
  assert.equal(h.windows.info.id, 2);
}

// --- the clock holds at the last covered frame when nothing answers a need --------------------
{
  const h = harness();
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 20, mode: "replace",
                          payloads: { m: {} } }));
  assert.equal(h.clock.shouldAnimate, true, "the first window starts the run");
  h.tickAt(60);
  h.needs.length = 0;
  h.tickAt(10 * 60);                  // scrubbed far past coverage; nothing answers
  assert.equal(h.clock.canAnimate, false, "the clock is held rather than animating past coverage");
  assert.deepEqual(h.needs, [{ startFrame: 10, count: 2 }],
                   "a window landing somewhere new is asked for as a pair — the fewest it can blend");
  assert.deepEqual(frames, [1], "nothing is painted for an instant the buffer does not cover");
  h.tickAt(10 * 60);
  assert.equal(h.needs.length, 1, "the ask is made once per index, not once per tick");
}

// --- a pause pressed while the buffer is short is not undone by the window that answers it -----
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 20, mode: "replace",
                          payloads: { m: {} } }));
  h.tickAt(10 * 60);                  // past coverage: held, and the user is still asking for play
  assert.equal(h.clock.canAnimate, false);
  assert.equal(h.clock.shouldAnimate, true);

  // The widget's play/pause writes `clock.shouldAnimate` and the Core never sees the press itself,
  // only what it left behind. A hold that wrote that same flag would have made this press invisible,
  // and the window below would put playback back on against the user's word.
  h.clock.shouldAnimate = false;
  h.windows.deliver(msg({ startFrame: 10, count: 2, totalFrames: 20, mode: "append",
                          payloads: { m: {} } }));
  assert.equal(h.clock.shouldAnimate, false, "the pause stands once the window arrives");

  // A play pressed during the hold is still honoured on release — the case the hold exists for.
  h.tickAt(19 * 60);                  // past coverage again
  h.clock.shouldAnimate = true;
  assert.equal(h.clock.canAnimate, false, "still held while the buffer is short");
  h.windows.deliver(msg({ startFrame: 19, count: 1, totalFrames: 20, mode: "append",
                          payloads: { m: {} } }));
  assert.equal(h.clock.canAnimate && h.clock.shouldAnimate, true,
               "and playback runs as soon as the window lands");
}

// --- direction, speed and play/pause are reported upward, on change only ----------------------
{
  const h = harness();
  // Before any window: the range is undeclared and the tick bails, but the state is still stated.
  h.clock.startTime = 0;
  h.tickAt(0);
  assert.deepEqual(h.clocks, [{ multiplier: 1, playing: false }],
                   "the opening state is reported once, without waiting for a change");

  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 20, mode: "replace",
                          payloads: { m: {} } }));
  h.tickAt(60);
  // A declared range writes the multiplier itself — one keyframe step per real-time interval — so
  // the reported speed is the run's own, not the 1x the clock was built with.
  assert.deepEqual(h.clocks.at(-1), { multiplier: 60, playing: true },
                   "the run the first window starts is a change worth reporting");

  h.clock.multiplier = -2;            // the shuttle ring, turned around and sped up
  h.tickAt(60);
  assert.deepEqual(h.clocks.at(-1), { multiplier: -2, playing: true });
  const said = h.clocks.length;
  h.tickAt(60);
  h.tickAt(60);
  assert.equal(h.clocks.length, said, "a clock nobody touched sends nothing");

  h.clock.shouldAnimate = false;      // the pause button
  h.tickAt(60);
  assert.deepEqual(h.clocks.at(-1), { multiplier: -2, playing: false });

  // The Core's own hold writes `canAnimate`, which is not the user's play/pause and is not reported:
  // a buffer topping up would otherwise read upward as the user pausing and playing again.
  h.clock.shouldAnimate = true;
  h.tickAt(60);
  const held = h.clocks.length;
  h.tickAt(15 * 60);                  // past coverage, so the clock is held
  assert.equal(h.clock.canAnimate, false, "held while the buffer is short");
  assert.equal(h.clocks.length, held, "the hold is not a play/pause and says nothing upward");
}

// --- every keyframe crossing is reported upward, forwards, backwards and at the seam -----------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 4, totalFrames: 20, mode: "replace",
                          payloads: { m: {} } }));
  assert.deepEqual(h.crossings, [0],
                   "the opening window crosses into its first keyframe before any tick");
  h.tickAt(60);
  h.tickAt(2 * 60);
  assert.deepEqual(h.crossings, [0, 1, 2], "one report per keyframe entered");
  h.tickAt(2 * 60 + 30);
  assert.deepEqual(h.crossings, [0, 1, 2], "a tick between two keyframes crosses nothing");
  h.tickAt(60);
  assert.deepEqual(h.crossings, [0, 1, 2, 1], "a scrub back over a keyframe is a crossing too");

  // Outside coverage the tick bails before the crossing, so a starved clock says nothing here — the
  // scene hears about that instant as a `core/need`, which is the ask it can actually answer.
  const said = h.crossings.length;
  h.needs.length = 0;
  h.tickAt(15 * 60);
  assert.equal(h.crossings.length, said, "an uncovered instant is not a crossing");
  assert.deepEqual(h.needs, [{ startFrame: 15, count: 2 }], "it is a need instead");

  // And the window answering that need re-fires the crossing for where the clock already stands,
  // which is the same one the modules are restyled on.
  h.windows.deliver(msg({ startFrame: 15, count: 2, totalFrames: 20, mode: "append",
                          payloads: { m: {} } }));
  assert.deepEqual(h.crossings.at(-1), 15, "the window that lands under the clock reports it");
}

// --- the buffer is bounded, and evicts from the end the clock is moving away from --------------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 40, mode: "replace",
                          payloads: { m: {} } }));
  for (let f = 2; f <= 20; f++) {
    h.tickAt(f * 60);
    h.windows.deliver(msg({ startFrame: f, count: 1, totalFrames: 40, mode: "append",
                            payloads: { m: {} } }));
  }
  h.tickAt(20 * 60);
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  h.needs.length = 0;
  h.tickAt(0);                        // back to the start, long since evicted
  assert.deepEqual(frames, [], "frames dropped behind a forward-running clock are no longer covered");
  assert.deepEqual(h.needs, [{ startFrame: 0, count: 2 }]);
  h.tickAt(20 * 60);
  assert.deepEqual(frames, [20], "what the clock was moving toward is still held");
}

// --- the bound never evicts the frames the clock has yet to play through -----------------------
//
// The continuation is asked for `LOOKAHEAD_FRAMES` before the edge, so it lands while the clock is
// still short of it. A bound of exactly one window's length would then leave coverage holding the
// new window alone, and the clock — outside the buffer it just grew — stalls, asks for a window it
// already has, and crosses the seam again. That costs three deliveries per seam instead of one, and
// on a replay it reads as a hang at every chunk boundary.
{
  const h = harness();
  const chunk = 8;
  const deliver = (start, mode) =>
    h.windows.deliver(msg({ startFrame: start, count: chunk, totalFrames: 24, mode,
                            payloads: { m: {} } }));
  const seen = [];
  h.windows.onWindow("m", (w) => seen.push(w.startFrame));

  deliver(0, "replace");
  h.tickAt(5 * 60);                   // frame 5 — where the Core asks for the next chunk
  assert.deepEqual(h.needs.at(-1), { startFrame: 8, count: 1 });
  deliver(8, "append");

  h.needs.length = 0;
  seen.length = 0;
  for (const f of [6, 7, 8]) h.tickAt(f * 60);
  assert.deepEqual(seen, [], "no window is re-delivered while the clock walks into the new chunk");
  assert.deepEqual(h.needs, [], "and nothing is asked for again");
  assert.ok(h.clock.canAnimate, "the clock is never held at the seam");
}

// --- a malformed window is warned about, not fatal ---------------------------------------------
{
  const h = harness();
  let called = false;
  h.windows.onWindow("m", () => { called = true; });
  h.windows.deliver({ payloads: { m: {} } });
  h.windows.deliver(msg({ count: 0 }));
  assert.equal(called, false);
  assert.equal(h.warnings.length, 2);
  h.windows.deliver(msg({ startTime: "not-a-date", payloads: { m: {} } }));
  assert.equal(called, true, "an unparseable epoch falls back rather than dropping the window");
}

// --- a throwing module callback kills only itself ----------------------------------------------
{
  const h = harness();
  const survived = [];
  h.windows.onFrame(() => { throw new Error("boom"); });
  h.windows.onFrame((f) => survived.push(f.index));
  h.windows.deliver(msg({ count: 2, totalFrames: 4, payloads: { m: {} } }));
  h.tickAt(0);
  assert.deepEqual(survived, [0], "the frame loop and the other modules run on");
  assert.ok(h.warnings.some((w) => w.includes("boom")));
}

// --- a throwing crossing does not stop the ones after it ---------------------------------------
{
  const h = harness();
  const crossings = [];
  h.windows.onKeyframe((i) => {
    crossings.push(i);
    if (i === 1) throw new Error("boom"); // one bad crossing must not stop the rest
  });
  h.windows.deliver(msg({ count: 4, totalFrames: 4, payloads: { m: {} } }));
  h.tickAt(0);
  h.tickAt(60);
  h.tickAt(120);
  assert.deepEqual(crossings, [0, 1, 2], "a throwing crossing does not stop later crossings");
  assert.ok(h.warnings.some((w) => w.includes("boom")));
}

// --- the frame reported is where the *clock* is, not the last one painted ----------------------
//
// This is the whole reason the range, the buffer and the fan-out live in one file. The Core stamps
// `windows.frame.index` onto every outgoing event, and `docs/protocol.md` specifies that field as
// the keyframe at or before the current instant. A stamp reporting the last *painted* frame answers
// a control for an instant the clock has already left, so the window the server sends back covers
// frames nobody is looking at and the control appears to do nothing.
{
  const h = harness();
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  // 10 declared frames of dt=60 (span 540); only frames 4..5 delivered.
  h.windows.deliver(msg({ startFrame: 4, count: 2, totalFrames: 10, payloads: { m: {} } }));

  h.tickAt(4 * 60 + 30);              // absolute frame 4, mid-interval — covered
  assert.deepEqual(h.windows.frame, { index: 4, alpha: 0.5 });

  h.tickAt(6 * 60);                   // absolute frame 6 — past the delivered buffer
  assert.deepEqual(frames, [4], "nothing is painted past the buffer: the last frame stands");
  assert.equal(running(h.clock), false, "and the clock is held rather than running over nothing");
  assert.equal(h.windows.frame.index, 6,
               "the reported frame follows the clock past the end of what was delivered");
  // The tightest statement of it: the index the Core stamps on an event and the index it asks the
  // server for are the same number. A stamp reading the painted frame would ask for 6 and report 4.
  assert.equal(h.windows.frame.index, h.needs.at(-1).startFrame,
               "the frame an event is stamped with is the frame a window is asked for");

  // And the answer to that ask paints, because it covers where the clock actually is.
  h.windows.deliver(msg({ startFrame: 6, count: 2, totalFrames: 10, payloads: { m: {} } }));
  h.tickAt(6 * 60);
  assert.deepEqual(frames, [4, 6], "a window covering where the clock stalled paints again");
}

// --- placement: which window carries an absolute keyframe, and where in it it sits --------------
{
  const h = harness();
  assert.equal(h.windows.placement(0), null, "nothing delivered, so no keyframe is placed");
  h.windows.deliver(msg({ startFrame: 4, count: 3, totalFrames: 10, window: 7,
                          payloads: { m: {} } }));
  assert.equal(h.windows.placement(3), null, "a keyframe no window covers is placed nowhere");
  assert.equal(h.windows.placement(7), null);
  for (const [index, k] of [[4, 0], [5, 1], [6, 2]]) {
    const at = h.windows.placement(index);
    assert.equal(at.window.id, 7, `keyframe ${index} names the window that carried it`);
    assert.equal(at.k, k, "and the offset a payload's per-keyframe arrays are cut by");
  }
  // An append extends the index space, so what came before it is still placed.
  h.windows.deliver(msg({ startFrame: 7, count: 2, totalFrames: 10, mode: "append", window: 7,
                          payloads: { m: {} } }));
  assert.equal(h.windows.placement(4).k, 0, "an append leaves the earlier placements standing");
  assert.equal(h.windows.placement(8).k, 1, "and places its own against its own start frame");
  // A replace may renumber, so nothing addressed against what came before survives it.
  h.windows.deliver(msg({ startFrame: 8, count: 1, totalFrames: 10, window: 9,
                          payloads: { m: {} } }));
  assert.equal(h.windows.placement(4), null, "a replace drops every placement before it");
  assert.equal(h.windows.placement(8).window.id, 9);
}

// --- placement holds exactly what coverage claims, and nothing else ----------------------------
//
// A retained keyframe pins its whole window's payload, so this cannot grow without bound. It also
// cannot be *smaller* than coverage: every crossing the Core fires is a frame coverage claims, and
// one with no placement is a module drawing nothing for a keyframe the clock is happily running
// over. A second bound of its own could only ever agree with coverage by coincidence, so there
// isn't one — it follows coverage.
{
  const h = harness();
  const win = (startFrame, mode) =>
    msg({ startFrame, count: 1, totalFrames: 400, mode, payloads: { m: {} } });
  h.windows.deliver(win(0, "replace"));
  for (let f = 1; f < 300; f++) h.windows.deliver(win(f, "append"));

  assert.equal(h.windows.placement(299).k, 0, "the newest keyframe is placed");
  assert.equal(h.windows.placement(299).window.startFrame, 299);
  // Streaming a frame at a time: the buffer holds eight, so eight windows are pinned and the rest
  // of a 300-frame run is long gone.
  assert.ok(h.windows.placement(292), "everything the buffer still covers is placed");
  assert.equal(h.windows.placement(291), null, "and what it let go is dropped with it");
  assert.equal(h.windows.placement(0), null);
}

// --- a window carrying a whole run places every frame of it ------------------------------------
//
// A bound stated as a constant gets this wrong: the buffer is not trimmed for a window delivered
// whole, so coverage claims all 1000 frames while a fixed retention would place only the last few
// hundred. Every crossing below that would then fire with no placement, and the scene would draw
// nothing for most of the run — on the one delivery shape where the server sent everything needed.
{
  const h = harness();
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push({ i, placed: h.windows.placement(i) !== null }));
  h.windows.deliver(msg({ startFrame: 0, count: 1000, totalFrames: 1000, payloads: { m: {} } }));
  for (const f of [0, 100, 743, 744, 999]) h.tickAt(f * 60);
  assert.ok(crossings.length > 0, "the run crosses keyframes");
  assert.deepEqual(crossings.filter((c) => !c.placed), [],
                   "every keyframe the clock crosses into is placed, whole-run window included");
  assert.equal(h.windows.placement(0).k, 0, "the first frame reads the window's own start");
  assert.equal(h.windows.placement(999).k, 999);
}

// --- a single-frame range places its one frame and does not animate ----------------------------
{
  const h = harness();
  const frames = [];
  const crossings = [];
  h.windows.onFrame((f) => frames.push(f));
  h.windows.onKeyframe((i) => crossings.push(i));
  h.windows.deliver(msg({ startFrame: 0, count: 1, totalFrames: 1, payloads: { m: {} } }));
  assert.equal(h.clock.shouldAnimate, false, "a static scene does not play");
  h.tickAt(0);
  assert.deepEqual(frames, [{ index: 0, alpha: 0 }], "but its one frame is still placed");
  assert.deepEqual(crossings, [0]);
}

// --- the ruler spans the declared range, not the delivered window ------------------------------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 40, count: 2, totalFrames: 100, dtSeconds: 10,
                          payloads: { m: {} } }));
  const epoch = Date.parse(EPOCH) / 1000;
  assert.equal(h.clock.startTime, epoch, "the ruler opens on the declared epoch");
  assert.equal(h.clock.stopTime, epoch + 99 * 10, "and closes at the end of the declared range");
  assert.deepEqual(h.ranges, [{ start: epoch, stop: epoch + 99 * 10 }],
                   "the timeline is pointed at that range once, not at each window");
}

// --- window identity, as a module's in-flight request names it ---------------------------------
{
  const h = harness();
  const w = (over) => msg({ totalFrames: 10, count: 3, payloads: { m: {} }, ...over });
  assert.equal(h.windows.info, null, "no window delivered, so there is none to name");
  h.windows.deliver(w({ startFrame: 0, window: 7 }));
  assert.equal(h.windows.info.id, 7, "a delivered window republishes the identity it carried");
  h.windows.deliver(w({ startFrame: 3, window: 7, mode: "append" }));
  assert.equal(h.windows.info.id, 7, "an append preserves the index space, so the identity holds");
  h.windows.deliver(w({ startFrame: 0, window: 8 }));
  assert.equal(h.windows.info.id, 8, "a re-push may renumber entities, so it is a different window");
  h.windows.deliver(w({ startFrame: 0, window: null }));
  assert.equal(h.windows.info.id, null, "a window naming no identity leaves requests unguarded");
}

// --- a replace fires the crossing it implies, at once ------------------------------------------
{
  const h = harness();
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push(i));
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  assert.deepEqual(crossings, [0],
                   "the opening window fires its own crossing, so no module draws by hand");
  h.tickAt(2 * 60);
  assert.deepEqual(crossings, [0, 2], "the clock is scrubbed straight onto the last covered frame");
  // An append continues the index space, so nothing under the clock moved and nothing re-fires.
  h.windows.deliver(msg({ startFrame: 3, count: 3, totalFrames: 10, mode: "append",
                          payloads: { m: {} } }));
  assert.deepEqual(crossings, [0, 2], "an append implies no crossing");
  h.tickAt(2 * 60);
  assert.deepEqual(crossings, [0, 2], "and the tick after it does not re-fire one either");
  // A replace may renumber the entities under the clock, so the crossing is re-fired for it.
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  assert.deepEqual(crossings, [0, 2, 2],
                   "a re-push re-applies the current frame before it returns");
  h.tickAt(2 * 60);
  assert.deepEqual(crossings, [0, 2, 2], "and the next tick at that index does not fire it again");
}

// --- a handler that registers after the crossing is handed it -----------------------------------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  h.tickAt(60);
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push(i));
  await Promise.resolve();
  assert.deepEqual(crossings, [1],
                   "an import that finished after the window draws the keyframe on screen");
  h.tickAt(60);
  assert.deepEqual(crossings, [1], "and the tick it is already on does not repeat it");

  // Nothing is on screen before the first window, so there is no crossing to hand over.
  const fresh = harness();
  const none = [];
  fresh.windows.onKeyframe((i) => none.push(i));
  await Promise.resolve();
  assert.deepEqual(none, [], "a handler registered before the first window is called for nothing");
}

// --- the hand-over does not depend on which callback the module registered first ----------------
//
// A module reads its store from the crossing. If the crossing reached it before the window it was
// addressed in, it would draw nothing and wait for the next crossing to come round.
{
  for (const keyframeFirst of [true, false]) {
    const h = harness();
    h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10,
                            payloads: { m: { v: "a" } } }));
    const store = new Timeline();
    const drawn = [];
    const onKeyframe = () =>
      h.windows.onKeyframe((i) => drawn.push(store.at(h.windows.placement(i))?.w));
    const onWindow = () => h.windows.onWindow("m", (w, p) => store.install(p, w));
    if (keyframeFirst) (onKeyframe(), onWindow());
    else (onWindow(), onKeyframe());
    await Promise.resolve();
    assert.deepEqual(drawn, [{ v: "a" }],
                     `the crossing reads the window's value (onKeyframe first: ${keyframeFirst})`);
  }

  // A re-push before the hand-over runs fires the very index the hand-over was waiting to report.
  // The handler has already been told, so the hand-over must drop rather than repeat it.
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push(i));
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  await Promise.resolve();
  assert.deepEqual(crossings, [0], "one crossing reaches the handler, not two");
}

// --- a window that lands away from the clock reports no crossing it cannot place -----------------
//
// Consuming the crossing here would suppress it for good: `lastI` would hold an index the buffer
// says nothing about, and a later window that brings it into coverage extends the buffer, so it
// fires none of its own.
{
  const h = harness();
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push({ i, placed: h.windows.placement(i) !== null }));
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  h.tickAt(2 * 60);
  assert.deepEqual(crossings, [{ i: 0, placed: true }, { i: 2, placed: true }]);
  // A re-push that lands past the clock: nothing covers index 2 any more.
  h.windows.deliver(msg({ startFrame: 5, count: 3, totalFrames: 10, payloads: { m: {} } }));
  assert.deepEqual(crossings, [{ i: 0, placed: true }, { i: 2, placed: true }],
                   "a window that does not carry the clock's index reports no crossing for it");
  // Two appends walk coverage back down over the clock. Neither implies a crossing of its own.
  h.windows.deliver(msg({ startFrame: 3, count: 2, totalFrames: 10, mode: "append",
                          payloads: { m: {} } }));
  h.windows.deliver(msg({ startFrame: 2, count: 1, totalFrames: 10, mode: "append",
                          payloads: { m: {} } }));
  h.tickAt(2 * 60);
  assert.deepEqual(crossings[2], { i: 2, placed: true },
                   "and the first tick a window covers that index fires it, with a placement");
}

// --- the crossing a window fires sees the coverage the next tick would ---------------------------
//
// The placements are filled for the arriving window before the buffer drops what it no longer
// covers. A module reading `placement` during the crossing must never be handed a window the drop
// is about to remove. An append that leaves a gap is the case that shows it: it claims coverage of
// its own frames alone, and the frames it does not continue survive until the drop.
{
  const h = harness();
  const seen = [];
  h.windows.onKeyframe(() => {
    for (let k = 0; k < 10; k++) seen.push({ k, placed: h.windows.placement(k) !== null });
  });
  h.windows.deliver(msg({ startFrame: 0, count: 4, totalFrames: 10, payloads: { m: {} } }));
  // Scrub past the buffer: the clock holds at 6, which the next window lands on.
  h.tickAt(6 * 60);
  seen.length = 0;
  h.windows.deliver(msg({ startFrame: 6, count: 2, totalFrames: 10, mode: "append",
                          payloads: { m: {} } }));
  assert.ok(seen.length > 0, "the window carries the clock's index, so it fires a crossing");
  assert.deepEqual(seen.filter((s) => s.placed).map((s) => s.k), [6, 7],
                   "the crossing sees exactly what the new window covers");
}

// --- the per-window store: what a window handed a module, keyed on the window itself ------------
{
  const h = harness();
  const store = new Timeline();
  const seen = [];
  h.windows.onWindow("m", (w, p) => (store.install(p, w), seen.push(p)));
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 10, payloads: { m: { v: "a" } } }));
  const first = h.windows.placement(0);
  assert.deepEqual(store.at(first), { w: { v: "a" }, k: 0 }, "a placement reads what its window carried");
  assert.deepEqual(store.at(h.windows.placement(1)), { w: { v: "a" }, k: 1 },
                   "and the offset is the one the Core resolved");
  assert.equal(store.at(null), undefined, "a keyframe no window covers reads nothing");

  h.windows.deliver(msg({ startFrame: 2, count: 2, totalFrames: 10, mode: "append",
                          payloads: { m: { v: "b" } } }));
  assert.deepEqual(store.at(h.windows.placement(0)), { w: { v: "a" }, k: 0 },
                   "the first window's value survives an append beside it");
  assert.deepEqual(store.at(h.windows.placement(2)), { w: { v: "b" }, k: 0 },
                   "and the appended window reads its own");
  assert.deepEqual(store.latest, { v: "b" }, "latest follows the most recent install");

  // A replace re-indexes: absolute 0 is a different window now, so the value installed against the
  // old one is unreachable through it. Keying on `startFrame` would hand back the wrong window.
  h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 10, payloads: { m: { v: "c" } } }));
  assert.deepEqual(store.at(h.windows.placement(0)), { w: { v: "c" }, k: 0 },
                   "a replace addresses absolute 0 through its own window");
  assert.notEqual(h.windows.placement(0).window, first.window,
                  "because absolute 0 names a different window object, at the same start frame");
  assert.equal(seen.length, 3, "one install per delivered window, and no more");

  store.clear();
  assert.equal(store.at(h.windows.placement(0)), undefined, "clear drops every window");
  assert.equal(store.latest, undefined, "and the most recent value with them");

  // The store takes any value, so presence must decide what it holds, not truth.
  for (const falsy of [0, false, "", null]) {
    const s = new Timeline();
    h.windows.deliver(msg({ startFrame: 0, count: 2, totalFrames: 10, payloads: { m: {} } }));
    s.install(falsy, h.windows.info);
    assert.deepEqual(s.at(h.windows.placement(1)), { w: falsy, k: 1 },
                     `a stored ${JSON.stringify(falsy)} reads back as a value, not as nothing`);
  }
}

// --- the continuation is asked for before the buffer runs dry ----------------------------------
{
  const h = harness();
  // 10 declared frames; 0..5 delivered, so the buffer ends four short of the run.
  h.windows.deliver(msg({ startFrame: 0, count: 6, totalFrames: 10, payloads: { m: {} } }));
  h.tickAt(2 * 60);
  assert.deepEqual(h.needs, [], "no request while playback is comfortably inside coverage");
  h.tickAt(4 * 60);                   // within the lead margin of the last delivered frame (5)
  assert.deepEqual(h.needs, [{ startFrame: 6, count: 1 }],
                   "approaching the edge asks for the one frame that continues the buffer");
  h.tickAt(5 * 60);
  assert.equal(h.needs.length, 1, "and the pending request is not repeated every keyframe");
}

// --- keyframeTime, and landing on the instant a keyframe was computed for ----------------------
{
  const h = harness();
  const crossings = [];
  h.windows.onKeyframe((i) => crossings.push(i));
  const epoch = Date.parse(EPOCH) / 1000;
  assert.equal(h.windows.keyframeTime(2), null, "no range declared yet, so no instant to name");
  h.windows.deliver(msg({ startFrame: 0, count: 4, totalFrames: 4, payloads: { m: {} } }));
  assert.equal(h.windows.keyframeTime(0), epoch, "keyframe 0 sits on the declared epoch");
  assert.equal(h.windows.keyframeTime(2), epoch + 120, "and the rest a multiple of dt past it");

  h.tickAt(75);                       // mid-interval: what is on screen was computed for keyframe 1
  assert.deepEqual(crossings, [0, 1],
                   "the window's own crossing, then the one an instant between keyframes opened");
  h.windows.goToKeyframe(1);          // landing on the named instant must name it again
  h.tickAt(h.clock.currentTime - h.clock.startTime);
  assert.equal(h.clock.currentTime, epoch + 60, "goToKeyframe lands on the keyframe's own instant");
  assert.deepEqual(crossings, [0, 1], "so moving the clock there leaves the readout unchanged");
}

// --- a clock parked on a keyframe stays parked when the stall lifts ----------------------------
{
  const h = harness();
  h.windows.deliver(msg({ startFrame: 0, count: 3, totalFrames: 10, payloads: { m: {} } }));
  h.tickAt(2 * 60);
  assert.equal(running(h.clock), true, "playing inside the buffer");
  h.tickAt(3 * 60);                   // past the buffer: held, with the user still asking for play
  assert.equal(running(h.clock), false);
  h.windows.goToKeyframe(2);          // the user lands on the keyframe the scene is built from
  h.tickAt(h.clock.currentTime - h.clock.startTime);
  assert.equal(running(h.clock), false,
               "the stall lifting must not resume a clock deliberately parked on a keyframe");
}

// --- dispose stops the clock and unsubscribes -------------------------------------------------
{
  const h = harness();
  const frames = [];
  h.windows.onFrame((f) => frames.push(f.index));
  h.windows.deliver(msg({ startFrame: 0, count: 4, totalFrames: 4, payloads: { m: {} } }));
  h.tickAt(0);
  assert.deepEqual(frames, [0]);
  h.windows.dispose();
  assert.equal(h.clock.shouldAnimate, false, "dispose stops playback");
  assert.equal(h.windows.frame, null, "and reports no frame, so a late event stamps nothing");
  assert.equal(h.windows.info, null);
  h.tickAt(60);
  assert.deepEqual(frames, [0], "no callbacks after dispose");
}

console.log("windows.test.mjs: all assertions passed");
