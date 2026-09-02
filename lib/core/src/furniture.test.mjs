// Runnable check for the pure half of furniture. Run: node lib/core/src/furniture.test.mjs
// (transpiles furniture.ts in-memory via esbuild — no Cesium, no DOM.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const load = async (file) => {
  const src = await readFile(new URL(file, import.meta.url), "utf8");
  const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
  return import("data:text/javascript," + encodeURIComponent(code));
};
const {
  bandLayout, basemapPickable, cameraFollowState, cameraFollowView, countdownText, stopRows,
  FURNITURE_DEFAULTS,
} = await load("./furniture.ts");
// The camera-follow item renders from the real authority, so the cases below drive that rather than
// a hand-written triple of values.
const { createCameraAuthority } = await load("./camera.ts");

// --- everything on reproduces the numbers on screen today, so a regression here is a visible one ---
{
  const l = bandLayout({ timeline: true, animation: true, keyframe: true });
  assert.equal(l.rulerLeft, 186, "the ruler starts past the animation widget");
  assert.equal(l.readoutLeft, 186, "the readout shares the ruler's left edge");
  assert.equal(l.readoutBottom, 28, "the readout docks directly above the ruler");
  assert.equal(l.followLeft, 186, "the camera-follow item shares the ruler's left edge");
  assert.equal(l.followBottom, 50, "and docks directly above the readout");
  assert.equal(l.bottomInset, 34, "the bottom-right region clears the band");
  assert.deepEqual(Object.keys(l).filter((k) => k.startsWith("stops")), [],
    "the stop list is inside the camera-follow item, so the band states no box for it");
}

// --- with the clock off, the ruler and the readout move to the left edge ---
{
  const l = bandLayout({ timeline: true, animation: false, keyframe: true });
  assert.equal(l.rulerLeft, 6, "nothing precedes the ruler, so it starts at the pad");
  assert.equal(l.readoutLeft, 6, "the readout follows the ruler");
  assert.equal(l.followLeft, 6, "and so does the camera-follow item");
}

// --- with the ruler off, the readout drops into its place and the band shrinks to the edge inset ---
{
  const l = bandLayout({ timeline: false, animation: true, keyframe: true });
  assert.equal(l.readoutBottom, 0, "the readout takes the ruler's place");
  assert.equal(l.followBottom, 22, "the camera-follow item stays above the readout");
  assert.equal(l.bottomInset, 8, "a band-free region sits at the same inset as the top regions");
}

// --- with the readout off too, the camera-follow item drops into its place ---
{
  const l = bandLayout({ timeline: true, animation: true, keyframe: false });
  assert.equal(l.followBottom, 28, "nothing between it and the ruler, so it sits on the ruler");
}

// --- the defaults are stated once, and four items are off ---
{
  const off = Object.keys(FURNITURE_DEFAULTS).filter((id) => !FURNITURE_DEFAULTS[id]);
  assert.deepEqual(off, ["projection", "navHelp", "inspector", "canvasCapture"],
    "these are not built until asked for");
  assert.equal(FURNITURE_DEFAULTS.cameraFollow, true,
    "the camera-follow item is on by default, and hides itself while it has nothing to say");
  assert.equal(FURNITURE_DEFAULTS.canvasCapture, false,
    "the capture button reaches the clipboard, so a session asks for it before it appears");
  assert.equal(FURNITURE_DEFAULTS.basemap, true,
    "the basemap picker is on by default, and hides itself below two basemaps");
  assert.equal(FURNITURE_DEFAULTS.annotations, true,
    "both annotation layers are drawn by default, so the cell is drawn too");
}

// --- the annotation rows hold one box per layer, in both of their homes ---
//
// Which rows a panel holds is not something a type can catch. So read the rows out of the source
// that owns them, and check that both homes take them: the picker's drop-down, and the cell a globe
// without a picker falls back to.
{
  const ui = await readFile(new URL("./clock-ui.ts", import.meta.url), "utf8");
  const cell = /function annotationRows\([\s\S]*?\n}/.exec(ui)[0];
  assert.match(ui, /section\.append\(\.\.\.annotationRows\(annotations\)\)/,
    "the picker's drop-down carries the rows");
  assert.match(ui, /panel\.append\(\.\.\.annotationRows\(layers\)\)/,
    "and so does the cell that stands in where there is no picker");
  assert.match(ui, /id === "annotations"\) return annotations !== undefined && !pickable\(\)/,
    "which is drawn only then");
  assert.deepEqual([...cell.matchAll(/row\("([^"]+)"/g)].map((m) => m[1]),
    ["Place names", "Country borders"],
    "one box per layer, in the order the layers stack");
}

