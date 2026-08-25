// Runnable check for the canvas capture. Run: node lib/core/src/capture.test.mjs
// (transpiles capture.ts in-memory via esbuild — no Cesium, a faked DOM.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

// Minimal DOM. An element records the handlers it takes, so a test fires a press the way a browser
// does, and `fire` returns nothing that a real event would not carry.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    parent: null,
    handlers: new Map(),
    style: {
      properties: {},
      setProperty(k, v) { el.style.properties[k] = v; },
      set cssText(v) { el.style.rule = v; el.style.properties = {}; },
      get cssText() { return el.style.rule; },
    },
    setAttribute() {},
    focus() {},
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    replaceChildren(...cs) { el.children = []; el.append(...cs); },
    remove() {
      const p = el.parent;
      if (p) { p.children.splice(p.children.indexOf(el), 1); el.parent = null; }
    },
    contains(node) {
      for (let n = node; n; n = n.parent) if (n === el) return true;
      return false;
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

/** Every element under `root`, in document order, so a test finds a control by what it says. */
function all(root) {
  return root.children.flatMap((c) => [c, ...all(c)]);
}
const withText = (root, text) => all(root).find((e) => e.textContent === text);

const body = makeEl("body");
globalThis.document = {
  title: "CesiumLink — Mars",
  body,
  handlers: new Map(),
  createElement: (tag) => makeEl(tag),
  createElementNS: (_ns, tag) => makeEl(tag),
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const list = this.handlers.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  fire(type, event) { for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event); },
};

