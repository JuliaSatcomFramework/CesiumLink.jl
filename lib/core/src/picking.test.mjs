// Runnable check for the Core pointer dispatch. Run: node lib/core/src/picking.test.mjs
// (transpiles picking.ts in-memory via esbuild — no Cesium, no WebGL, a faked canvas.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const src = await readFile(new URL("./picking.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { createPointerDispatch, DEFAULT_HOVER_DEBOUNCE_MS } =
  await import("data:text/javascript," + encodeURIComponent(code));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stub scene + Cesium namespace. The ScreenSpaceEventHandler records each registered input action
// keyed by (type, modifier) so the test can fire them; what lies under the cursor is swappable via
// setPick (one hit) or setStack (several, nearest first) and every read is counted, so the "one pick
// pass per event" invariant of ADR-0003 is asserted. Modifier state reaches the dispatch the way it
// does in the browser: through the canvas capture listener.
function harness() {
  const actions = new Map();
  // Mirrors Cesium's own `getInputEventKey`: an action is stored under the whole modifier set, sorted
  // and joined, so a registration naming one modifier is not found by a gesture holding two.
  const modKey = (type, mods) => {
    const list = mods === undefined ? [] : Array.isArray(mods) ? [...mods] : [mods];
    return `${type}:${list.sort().join("+")}`;
  };
  function ScreenSpaceEventHandler() {}
  ScreenSpaceEventHandler.prototype.setInputAction = function (fn, type, mod) {
    actions.set(modKey(type, mod), fn);
  };
  ScreenSpaceEventHandler.prototype.destroy = function () {};

  const captured = [];
  const canvas = {
    addEventListener: (type, fn) => captured.push([type, fn]),
    removeEventListener: (type, fn) => {
      const i = captured.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) captured.splice(i, 1);
    },
  };

  let raycasts = 0;
  let picks = 0;
  let stack = () => []; // overridden per case; the primitives under the cursor, nearest first
  const scene = {
    canvas,
    drillPick: () => { picks++; return stack(); },
    camera: { getPickRay: () => ({}) },
    globe: { pick: () => { raycasts++; return {}; } },
  };
  function Cartesian2(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  // The real one returns `result`, which is what makes a reused scratch a scratch.
  Cartesian2.clone = (c, r) => (r.x = c.x, r.y = c.y, r);
  const C = {
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: { MOUSE_MOVE: "MOVE", LEFT_CLICK: "CLICK" },
    KeyboardEventModifier: { ALT: "ALT", CTRL: "CTRL", SHIFT: "SHIFT" },
    Cartesian2,
    Cartographic: { fromCartesian: () => ({ longitude: 0.5, latitude: 0.25, height: 12 }) },
    Math: { toDegrees: (r) => r * 100 },
  };
  const forwarded = [];
  const dispatch = createPointerDispatch(scene, C, (p) => forwarded.push(p));
  // One position object for every move, as ScreenSpaceEventHandler has: whatever moves last on this
  // canvas overwrites it, so anything that means to keep a position has to copy it out.
  const moveScratch = { x: 0, y: 0 };
  // One DOM event to the capture listeners bound to that type, as the browser delivers it.
  const dom = (type, held) => {
    for (const [t, fn] of captured) {
      if (t !== type) continue;
      fn({ type, altKey: held.includes("alt"), ctrlKey: held.includes("ctrl"),
           shiftKey: held.includes("shift") });
    }
  };
  // Cesium picks the action from the whole modifier set it reads off the DOM event the gesture comes
  // out of; a set nothing was registered under resolves to no action at all.
  const CESIUM_MOD = { alt: "ALT", ctrl: "CTRL", shift: "SHIFT" };
  const slot = (held) => held.map((m) => CESIUM_MOD[m]);
  const fire = (type, held, movement) => {
    const fn = actions.get(modKey(type, slot(held)));
    assert.ok(fn, `no input action is registered for ${type} with [${held}]`);
    fn(movement);
  };
  return {
    dispatch,
    forwarded,
    setPick: (fn) => { stack = () => { const p = fn(); return p ? [p] : []; }; },
    setStack: (fn) => { stack = fn; },
    // Exposed so a test can overwrite it the way another handler on the canvas would.
    scratch: moveScratch,
    // Pointer events, as a browser that has them delivers them — and only those: Cesium calls
    // preventDefault on the down it consumes, so the compatibility `mousedown` never follows.
    // Modelling that is the point; a harness that also fired `mousedown` would hide the case.
    move: (x, y, held = []) => {
      moveScratch.x = x;
      moveScratch.y = y;
      dom("pointermove", held);
      fire("MOVE", held, { endPosition: moveScratch });
    },
    // A click is a gesture with two ends. Cesium raises LEFT_CLICK out of the up, so the action it
    // arrives on is chosen from what was held at release — which `atRelease` can differ in.
    // `spelling` is "mouse" for the browser that has no pointer events.
    click: (x, y, held = [], atRelease = held, spelling = "pointer") => {
      dom(`${spelling}down`, held);
      dom(`${spelling}up`, atRelease);
      fire("CLICK", atRelease, { position: { x, y } });
    },
    registered: () => [...actions.keys()],
    leave: () => { for (const [t, fn] of captured) if (t === "mouseleave") fn({}); },
    raycasts: () => raycasts,
    picks: () => picks,
    resetPicks: () => { picks = 0; },
  };
}

