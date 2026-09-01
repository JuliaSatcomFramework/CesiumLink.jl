// Runnable check for the Core overlay regions. Run: node lib/core/src/overlay.test.mjs
// (bundles overlay.ts in-memory via esbuild — no Cesium, a stand-in for DOMPurify, a faked DOM.)
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

// A stand-in for DOMPurify. The real sanitizer parses HTML and needs a DOM, and this file runs in
// Node. The stand-in records every string it is given and takes a script element out, so a case can
// read what the overlay does with a credit: hand it over whole, and draw the answer and nothing else.
const PURIFY_STUB = `
globalThis.__purify = { seen: [], configs: [] };
export default {
  sanitize(html, config) {
    globalThis.__purify.seen.push(html);
    globalThis.__purify.configs.push(config);
    return html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, "");
  },
};
`;

// Minimal DOM: an element is a children array with append/prepend/remove; the container records
// what's added. `style` records `cssText` as written and keeps `setProperty` calls separately, so a
// test can tell a base rule from what a declaration merged over it.
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
    prepend(c) { c.parent = el; el.children.unshift(c); return c; },
    remove() {
      const p = el.parent;
      if (p) { p.children.splice(p.children.indexOf(el), 1); el.parent = null; }
    },
    // The credit setter hands the pointer back to each link of the sanitized line. There is no
    // parser here, so the stand-in answers one element per opening tag and keeps them on `anchors`.
    querySelectorAll(selector) {
      assert.equal(selector, "a", `the stand-in answers "a" and nothing else, not ${selector}`);
      el.anchors = [...String(el.innerHTML ?? "").matchAll(/<a\b/g)].map(() => ({ style: {} }));
      return el.anchors;
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
  plugins: [
    {
      name: "purify-stand-in",
      setup(build) {
        build.onResolve({ filter: /^dompurify$/ }, () => ({
          path: "dompurify",
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: PURIFY_STUB,
          loader: "js",
        }));
      },
    },
  ],
});
const { createOverlay, scrubRegionStyle } = await import(
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

// --- the credit is the bottom-most member of the bottom-right stack ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  const control = makeEl();
  ov.addControl("bottom-right", control);
  ov.setCredit("Somebody else's tiles");
  const host = container.children[0];
  assert.equal(container.children.length, 1, "the credit joins the region rather than the container");
  // The region is column-reverse, so the first child draws at the bottom.
  assert.equal(host.children[0].innerHTML, "Somebody else's tiles",
    "the credit is first, so it draws below a control added before it");
  assert.equal(host.children[1], control, "and the control stacks above it");

  // The credit rides the region's inset, so it can never land on top of the region again.
  ov.setBottomInset(8);
  assert.match(host.style.cssText, /bottom:8px/, "one inset for the stack the credit is in");
  assert.doesNotMatch(host.children[0].style.cssText, /position|top|right|bottom|left|z-index/,
    "the credit declares no placement of its own — the region it sits in owns that");
}

// --- a credit is HTML: the sanitizer sees it whole, and its answer is the whole of what is drawn ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  const credit = '<script>alert("tiles")</script><a href="https://example.org/">Somebody</a>';
  globalThis.__purify.seen.length = 0;
  globalThis.__purify.configs.length = 0;
  ov.setCredit(credit);
  const el = container.children[0].children[0];
  assert.deepEqual(globalThis.__purify.seen, [credit],
    "the declared string reaches the sanitizer whole, script and anchor alike");
  assert.equal(el.innerHTML, '<a href="https://example.org/">Somebody</a>',
    "the page holds the answer of the sanitizer: the anchor lives, so a credit can carry its link");
  assert.doesNotMatch(el.innerHTML, /script|alert/,
    "and neither the script element nor the code inside it survives");
  assert.equal(el.textContent, undefined, "the string is drawn as markup, so nothing writes it as text");
  assert.match(el.style.cssText, /pointer-events:none/,
    "the line lies over the globe, so a drag that starts on its text still turns the globe");
  assert.deepEqual(el.anchors.map((a) => a.style.pointerEvents), ["auto"],
    "and the anchor takes the pointer back, or the link in a credit could not be followed");
  assert.deepEqual(el.anchors.map((a) => a.rel), ["noopener noreferrer"],
    "a credit link that opens a tab cannot reach back into this page");
  // `?credit=` on the browser and player hosts puts this string in the page URL, so the allow-list
  // is what stops one anchor covering the viewport and taking every click.
  const config = globalThis.__purify.configs[0];
  assert.ok(config, "the credit is sanitized against a stated allow-list, not the default one");
  assert.ok(!config.ALLOWED_ATTR.includes("style") && !config.ALLOWED_ATTR.includes("class"),
    "and that list carries no attribute that paints");
  assert.ok(config.ALLOWED_TAGS.includes("a") && config.ALLOWED_ATTR.includes("href"),
    "while a link still survives it, which is the whole point of an HTML credit");
}

// --- the credit follows the pick: one line, rewritten, and taken down by an entry without one ---
{
  const container = makeEl();
  const ov = createOverlay(container);
  ov.setCredit("NASA EOSDIS GIBS");
  const host = container.children[0];

  // The reader picks another source. The picker sets the line for whatever it just built.
  ov.setCredit("Somebody else's tiles");
  assert.equal(host.children.length, 1, "a switch rewrites the line rather than adding one");
  assert.equal(host.children[0].innerHTML, "Somebody else's tiles",
    "and the line names the source the reader picked");

  // The bundled texture is public domain and asks for no attribution, so its entry has no credit.
  ov.setCredit(undefined);
  assert.deepEqual(host.children, [], "an entry that declares no credit takes the line down");

  // A pick after that builds the line again, and it is still the bottom-most member.
  const control = makeEl();
  ov.addControl("bottom-right", control);
  ov.setCredit("NASA EOSDIS GIBS");
  assert.equal(host.children[0].innerHTML, "NASA EOSDIS GIBS", "the line comes back at the bottom");
  assert.equal(host.children[1], control, "under the control that was there before it");
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

// --- a style with no placement in it passes through untouched, and warns about nothing ---
{
  const warned = [];
  const bag = { "flex-direction": "row-reverse", gap: "12px" };
  assert.deepEqual(scrubRegionStyle("top-right", bag, (m) => warned.push(m)), bag, "kept as declared");
  assert.deepEqual(warned, [], "nothing to refuse");
}

// --- each placement property is refused, once, and the rest of the same bag survives ---
for (const property of ["position", "top", "right", "bottom", "left", "transform", "z-index", "inset"]) {
  const warned = [];
  const kept = scrubRegionStyle("top-right", { [property]: "0", gap: "4px" }, (m) => warned.push(m));
  assert.deepEqual(kept, { gap: "4px" }, `'${property}' is dropped and the rest of the bag applies`);
  assert.deepEqual(
    warned,
    [`overlay: region top-right may not set '${property}' — the Core owns placement (ADR-0004)`],
    `'${property}' is refused once, by name`,
  );
}

// --- a placement property spelled in upper case is refused too ---
{
  const warned = [];
  const kept = scrubRegionStyle("top-left", { Top: "0", LEFT: "0", gap: "4px" }, (m) => warned.push(m));
  assert.deepEqual(kept, { gap: "4px" }, "case does not get a placement property past the refusal");
  assert.equal(warned.length, 2, "each refusal is warned about, by the name as declared");
}

console.log("overlay.test.mjs: all assertions passed");
