import assert from "node:assert/strict";
import test from "node:test";

// Drawing a stock glyph is the only thing here that wants a DOM.
(globalThis as Record<string, unknown>).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }),
  }),
};

const { markerSprite } = await import("./sprites.ts");

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

test("a supplied image passes through, and a stock glyph is drawn once and shared", () => {
  // Cesium takes the URI itself, so nothing is drawn here and the string arrives as it was sent.
  assert.equal(markerSprite(PIXEL), PIXEL);

  const star = markerSprite("star");
  assert.notEqual(typeof star, "string", "a stock name draws a canvas");
  assert.equal(markerSprite("star"), star, "and the second family to ask for it shares the first's");
  assert.notEqual(markerSprite("disc"), star, "each glyph gets its own");

  // A name that is neither stock nor an image is the disc, which keeps a typo visible rather than
  // leaving the family unmarked.
  assert.equal(markerSprite("rhombus"), markerSprite("disc"));
});