// --- the group's id lives in two files, and one of them alone draws nothing ---
//
// An id named in `FurnitureId` but missing from `GROUP_ORDER` or from the build table compiles and
// never reaches the screen, which is exactly the failure a type cannot catch. So read the two
// tables out of the source that owns them and hold them against the defaults.
{
  const ui = await readFile(new URL("./clock-ui.ts", import.meta.url), "utf8");
  const quoted = (block) => [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const order = quoted(/const GROUP_ORDER = \[([\s\S]*?)\] as const;/.exec(ui)[1]);
  const table = /const build: Record<GroupId,[\s\S]*?\n  };/.exec(ui)[0];
  const built = [...table.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);

  // The band is drawn by `buildFurniture` itself, so it is the whole of what the group leaves out.
  const BAND = ["timeline", "animation", "keyframe", "cameraFollow"];
  const group = Object.keys(FURNITURE_DEFAULTS).filter((id) => !BAND.includes(id));
  assert.deepEqual([...order].sort(), group.sort(),
    "every group id is declared in furniture.ts and ordered in clock-ui.ts");
  assert.deepEqual([...built].sort(), [...order].sort(),
    "and each one is built, or the cell is ordered into a column it never appears in");
  assert.equal(order[order.indexOf("basemap") + 1], "annotations",
    "the annotations cell sits beside the picker: both say what the globe wears");
}

// --- the picker hides itself below two basemaps, so naming one basemap is the whole opt-out ---
{
  assert.equal(basemapPickable(0), false, "a session that declares no basemap draws no button");
  assert.equal(basemapPickable(1), false, "and neither does one that names a single basemap");
  assert.equal(basemapPickable(2), true, "two basemaps are a set to pick within");
  assert.equal(basemapPickable(4), true, "so are four");
}

// A camera authority over a stub scene: a canvas that records its capture listeners so a case can
// deliver a gesture the way a browser does, and a camera that records flights instead of flying.
function authority() {
  const captured = [];
  const flights = [];
  const scene = {
    canvas: { addEventListener: (type, fn) => captured.push([type, fn]), removeEventListener: () => {} },
    camera: { flyTo: (o) => flights.push(o), cancelFlight: () => {} },
  };
  const C = {
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    Rectangle: { fromDegrees: () => ({}) },
    Math: { toRadians: (d) => d },
    JulianDate: { equals: (a, b) => a === b },
  };
  const clock = { window: () => null, keyframe: () => null, goToKeyframe: () => {} };
  return {
    camera: createCameraAuthority(scene, C, clock),
    flights,
    drag: () => { for (const [t, fn] of captured) if (t === "pointerdown") fn({ type: t }); },
  };
}

const point = (lon, lat) => ({ lon, lat, height: 0 });

// --- declared off, the item stays hidden however the camera behaves ---
{
  const h = authority();
  assert.equal(cameraFollowState(false, h.camera), "hidden", "declared off, and nothing to say yet");
  h.camera.declare({ track: [{ destination: point(10, 20) }] });
  assert.equal(cameraFollowState(false, h.camera), "hidden", "and a viewpoint does not reveal it");
  assert.deepEqual(stopRows(false, h.camera), [], "so the list is not rendered either");
  h.drag();
  assert.equal(h.camera.serverHolds, false, "authority still runs — the declaration is display only");
  assert.equal(cameraFollowState(false, h.camera), "hidden", "but the way back is not advertised");
  assert.deepEqual(stopRows(false, h.camera), [], "and neither is the tour");
}

// --- declared on, the item shows nothing until the first viewpoint applies ---
{
  const h = authority();
  assert.equal(cameraFollowState(true, h.camera), "hidden",
    "a session that never sends a viewpoint never renders it");
  h.camera.declare({ track: [{ destination: point(10, 20) }] });
  assert.equal(cameraFollowState(true, h.camera), "server", "the first viewpoint reveals it");
}

// --- canvas input flips the state, which is what reveals the rejoin control ---
{
  const h = authority();
  h.camera.declare({ track: [{ destination: point(10, 20) }] });
  h.drag();
  assert.equal(cameraFollowState(true, h.camera), "viewer", "the viewer is looking freely");
  h.camera.declare({ track: [{ destination: point(1, 2) }] });
  assert.equal(cameraFollowState(true, h.camera), "viewer",
    "detachment is sticky, so a later viewpoint does not put the state back");
}