// --- a pick id names its owner, and every local handler sees every event ---
{
  const h = harness();
  const sat = h.dispatch.pickId("primitives", "sat", 3);
  h.setPick(() => ({ id: sat }));
  const seen = [];
  h.dispatch.onPointer((e) => seen.push(["a", e.entity]));
  h.dispatch.onPointer((e) => seen.push(["b", e.entity]));
  h.resetPicks();
  h.move(10, 10);
  assert.deepEqual(seen.map(([who]) => who), ["a", "b"], "both local handlers ran, in order");
  assert.deepEqual({ ...seen[0][1] }, { module: "primitives", kind: "sat", idx: 3 },
    "the pick id identifies the owning module, a kind and an index");
  assert.equal(h.picks(), 1, "a pointer move costs exactly one pick pass (ADR-0003)");
}

// --- a local handler that throws does not stop the ones behind it ---
{
  const h = harness();
  h.setPick(() => undefined);
  let reached = false;
  h.dispatch.onPointer(() => { throw new Error("boom"); });
  h.dispatch.onPointer(() => { reached = true; });
  h.move(1, 1);
  assert.ok(reached, "a throwing local handler does not bail the rest");
}

// --- a miss dispatches with entity: null ---
{
  const h = harness();
  h.setPick(() => undefined);
  let entity = "unset";
  h.dispatch.onPointer((e) => { entity = e.entity; });
  h.move(5, 5);
  assert.equal(entity, null, "nothing under the cursor is a miss, not a skipped dispatch");
}

// --- the event carries every owned entity under the cursor, nearest first ---
{
  const h = harness();
  const route = h.dispatch.pickId("primitives", "highlight", 0);
  const cell = h.dispatch.pickId("primitives", "cell", 2134);
  // A highlight drawn over the shape it belongs to, an unowned decoration between them, and the
  // shape itself. Which of the two the pointer meant is not something the Core can know.
  h.setStack(() => [{ id: route }, { id: [7, 2] }, {}, { id: cell }]);
  let e = null;
  h.dispatch.onPointer((ev) => { e = ev; });
  h.move(3, 3);
  assert.deepEqual(e.entities.map((x) => ({ ...x })), [
    { module: "primitives", kind: "highlight", idx: 0 },
    { module: "primitives", kind: "cell", idx: 2134 },
  ], "every owned hit, nearest first; anything carrying no stamp belongs to nobody and is dropped");
  assert.deepEqual({ ...e.entity }, { ...e.entities[0] }, "entity is the nearest of them");
  assert.equal(h.picks(), 1, "one pick pass, however deep the stack it reports");
}

// --- one entity drawn by several primitives appears once ---
{
  const h = harness();
  const cell = h.dispatch.pickId("primitives", "cell", 9);
  const sat = h.dispatch.pickId("primitives", "sat", 1);
  const same = h.dispatch.pickId("primitives", "cell", 9); // a distinct stamp for the same entity
  // An area's fill and its outline are two primitives sharing one entity, so a stack of primitives
  // would report the cell twice.
  h.setStack(() => [{ id: cell }, { id: same }, { id: sat }]);
  let entities = null;
  h.dispatch.onPointer((ev) => { entities = ev.entities; });
  h.move(3, 3);
  assert.deepEqual(entities.map((x) => ({ ...x })), [
    { module: "primitives", kind: "cell", idx: 9 },
    { module: "primitives", kind: "sat", idx: 1 },
  ], "the stack lists entities, not the primitives drawing them");
}

