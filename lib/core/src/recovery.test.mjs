// Runnable check for the recovery after a lost WebGL context. Run: node lib/core/src/recovery.test.mjs
// (transpiles recovery.ts in-memory via esbuild — no Cesium, a faked DOM and IntersectionObserver.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

function makeEl() {
  const el = {
    children: [],
    parent: null,
    handlers: new Map(),
    textContent: "",
    attrs: {},
    setAttribute(k, v) { el.attrs[k] = v; },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() {
      const p = el.parent;
      if (p) { p.children.splice(p.children.indexOf(el), 1); el.parent = null; }
    },
    addEventListener(type, fn) {
      if (!el.handlers.has(type)) el.handlers.set(type, []);
      el.handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = el.handlers.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(type, event = {}) {
      for (const fn of [...(el.handlers.get(type) ?? [])]) fn(event);
    },
  };
  return el;
}
globalThis.document = { createElement: () => makeEl() };

// Each loss warns once in the console, which is what a reader sees and not what this file checks.
console.warn = () => {};

// The observers that exist now. A test reports what the browser would: the view is in or out.
const observers = new Set();
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; this.targets = []; observers.add(this); }
  observe(el) { this.targets.push(el); }
  disconnect() { observers.delete(this); }
};
const report = (inView) => {
  for (const o of [...observers]) o.cb(o.targets.map(() => ({ isIntersecting: inView })));
};

/** A widget whose context a test can take away. */
function makeWidget() {
  const errorListeners = [];
  const w = {
    canvas: makeEl(),
    lost: false,
    panels: [],
    useDefaultRenderLoop: true,
    scene: {
      renderError: {
        addEventListener(cb) {
          errorListeners.push(cb);
          return () => errorListeners.splice(errorListeners.indexOf(cb), 1);
        },
      },
    },
    showErrorPanel(title, _message, error) { w.panels.push({ title, error }); },
    loseContext() { w.lost = true; w.canvas.fire("webglcontextlost"); },
    renderError(err) { for (const cb of [...errorListeners]) cb(w.scene, err); },
  };
  return w;
}

const src = await readFile(new URL("./recovery.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { AUTO_REBUILDS, AUTO_REBUILD_PERIOD_MS, createRecovery } =
  await import("data:text/javascript," + encodeURIComponent(code));

const settle = () => new Promise((r) => setTimeout(r, 0));
const noteOf = (container) => container.children[0]?.textContent ?? null;

/** A viewer the way `createViewer` wires one: each build watches its new widget. */
function makeViewer({ rebuild = true, failFirst = false } = {}) {
  const container = makeEl();
  const v = { container, builds: 0, widget: makeWidget() };
  let fail = failFirst;
  const watch = () => v.recovery.watch(v.widget, () => v.widget.lost);
  v.recovery = createRecovery(container, rebuild ? async () => {
    if (fail) { fail = false; throw new Error("no build"); }
    v.builds++;
    v.widget = makeWidget();
    watch();
  } : null);
  watch();
  return v;
}

// --- a view that loses its context while on screen builds again, and the note goes ---
{
  observers.clear();
  const v = makeViewer();
  const first = v.widget;
  first.loseContext();
  assert.equal(first.useDefaultRenderLoop, false, "the lost widget stops its render loop");
  assert.match(noteOf(v.container), /Click to restore/);
  report(true);
  await settle();
  assert.equal(v.builds, 1, "a view on screen builds again without a click");
  assert.notEqual(v.widget, first);
  assert.equal(noteOf(v.container), null, "the note goes when the new viewer is up");
  assert.equal(observers.size, 0, "nothing observes the view while its context is live");
  v.recovery.destroy();
}

// --- a view off screen waits, and builds when it comes into view ---
{
  observers.clear();
  const v = makeViewer();
  v.widget.loseContext();
  report(false);
  await settle();
  assert.equal(v.builds, 0, "a view off screen does not take a context");
  report(true);
  await settle();
  assert.equal(v.builds, 1);
  v.recovery.destroy();
}

// --- the frame that runs before the loss event is the loss, and shows no error panel ---
{
  observers.clear();
  const v = makeViewer();
  const w = v.widget;
  w.lost = true;
  w.renderError(new Error("Expected width to be greater than 0"));
  assert.deepEqual(w.panels, [], "a lost context is not a render error");
  assert.match(noteOf(v.container), /graphics context/);
  w.canvas.fire("webglcontextlost");
  assert.equal(observers.size, 1, "the event that follows starts nothing a second time");
  v.recovery.destroy();
}

// --- a render error on a live context is a fault of the scene: the panel, and no build ---
{
  observers.clear();
  const v = makeViewer();
  const err = new Error("bad primitive");
  v.widget.renderError(err);
  assert.equal(v.widget.panels.length, 1);
  assert.equal(v.widget.panels[0].error, err);
  assert.equal(observers.size, 0);
  assert.equal(noteOf(v.container), null);
  v.recovery.destroy();
}

// --- past the limit, a view that loses its context again waits for a click ---
{
  observers.clear();
  const v = makeViewer();
  for (let i = 0; i < AUTO_REBUILDS; i++) {
    v.widget.loseContext();
    report(true);
    await settle();
  }
  assert.equal(v.builds, AUTO_REBUILDS);
  v.widget.loseContext();
  report(true);
  await settle();
  assert.equal(v.builds, AUTO_REBUILDS, "two views that take the context from each other stop");
  assert.match(noteOf(v.container), /again\. Click to restore/);
  assert.equal(observers.size, 0, "the view is no longer observed");
  v.container.children[0].fire("click");
  await settle();
  assert.equal(v.builds, AUTO_REBUILDS + 1, "a click builds past the limit");

  // Once the period is over, a loss in view builds by itself again.
  const now = Date.now;
  Date.now = () => now() + AUTO_REBUILD_PERIOD_MS + 1;
  try {
    v.widget.loseContext();
    report(true);
    await settle();
    assert.equal(v.builds, AUTO_REBUILDS + 2);
  } finally {
    Date.now = now;
  }
  v.recovery.destroy();
}

// --- a build that fails asks for a click, and the click tries again ---
{
  observers.clear();
  const v = makeViewer({ failFirst: true });
  const error = console.error;
  console.error = () => {};
  try {
    v.widget.loseContext();
    report(true);
    await settle();
  } finally {
    console.error = error;
  }
  assert.equal(v.builds, 0);
  assert.match(noteOf(v.container), /did not come back\. Click to try again/);
  v.container.children[0].fire("click");
  await settle();
  assert.equal(v.builds, 1);
  assert.equal(noteOf(v.container), null);
  v.recovery.destroy();
}

// --- a host that cannot build again asks for a reload, and observes nothing ---
{
  observers.clear();
  const v = makeViewer({ rebuild: false });
  v.widget.loseContext();
  assert.match(noteOf(v.container), /Reload the page/);
  assert.equal(observers.size, 0);
  v.recovery.destroy();
}

// --- a destroyed viewer takes its note and its observer with it, and ignores a late loss ---
{
  observers.clear();
  const v = makeViewer();
  const w = v.widget;
  w.loseContext();
  v.recovery.destroy();
  assert.equal(v.container.children.length, 0);
  assert.equal(observers.size, 0);
  w.lost = false;
  w.loseContext();
  assert.equal(v.container.children.length, 0, "a loss after destroy shows nothing");
}

console.log("recovery.test.mjs: ok");