// --- rejoin re-takes the hold and targets the entry that applies now, in a short fixed flight ---
{
  const h = authority();
  h.camera.declare({
    track: [
      { destination: point(0, 0), at: 0, duration: 20 },
      { destination: point(9, 9), at: 5, duration: 20 },
    ],
  });
  h.camera.keyframeCrossed(0);
  h.drag();
  assert.equal(cameraFollowState(true, h.camera), "viewer");
  // The clock runs on while the viewer holds the camera, so a stale target fails here.
  h.camera.keyframeCrossed(6);
  h.camera.rejoin();
  assert.equal(cameraFollowState(true, h.camera), "server", "rejoin gives the hold back");
  assert.deepEqual(h.flights.at(-1).destination, point(9, 9),
    "and goes where the track is now, not where it was when the user left");
  assert.equal(h.flights.at(-1).duration, 1.5,
    "in a short fixed flight: the entry's own duration paces a tour, and this is not part of one");
}

// --- the list renders one row per stop, in declared order, with the applied one marked ---
{
  const h = authority();
  assert.deepEqual(stopRows(true, h.camera), [], "nothing renders before the first stop applies");
  h.camera.declare({
    track: [
      { destination: point(0, 0), label: "the whole ring" },
      { destination: point(9, 9), at: 20, label: "New York meridian" },
    ],
  });
  assert.deepEqual(stopRows(true, h.camera), [
    { text: "the whole ring", applied: true },
    { text: "New York meridian", applied: false },
  ], "the opening stop applied on arrival and the list says so");
  h.camera.keyframeCrossed(20);
  assert.deepEqual(stopRows(true, h.camera).map((r) => r.applied), [false, true],
    "the mark follows the stop the schedule applied");
}

// --- a row with no label falls back to its schedule, one line per schedule ---
{
  const h = authority();
  h.camera.declare({
    track: [
      { destination: point(0, 0) },
      { destination: point(1, 1), at: 20 },
      { destination: point(2, 2), after: 8 },
    ],
  });
  assert.deepEqual(stopRows(true, h.camera).map((r) => r.text),
    ["on arrival", "at keyframe 20", "after 8 s"],
    "the three schedules, which is what makes a labelled tour worth authoring");
}

// --- a track of fifty stops is fifty rows: the cap on the panel is height, not row count ---
{
  const h = authority();
  h.camera.declare({
    track: Array.from({ length: 50 }, (_, i) => ({ destination: point(i, 0), at: i })),
  });
  h.camera.keyframeCrossed(49);
  const rows = stopRows(true, h.camera);
  assert.equal(rows.length, 50, "one retained command by design, so the list states all of it");
  assert.equal(rows.filter((r) => r.applied).length, 1, "and exactly one row is the applied one");
  assert.equal(rows.at(-1).applied, true, "the last stop, which the panel scrolls back into view");
}

// --- one widget: closed by default, the rows appear on expand and go on collapse ---
{
  const h = authority();
  const closed = () => cameraFollowView(true, h.camera, false);
  const open = () => cameraFollowView(true, h.camera, true);

  assert.equal(closed().state, "hidden", "nothing renders before the first viewpoint applies");
  assert.deepEqual(open().rows, [], "and opening it renders nothing either");

  h.camera.declare({
    track: [
      { destination: point(0, 0), label: "the whole ring" },
      { destination: point(9, 9), at: 20, label: "New York meridian" },
    ],
  });
  assert.deepEqual(closed().rows, [], "closed by default: one line, and the list is not on screen");
  assert.match(closed().head, /^▸ ◉ Camera: following the scene · 2 stops$/,
    "the head line says who holds the camera and how many stops it opens into");

  assert.deepEqual(open().rows.map((r) => r.text), ["the whole ring", "New York meridian"],
    "and the rows appear when the viewer opens it");
  assert.match(open().head, /^▾ /, "the caret turns over, so the head says what a click does now");
  assert.deepEqual(closed().rows, [], "closing it takes the rows away again");

  h.drag();
  assert.equal(closed().state, "viewer", "the two states the head line distinguishes");
  assert.match(closed().head, /^▸ ○ Camera: yours · 2 stops$/,
    "the icon and the wording follow the hold, and the count stands whoever holds it");
}

// --- one stop is one stop, and a track of none says nothing about a count ---
{
  const h = authority();
  h.camera.declare({ track: [{ destination: point(0, 0) }] });
  assert.match(cameraFollowView(true, h.camera, false).head, / · 1 stop$/, "singular");
  assert.equal(cameraFollowView(false, h.camera, true).rows.length, 0,
    "a session that declares the item off gets neither the head line nor the list");
}