// --- a primitive drawn through the entity API names its entity on `id.pickId` ---
{
  const h = harness();
  const sat = h.dispatch.pickId("primitives", "sat", 12);
  // Cesium's visualizers set an entity's primitives' `id` to the `Entity`, so a module drawing a
  // model or a cone over a satellite cannot put the stamp there. It hangs it on `pickId` instead.
  h.setStack(() => [{ id: { pickId: sat } }, { id: "an entity carrying no stamp" }, { id: {} }]);
  let entities = null;
  h.dispatch.onPointer((ev) => { entities = ev.entities; });
  h.move(4, 4);
  assert.deepEqual(entities.map((x) => ({ ...x })), [
    { module: "primitives", kind: "sat", idx: 12 },
  ], "the borrowed stamp is read one step through the id, and nothing else in the stack is owned");
}

// --- a borrowed stamp and the owner's own primitive are one entity ---
{
  const h = harness();
  const sat = h.dispatch.pickId("primitives", "sat", 12);
  // The satellite's marker, and a model an anchored module drew over it. One click, one entity.
  h.setStack(() => [{ id: { pickId: sat } }, { id: sat }]);
  let entities = null;
  h.dispatch.onPointer((ev) => { entities = ev.entities; });
  h.move(4, 4);
  assert.deepEqual(entities.map((x) => ({ ...x })), [
    { module: "primitives", kind: "sat", idx: 12 },
  ], "the drawer and the anchor collapse, and the hit reports the anchor");
}

// --- a `pickId` property carrying anything but a stamp is not one ---
{
  const h = harness();
  const cell = h.dispatch.pickId("primitives", "cell", 5);
  // Minting is what borrowing exists to prevent: only a stamp this Core made is a stamp.
  h.setStack(() => [
    { id: { pickId: { module: "mine", kind: "sat", idx: 12 } } },
    { id: cell },
  ]);
  let entities = null;
  h.dispatch.onPointer((ev) => { entities = ev.entities; });
  h.move(4, 4);
  assert.deepEqual(entities.map((x) => ({ ...x })), [
    { module: "primitives", kind: "cell", idx: 5 },
  ], "a hand-built lookalike is dropped, and the pickable underneath it is still reached");
}

// --- a crossing over nothing that was already nothing is not raised at all ---
{
  const h = harness();
  const sat = h.dispatch.pickId("primitives", "sat", 3);
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover", debounceMs: 1 }]);
  const local = [];
  h.dispatch.onPointer((e) => local.push(e));

  h.move(7, 9); // over empty globe
  await sleep(30);
  assert.equal(h.forwarded.length, 1, "the move itself is raised, entity or not");

  h.dispatch.refreshHover();
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 1, "a crossing over nothing, after nothing, says nothing new");
  assert.equal(local.length, 1, "and it is not dispatched locally either");

  // The scene changed under the resting cursor: that is exactly what the refresh exists for.
  h.setPick(() => ({ id: sat }));
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 2, "nothing becoming an entity is raised");

  // Still the same entity, and still raised: a crossing changes what the scene says about it.
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 3, "the same entity at a new keyframe is re-answered");

  // And it has to be able to become nothing again, or the box never hides.
  h.setPick(() => undefined);
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 4, "an entity becoming nothing is raised");
}

// --- a real move over empty globe keeps its event, unlike a refresh ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover", debounceMs: 1, coordinate: true }]);
  h.move(7, 9);
  await sleep(30);
  h.move(80, 90);
  await sleep(30);
  assert.equal(h.forwarded.length, 2,
    "a moving cursor over empty globe carries a new position, which a listener may have asked for");
}

// --- a resting cursor is not Cesium's scratch ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover", debounceMs: 1 }]);
  // ScreenSpaceEventHandler reuses one position object for every move, on every handler on the
  // canvas. A dispatch holding it by reference would refresh at wherever the scratch last pointed.
  h.move(7, 9);
  await sleep(30);
  h.scratch.x = 400;
  h.scratch.y = 400;
  h.dispatch.refreshHover();
  await sleep(30);
  assert.deepEqual(h.forwarded.at(-1).screen, { x: 7, y: 9 },
    "the refresh hovers where the cursor is, not where a shared scratch has since been moved");
}

