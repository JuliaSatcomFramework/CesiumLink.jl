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

const { defineNodeSprite, clearNodeSprites, markerSprite } = await import("./sprites.ts");

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

/** A host that serves every asset path, which is what a browser page is. */
const served = (path: string) => `https://host/${path}`;

/** Run `f` with `console.warn` captured, and answer what it wrote. */
function warnings(f: () => void): string[] {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => said.push(m);
  try {
    f();
  } finally {
    console.warn = warn;
  }
  return said;
}

test("a supplied image passes through, and a stock glyph is drawn once and shared", () => {
  // Cesium takes the URI itself, so nothing is drawn here and the string arrives as it was sent.
  assert.equal(markerSprite(PIXEL, served), PIXEL);

  const star = markerSprite("star", served);
  assert.notEqual(typeof star, "string", "a stock name draws a canvas");
  assert.equal(markerSprite("star", served), star, "and the second family to ask for it shares the first's");
  assert.notEqual(markerSprite("disc", served), star, "each glyph gets its own");

  // A stock name that names no glyph is the disc, silently: the stock table is this module's own,
  // and the disc keeps a typo visible rather than leaving the family unmarked.
  const said = warnings(() => assert.equal(markerSprite("rhombus", served), markerSprite("disc", served)));
  assert.deepEqual(said, []);
});

// The names `MARKERS` in `src/primitives/nodes.jl` admits. A name the server accepts and this
// module has no glyph for draws the disc, silently, so nothing else would report the gap.
const STOCK = ["disc", "square", "diamond", "triangle", "triangle_down", "triangle_right",
               "triangle_left", "pentagon", "hexagon", "star", "cross", "x"];

test("every stock name draws a glyph of its own", () => {
  const drawn = STOCK.map((name) => markerSprite(name, served));
  assert.equal(new Set(drawn).size, STOCK.length, "a name fell through to the disc");
});

test("an asset path goes through the host's resolver, and a path it cannot reach is the disc", () => {
  assert.equal(markerSprite("assets/sprites/sat.png", served), "https://host/assets/sprites/sat.png",
               "the url came from assetUrl rather than from the payload's own path");
  // `assetUrl` writes the line that says why, so this only draws.
  assert.equal(markerSprite("assets/sprites/sat.png", () => null), markerSprite("disc", served));
});

test("a registered name draws what its module registered, and an unregistered one warns once", () => {
  const own = { own: true } as unknown as HTMLCanvasElement;
  defineNodeSprite("orbits.pulse", () => own);
  assert.equal(markerSprite("orbits.pulse", served), own);

  const said = warnings(() => {
    assert.equal(markerSprite("orbits.absent", served), markerSprite("disc", served));
    markerSprite("orbits.absent", served);
  });
  assert.equal(said.length, 1, "one line per unresolvable name, however many windows ask");
  assert.match(said[0], /no node sprite named "orbits.absent" is registered/);

  // Teardown frees the name: the module that registered it registers again when it reloads.
  clearNodeSprites();
  const after = warnings(() => {
    assert.equal(markerSprite("orbits.pulse", served), markerSprite("disc", served));
    markerSprite("orbits.absent", served);
  });
  // And it frees the names already warned about, so a reload says again what it still cannot draw.
  assert.equal(after.length, 2);
});