// --- riding wins over both hold states, and it shows with nothing else to show ---
{
  // Pure functions over the shape the authority reports. Installing a real follow frame needs a
  // real Cesium, and `camera.test.mjs` drives that; what is checked here is the step from what the
  // authority says to what the reader sees.
  const rider = (over, extra = {}) => ({
    serverHolds: over,
    viewpoint: null,
    following: { module: "primitives", target: "sat[7]" },
    stops: [],
    appliedIndex: -1,
    ...extra,
  });

  assert.equal(cameraFollowState(true, rider(true)), "riding",
    "the server holds the camera and it is riding all the same");
  assert.equal(cameraFollowState(true, rider(false)), "riding",
    "and a drag detaches without dismounting, so the hold moves and the ride does not");
  assert.equal(cameraFollowState(false, rider(false)), "hidden",
    "a session that declares the item off advertises no way off either");

  // Click-to-follow is exactly a session with no track: nothing declared and nothing ever applied.
  // Without this the rider sees no panel at all and has no way off but the home button.
  const view = cameraFollowView(true, rider(true), true);
  assert.match(view.head, /^▾ ◎ Camera: riding sat\[7\]$/,
    "the line names what it rides, in the spelling its author wrote, and counts no stops");
  assert.deepEqual(view.rows, [], "there is no tour to list, and an empty list is the honest answer");
  assert.equal(view.riding, "sat[7]", "which is what the control that gets off renders on");
  assert.equal(view.canRejoin, false, "the server holds the camera, so there is nothing to rejoin");

  // The two controls answer to different things, because the frame and the hold are independent.
  const took = cameraFollowView(true, rider(false, { viewpoint: { destination: point(1, 2) } }), false);
  assert.equal(took.riding, "sat[7]", "still riding after the drag that took the camera");
  assert.equal(took.canRejoin, true, "and now with a viewpoint waiting, so both controls show");

  // Getting off leaves a camera that has nothing else to say, and the item goes with it.
  const off = { serverHolds: true, viewpoint: null, following: null, stops: [], appliedIndex: -1 };
  assert.equal(cameraFollowState(true, off), "hidden",
    "nothing declared, nothing applied and nothing ridden");
  assert.equal(
    cameraFollowView(true, { ...off, viewpoint: { destination: point(1, 2) } }, false).state,
    "server", "while a track that applied keeps the item, exactly as it did before any of this");
}

// --- the authority reports that field, under the name the item reads it by ---
{
  const h = authority();
  assert.equal(h.camera.following, null, "a camera rides nothing until something mounts it");
  h.camera.declare({ track: [{ destination: point(10, 20) }] });
  assert.equal(h.camera.following, null, "and a viewpoint that states no anchor mounts nothing");
}

// --- the countdown states whole seconds, rounded up, and stops at zero ---
{
  assert.equal(countdownText(null, 1000), "",
    "no armed timer, no countdown: every keyframed row and every stop already applied");
  assert.equal(countdownText(21_000, 1_000), "in 20 s", "a whole offset reads as itself");
  assert.equal(countdownText(20_500, 1_000), "in 20 s",
    "and a part second rounds up, so the row never sits on 'in 0 s' while it still has time");
  assert.equal(countdownText(900, 1_000), "in 0 s", "a deadline already passed does not go negative");
}

// --- the countdown reads the deadlines the arming wrote, and the re-arm moves them together ---
{
  const h = authority();
  h.camera.declare({
    track: [
      { destination: point(0, 0), after: 0, label: "start" },
      { destination: point(1, 1), after: 8, label: "middle" },
      { destination: point(2, 2), after: 20, label: "end" },
    ],
  });
  // The opening stop is `after 0`, so its deadline is the instant the arming ran.
  const armed = h.camera.deadlineAt(0);
  assert.equal(countdownText(h.camera.deadlineAt(2), armed), "in 20 s",
    "the last stop is 20 s from the declaration, and the countdown reads that deadline");
  assert.equal(countdownText(h.camera.deadlineAt(1), armed), "in 8 s",
    "and the gaps are the ones the author wrote");
  // Clicking the opening stop re-arms the rest from the click, so the whole tour runs again.
  const clicked = Date.now();
  h.camera.goToStop(0);
  const lag = h.camera.deadlineAt(2) - clicked - 20_000;
  assert.ok(lag >= 0 && lag < 1000,
    `a stop that was 20 s from the declaration is 20 s from the click, not sooner (off by ${lag} ms)`);
  assert.equal(h.camera.deadlineAt(0), null, "and the clicked stop applied, so it has no timer left");
}

console.log("furniture.test.mjs: all assertions passed");