// --- nothing is forwarded without a subscription ---
{
  const h = harness();
  h.setPick(() => ({ id: h.dispatch.pickId("m", "sat", 1) }));
  h.click(1, 1);
  await sleep(60);
  h.move(1, 1);
  await sleep(60);
  assert.deepEqual(h.forwarded, [], "an empty subscription forwards nothing");
}

// --- every modifier subset has an input action, so no combination is dropped before the Core ---
{
  const h = harness();
  const subsets = ["", "ALT", "CTRL", "SHIFT", "ALT+CTRL", "ALT+SHIFT", "CTRL+SHIFT",
                   "ALT+CTRL+SHIFT"];
  for (const gesture of ["MOVE", "CLICK"]) {
    assert.deepEqual(h.registered().filter((k) => k.startsWith(`${gesture}:`)).sort(),
      subsets.map((s) => `${gesture}:${s}`).sort(),
      `${gesture} is registered for all eight modifier subsets`);
  }
}

// --- mods match exactly, and every combination reaches the payload ---
{
  const h = harness();
  h.setPick(() => ({ id: h.dispatch.pickId("m", "sat", 1) }));
  h.dispatch.subscribe([{ type: "click", mods: ["alt"] }]);
  h.click(1, 1);
  h.click(1, 1, ["ctrl"]);
  h.click(1, 1, ["alt", "shift"]);
  assert.equal(h.forwarded.length, 0, "no modifiers, the wrong one, and a superset all fail to match");
  h.click(9, 8, ["alt"]);
  assert.equal(h.forwarded.length, 1, "alt+click matches");
  assert.deepEqual(h.forwarded[0].mods, ["alt"]);
  assert.deepEqual(h.forwarded[0].screen, { x: 9, y: 8 });
  assert.deepEqual({ ...h.forwarded[0].entities[0] }, { module: "m", kind: "sat", idx: 1 });

  const h2 = harness();
  h2.setPick(() => undefined);
  h2.dispatch.subscribe([{ type: "click", mods: ["ctrl", "shift"] }]);
  h2.click(0, 0, ["ctrl", "shift"]);
  assert.deepEqual(h2.forwarded[0].mods, ["ctrl", "shift"],
    "both held modifiers reach the payload, in a fixed order");

  const h3 = harness();
  h3.setPick(() => undefined);
  h3.dispatch.subscribe([{ type: "click", mods: ["alt", "ctrl", "shift"] }]);
  h3.click(0, 0, ["alt", "ctrl", "shift"]);
  assert.deepEqual(h3.forwarded[0]?.mods, ["alt", "ctrl", "shift"], "all three at once still arrive");
}

// --- a click carries the modifiers it began with, not the ones held when the button came up ---
{
  const h = harness();
  h.setPick(() => ({ id: h.dispatch.pickId("m", "cell", 1) }));
  h.dispatch.subscribe([{ type: "click", mods: ["alt"] }]);

  // Alt down, button down, alt released, button released — an ordinary quick alt-click. Cesium
  // raises LEFT_CLICK out of the mouseup and so fires the unmodified slot; the gesture still began
  // with alt, and that is what it is.
  h.click(1, 1, ["alt"], []);
  assert.equal(h.forwarded.length, 1, "letting go of alt before the button does not undo the alt-click");
  assert.deepEqual(h.forwarded[0].mods, ["alt"]);

  // And the reverse: a bare click with alt pressed before release is not an alt-click, whichever
  // slot Cesium chooses to raise it on.
  h.click(2, 2, [], ["alt"]);
  assert.equal(h.forwarded.length, 1, "a modifier pressed mid-gesture does not join it");

  // The same gesture in the mouse-event spelling — what a browser without pointer events delivers,
  // and what Cesium takes its input from there.
  h.click(3, 3, ["alt"], [], "mouse");
  assert.equal(h.forwarded.length, 2, "the latch is set by either spelling of the down");
}

// --- a hover reads the live modifier set, having no beginning to latch ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover", mods: ["shift"], debounceMs: 1 }]);
  h.click(0, 0, ["alt"]);          // latches alt for clicks
  h.move(1, 1, ["shift"]);
  await sleep(30);
  assert.equal(h.forwarded.length, 1, "the hover matched on what is held now, not on the click's latch");
  assert.deepEqual(h.forwarded[0].mods, ["shift"]);
}

