// Runnable check for the Core overlay regions. Run: node lib/core/src/overlay.test.mjs
// (bundles overlay.ts in-memory via esbuild — no Cesium, a faked DOM.)
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

// Minimal DOM: an element is a children array with append/remove; the container records what's added.
// `style` records `cssText` as written and keeps `setProperty` calls separately, so a test can tell
// a base rule from what a declaration merged over it.
function makeEl() {
  const el = {
    style: {
      properties: {},
      setProperty(k, v) { el.style.properties[k] = v; },
      // Writing cssText replaces the whole rule, as it does in a browser.
      set cssText(v) { el.style.rule = v; el.style.properties = {}; },
      get cssText() { return el.style.rule; },
    },
    children: [],
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() {
      const p = el.parent;
      if (p) { p.children.splice(p.children.indexOf(el), 1); el.parent = null; }
    },
  };
  return el;
}
globalThis.document = { createElement: () => makeEl() };

const { outputFiles } = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./overlay.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
});
const { createOverlay } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

// --- controls stack in insertion order within a region; a region host is created once, lazily ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  assert.equal(container.children.length, 0, "no region host until a control is added");

  const a = makeEl(), b = makeEl(), c = makeEl();
  ov.addControl("top-left", a);
  ov.addControl("top-left", b);
  ov.addControl("top-left", c);
  assert.equal(container.children.length, 1, "one region host reused for the same region");
  const host = container.children[0];
  assert.deepEqual(host.children, [a, b, c], "controls stack in insertion order");
  assert.equal(a.style.pointerEvents, "auto", "each control is made interactive");
}

// --- distinct regions get distinct hosts ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  ov.addControl("top-left", makeEl());
  ov.addControl("bottom-right", makeEl());
  ov.addControl("top-center", makeEl());
  ov.addControl("top-right", makeEl());
  assert.equal(container.children.length, 4, "one host per distinct region");
}

// --- the addControl Disposable removes just that control; others remain ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  const a = makeEl(), b = makeEl();
  const offA = ov.addControl("top-left", a);
  ov.addControl("top-left", b);
  const host = container.children[0];
  offA();
  assert.deepEqual(host.children, [b], "disposing a control removes only it");
}

// --- destroy() drains every region host from the container ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  ov.addControl("top-left", makeEl());
  ov.addControl("bottom-right", makeEl());
  ov.destroy();
  assert.equal(container.children.length, 0, "destroy removes all region hosts");
}

// --- the bottom inset reaches a host that exists already and one created later ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  ov.addControl("bottom-right", makeEl());
  assert.match(container.children[0].style.cssText, /bottom:34px/, "the band inset is the default");
  ov.setBottomInset(8);
  assert.match(container.children[0].style.cssText, /bottom:8px/, "an existing host is re-dressed");

  const empty = makeEl();
  const fresh = createOverlay(empty);
  fresh.setBottomInset(8);
  fresh.addControl("bottom-right", makeEl());
  assert.match(empty.children[0].style.cssText, /bottom:8px/, "a host created later takes the inset");
}

// --- a declared style merges over the base rule, and is picked up by a host created later ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  ov.declareRegionStyles({ "top-right": { gap: "12px" } });
  ov.addControl("top-right", makeEl());
  const host = container.children[0];
  assert.deepEqual(host.style.properties, { gap: "12px" }, "a later host picks the declaration up");
  assert.match(host.style.cssText, /flex-direction:row-reverse/, "the base rule survives the merge");

  // A declaration is a whole statement: a region it does not name returns to the Core's default.
  ov.declareRegionStyles({ "top-left": { "max-width": "40%" } });
  assert.deepEqual(host.style.properties, {}, "top-right is back to its default");
}

console.log("overlay.test.mjs: all assertions passed");