const src = await readFile(new URL("./capture.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { bytesOfDataUrl, canCopy, captureCell, captureName, scaleError, takeCapture } =
  await import("data:text/javascript," + encodeURIComponent(code));

// --- the file name: the page title, the time, and nothing a file system refuses ---
{
  const when = new Date(2026, 7, 25, 9, 4, 7);
  assert.equal(captureName("CesiumLink — Mars", when), "CesiumLink-Mars-20260825-090407.png");
  assert.equal(captureName("", when), "capture-20260825-090407.png",
    "a page with no title still gives a name");
  assert.equal(captureName("//../etc", when), "etc-20260825-090407.png",
    "nothing but letters, digits and a dash reaches the name");
  const later = captureName("x", new Date(2026, 7, 25, 9, 4, 8));
  assert.notEqual(captureName("x", when), later, "two captures a second apart differ");
}

// --- the scale check: the GPU limit is answered before the render, never after it ---
{
  assert.equal(scaleError(1, 800, 600, 4096), null);
  assert.equal(scaleError(4, 800, 600, 4096), null, "3200x2400 fits inside 4096");
  assert.match(scaleError(8, 800, 600, 4096), /6400x4800.*at most 4096/,
    "the reason names the pixels asked for and the limit");
  assert.equal(scaleError(8, 800, 600, 0), null, "a GPU that states no limit is not second-guessed");
  assert.match(scaleError(0, 800, 600, 4096), /not a positive number/);
  assert.match(scaleError(-2, 800, 600, 4096), /not a positive number/);
  assert.match(scaleError(1, 0, 0, 4096), /no size on screen/);
}

// --- the bytes of a data URL are the bytes the canvas wrote ---
{
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const url = "data:image/png;base64," + Buffer.from(png).toString("base64");
  assert.deepEqual([...bytesOfDataUrl(url)], png);
}

/** A widget that answers what a capture reads, and records what the capture did to it. */
function fakeWidget({ max = 0, width = 800, height = 600 } = {}) {
  const url = "data:image/png;base64," + Buffer.from([1, 2, 3]).toString("base64");
  const widget = {
    resolutionScale: 0.87,
    resizes: 0,
    renders: [],
    canvas: { width, height, toDataURL: () => url },
    scene: {
      context: max ? { _gl: { MAX_TEXTURE_SIZE: 1, getParameter: () => max } } : undefined,
      render: () => widget.renders.push(widget.resolutionScale),
    },
    clock: { currentTime: "now" },
    resize() { widget.resizes++; },
  };
  return widget;
}

// --- a scaled capture puts back the resolution scale it read, and never 1 (scene.ts owns it) ---
{
  const widget = fakeWidget();
  const shot = takeCapture(widget, 2);
  assert.equal(shot.ok, true);
  assert.deepEqual([...shot.bytes], [1, 2, 3]);
  assert.equal(widget.resolutionScale, 0.87,
    "the value separateDrawingBuffer gave this viewer comes back untouched");
  assert.deepEqual(widget.renders, [1.74, 0.87],
    "the capture renders at the scaled buffer, then puts the screen back in the same tick");
  assert.equal(widget.resizes, 2, "one resize onto the scaled buffer, one back");
}

// --- scale 1 touches neither the resolution scale nor the buffer size ---
{
  const widget = fakeWidget();
  assert.equal(takeCapture(widget, 1).ok, true);
  assert.equal(widget.resolutionScale, 0.87);
  assert.equal(widget.resizes, 0);
  assert.deepEqual(widget.renders, [0.87], "one render, and the read follows it in the same tick");
}

// --- a scale past the GPU limit gives the reason, and draws nothing at all ---
{
  const widget = fakeWidget({ max: 4096 });
  const shot = takeCapture(widget, 8);
  assert.equal(shot.ok, false);
  assert.match(shot.error, /at most 4096/);
  assert.deepEqual(widget.renders, [], "a blank picture never reaches the caller");
  assert.equal(widget.resolutionScale, 0.87);
}

// --- a canvas that will not draw gives the reason, and still puts the resolution scale back ---
{
  const widget = fakeWidget();
  widget.canvas.toDataURL = () => { throw new Error("tainted"); };
  const shot = takeCapture(widget, 2);
  assert.equal(shot.ok, false);
  assert.match(shot.error, /tainted/);
  assert.equal(widget.resolutionScale, 0.87);
}

// --- the button: a right press opens the popup and takes the browser menu away ---
{
  const widget = fakeWidget();
  const cell = makeEl("div");
  const item = captureCell(cell, widget);
  const root = cell.children[0];
  const button = root.children[0];
  const panel = root.children[root.children.length - 1];
  assert.equal(panel.style.cssText.includes("display:none"), true, "the popup starts closed");

  let prevented = 0;
  button.fire("contextmenu", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, "the browser context menu offers nothing about the canvas");
  assert.equal(panel.style.display, "flex", "the popup is on screen");

  // Both buttons are on the panel, always. This page has no clipboard, so Copy says why it is dead.
  const copy = withText(panel, "Copy");
  const save = withText(panel, "Download");
  assert.ok(copy && save, "the popup holds both a Copy and a Download button");
  assert.equal(canCopy(), false, "node has no clipboard, which is the page this case is about");
  assert.equal(copy.disabled, true);
  assert.match(copy.title, /clipboard/i, "a dead button says why it is dead");
  assert.equal(save.disabled, undefined, "Download works on every page");

  // The name and the scale list are built on opening, and nothing outlives the page.
  const name = all(panel).find((e) => e.tag === "input");
  assert.match(name.value, /^CesiumLink-Mars-\d{8}-\d{6}\.png$/);
  const scales = all(panel).find((e) => e.tag === "select");
  assert.deepEqual(scales.children.map((o) => o.textContent), ["1x", "2x", "3x", "4x"]);
  assert.equal(scales.value, "1");

  // Escape puts it away, and so does a press anywhere else.
  document.fire("keydown", { key: "Escape" });
  assert.equal(panel.style.display, "none");
  button.fire("contextmenu", { preventDefault: () => {} });
  document.fire("pointerdown", { target: makeEl("div") });
  assert.equal(panel.style.display, "none", "a press outside the cell closes the popup");

  item.destroy();
  assert.equal(cell.children.length, 0, "destroying the cell takes the whole item off the page");
}

// --- a left press on a page with no clipboard opens the popup, so the button is never dead ---
{
  const widget = fakeWidget();
  const cell = makeEl("div");
  const item = captureCell(cell, widget);
  const root = cell.children[0];
  const button = root.children[0];
  const panel = root.children[root.children.length - 1];
  button.fire("click", {});
  assert.equal(panel.style.display, "flex",
    "with no clipboard to copy to, the press offers the download instead");
  assert.deepEqual(widget.renders, [], "opening the popup draws nothing");
  item.destroy();
}

// --- a touch long press opens the popup, and the press that follows it does nothing ---
{
  const widget = fakeWidget();
  const cell = makeEl("div");
  const item = captureCell(cell, widget);
  const root = cell.children[0];
  const button = root.children[0];
  const panel = root.children[root.children.length - 1];
  button.fire("pointerdown", { pointerType: "touch" });
  await new Promise((done) => setTimeout(done, 700));
  assert.equal(panel.style.display, "flex", "the long press opened the popup");
  button.fire("pointerup", {});
  button.fire("click", {});
  assert.equal(panel.style.display, "flex", "the press that ends the long press does not close it");
  item.destroy();
}

// --- a press with a mouse arms no long press ---
{
  const widget = fakeWidget();
  const cell = makeEl("div");
  const item = captureCell(cell, widget);
  const root = cell.children[0];
  const button = root.children[0];
  const panel = root.children[root.children.length - 1];
  button.fire("pointerdown", { pointerType: "mouse" });
  await new Promise((done) => setTimeout(done, 700));
  assert.notEqual(panel.style.display, "flex", "a mouse press leaves the popup where it was");
  item.destroy();
}

console.log("capture.test.mjs: ok");