// --- an entry naming no mods matches any modifier state; an empty list only the bare event ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "click" }]);
  h.click(0, 0);
  h.click(0, 0, ["shift"]);
  assert.equal(h.forwarded.length, 2, "an absent mods field matches any modifier state");

  const h2 = harness();
  h2.setPick(() => undefined);
  h2.dispatch.subscribe([{ type: "click", mods: [] }]);
  h2.click(0, 0, ["shift"]);
  assert.equal(h2.forwarded.length, 0, "an empty mods list matches only when none are held");
  h2.click(0, 0);
  assert.equal(h2.forwarded.length, 1);
}

// --- coordinate resolution is opt-in, lazy and memoised per event ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "click" }]);
  h.click(0, 0);
  assert.equal(h.raycasts(), 0, "a subscription that never asks for a coordinate pays no raycast");
  assert.equal(h.forwarded[0].coordinate, undefined);

  const h2 = harness();
  h2.setPick(() => undefined);
  h2.dispatch.subscribe([{ type: "click", coordinate: true }]);
  // A local handler reading the coordinate and the forwarder needing it share one ray-globe cast.
  h2.dispatch.onPointer((e) => { e.getCoordinate(); e.getCoordinate(); });
  h2.click(0, 0);
  assert.equal(h2.raycasts(), 1, "one raycast per event however many readers it has");
  assert.deepEqual(h2.forwarded[0].coordinate, { lon: 50, lat: 25, height: 12 });
}

// --- hovers are debounced on the trailing edge, at the smallest matching interval ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover" }]);
  let localSeen = 0;
  h.dispatch.onPointer(() => { localSeen++; });
  for (let i = 0; i < 5; i++) h.move(i, i);
  assert.equal(localSeen, 5, "every move reaches the local handlers, debounce or not");
  assert.equal(h.forwarded.length, 0, "nothing is forwarded inside the debounce interval");
  await sleep(DEFAULT_HOVER_DEBOUNCE_MS + 40);
  assert.equal(h.forwarded.length, 1, "one hover is forwarded per quiet interval");
  assert.deepEqual(h.forwarded[0].screen, { x: 4, y: 4 }, "and it is the last move, not the first");

  const h2 = harness();
  h2.setPick(() => undefined);
  h2.dispatch.subscribe([{ type: "hover", debounceMs: 200 }, { type: "hover", debounceMs: 5 }]);
  h2.move(0, 0);
  await sleep(60);
  assert.equal(h2.forwarded.length, 1, "the smallest debounce among matching entries wins");
}

// --- a refresh raises a hover at the resting cursor, and only while there is one ---
{
  const h = harness();
  h.setPick(() => undefined);
  h.dispatch.subscribe([{ type: "hover", debounceMs: 1 }]);

  // Before the pointer has ever been over the canvas there is no cursor to hover at.
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 0, "a refresh with no cursor behind it raises nothing");

  const sat = h.dispatch.pickId("primitives", "sat", 3);
  h.move(7, 9);
  await sleep(30);
  assert.equal(h.forwarded.length, 1);

  // What is under that pixel has changed, so the refresh picks again rather than replaying the hit.
  h.setPick(() => ({ id: sat }));
  const local = [];
  h.dispatch.onPointer((e) => local.push(e));
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 2, "a refresh travels the same subscription path as a move");
  assert.deepEqual(h.forwarded[1].screen, { x: 7, y: 9 }, "at the position the cursor last moved to");
  assert.deepEqual({ ...h.forwarded[1].entities[0] }, { module: "primitives", kind: "sat", idx: 3 },
    "re-picked, so a hover follows what the scene now draws there");
  assert.equal(local.length, 1, "and the local handlers see it, like any other hover");

  // Once the pointer is off the canvas there is nothing to hover.
  h.leave();
  h.dispatch.refreshHover();
  await sleep(30);
  assert.equal(h.forwarded.length, 2, "a refresh after the pointer left raises nothing");
}

// --- a disposed local handler stops being called ---
{
  const h = harness();
  h.setPick(() => undefined);
  let hits = 0;
  const off = h.dispatch.onPointer(() => { hits++; });
  h.click(0, 0);
  off();
  h.click(0, 0);
  assert.equal(hits, 1, "a disposed onPointer handler is not called again");
}

console.log("picking.test.mjs: all assertions passed");
