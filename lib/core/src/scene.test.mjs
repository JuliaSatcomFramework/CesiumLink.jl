// Runnable check for the scene builder. Run: node lib/core/src/scene.test.mjs
// (bundles scene.ts with a stand-in for @cesium/engine — no real Cesium, no browser, no test
// framework.) The stand-in records what `Ellipsoid.default` was at the instant the widget was
// constructed, which is the whole question: every conversion helper that is not handed an ellipsoid
// reads that static, so a globe built before it is set draws a scene on one shape whose coordinates
// were computed on another.
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const CESIUM_STUB = `
export class Ellipsoid {
  constructor(x, y, z) { this.radii = { x, y, z }; }
  static get default() { return Ellipsoid._default; }
  static set default(v) { Ellipsoid._default = v; }
}
Ellipsoid.WGS84 = new Ellipsoid(6378137.0, 6378137.0, 6356752.3142451793);
Ellipsoid._default = Ellipsoid.WGS84;

export const Ion = { defaultAccessToken: "an ion token nobody asked for" };
export class ImageryLayer { constructor(provider) { this.provider = provider; } }
export const TileMapServiceImageryProvider = {
  fromUrl(url, options) {
    globalThis.__cesium.fetched.push(url);
    // A pyramid whose tilemapresource.xml is not there: the one construction that can reject.
    if (url.includes("dead-host")) return Promise.reject(new Error("404 tilemapresource.xml"));
    return Promise.resolve({ url, options });
  },
};
export class UrlTemplateImageryProvider { constructor(options) { this.options = options; } }
export class WebMercatorTilingScheme { constructor(options) { this.ellipsoid = options.ellipsoid; } }
export class GeographicTilingScheme { constructor(options) { this.ellipsoid = options.ellipsoid; } }
export const Color = { DIMGRAY: "the flat colour of a bare globe" };
export class CesiumWidget {
  constructor(container, options) {
    globalThis.__cesium.built.push({ container, options, defaultAtBuild: Ellipsoid.default });
    // The canvas that the widget draws into. The builder marks this canvas, and reads the marks of
    // the canvases that the page already holds. A stand-in without both cannot answer that question.
    const attributes = {};
    this.canvas = {
      ...globalThis.__cesium.canvasSize,
      setAttribute(name, value) { attributes[name] = value; },
      getAttribute(name) { return attributes[name] ?? null; },
    };
    globalThis.__cesium.canvases.push(this.canvas);
    this.resolutionScale = 1;
    // Cesium puts the \`baseLayer\` option in \`imageryLayers\` as layer 0, so the stand-in counts it.
    const layers = options.baseLayer ? [options.baseLayer] : [];
    this.scene = {
      ellipsoid: options.ellipsoid ?? Ellipsoid.default,
      globe: { baseColor: null, enableLighting: false },
      imageryLayers: {
        add(layer) { layers.push(layer); },
        get(i) { return layers[i]; },
        get length() { return layers.length; },
      },
    };
    this.clock = {};
  }
}
globalThis.__cesium.Ellipsoid = Ellipsoid;
globalThis.__cesium.Color = Color;
`;

globalThis.__cesium = { fetched: [], built: [], canvases: [], canvasSize: { clientWidth: 900, clientHeight: 520 } };
// The parts of the DOM that the builder uses: the detached div that takes the Cesium credits, the
// credit line that a declared basemap adds, and the canvases that the page already holds. The credit
// writes only `textContent`, so the stand-in element holds nothing else.
globalThis.document = {
  createElement: () => ({ style: {} }),
  querySelectorAll: (selector) => {
    const attribute = selector.match(/^canvas\[([\w-]+)\]$/)?.[1];
    assert.ok(attribute, `the stand-in answers "canvas[attribute]" and nothing else, not ${selector}`);
    return globalThis.__cesium.canvases.filter((c) => c.getAttribute(attribute) !== null);
  },
};
/** A container that records what the builder appends to it. */
const makeContainer = () => ({ id: "app", children: [], appendChild(el) { this.children.push(el); } });

const { outputFiles } = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./scene.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
  plugins: [
    {
      name: "cesium-stand-in",
      setup(build) {
        build.onResolve({ filter: /^@cesium\/engine$/ }, () => ({
          path: "cesium",
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: CESIUM_STUB,
          loader: "js",
        }));
      },
    },
  ],
});
const { basemapProviders, basemapSet, createScene, loadImagery } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);
const { Ellipsoid } = globalThis.__cesium;

const WGS84 = { a: 6378137.0, b: 6356752.3142451793 };
// Not Earth, and far more flattened than any planet, so no case here can pass by landing near the
// default it is meant to have replaced.
const ODD = { a: 3396190.0, b: 2000000.0 };

const built = () => globalThis.__cesium.built.at(-1);
// `Ellipsoid.default` is one static in one bundle. A page builds one scene, so the builder sets it
// once and never restores it; a file of cases has to put it back between them.
const reset = () => {
  Ellipsoid.default = Ellipsoid.WGS84;
};

// --- no ellipsoid named: WGS84 stands, and the widget is told nothing ---
{
  const widget = await createScene({ id: "app" }, { baseUrl: "cesium/" });
  assert.equal(built().options.ellipsoid, undefined, "no ellipsoid is passed to the widget");
  assert.equal(widget.scene.ellipsoid, Ellipsoid.WGS84, "the scene is on Cesium's own default");
  assert.equal(Ellipsoid.default, Ellipsoid.WGS84, "the global default is left alone");
  reset();
}

// --- the imagery fetch is started once and joined, not repeated per scene ---
{
  const before = globalThis.__cesium.fetched.length;
  const started = loadImagery("cesium/");
  await createScene({ id: "app" }, { baseUrl: "cesium/" });
  assert.equal(globalThis.__cesium.fetched.length, before, "a started fetch is joined, not re-run");
  assert.equal(built().options.baseLayer.provider, await started, "the widget draws that fetch");
  reset();
}

// --- declared radii: the globe is built on them, and the default is set BEFORE it exists ---
{
  const widget = await createScene({ id: "app" }, { baseUrl: "cesium/", ellipsoid: ODD });
  assert.deepEqual(
    widget.scene.ellipsoid.radii,
    { x: ODD.a, y: ODD.a, z: ODD.b },
    "semi-major on both equatorial axes, semi-minor on the polar one",
  );
  assert.equal(
    built().options.ellipsoid,
    widget.scene.ellipsoid,
    "the widget is handed the shape rather than left to read the static",
  );
  assert.equal(
    built().defaultAtBuild,
    widget.scene.ellipsoid,
    "Ellipsoid.default was already the declared shape when the widget was constructed",
  );
  assert.equal(Ellipsoid.default, widget.scene.ellipsoid, "and it stays set for every decoder");
  reset();
}

// --- the timeout path: no declaration, so the viewer is built on WGS84 anyway ---
{
  const { firstDeclaration } = await import("./transport.ts");
  const silent = { on() {} };
  const declaration = await firstDeclaration(silent, 5);
  assert.equal(declaration, null, "a server that never declares gives nothing to build from");
  const widget = await createScene(
    { id: "app" },
    { baseUrl: "cesium/", ellipsoid: declaration?.ellipsoid },
  );
  assert.deepEqual(
    { a: widget.scene.ellipsoid.radii.x, b: widget.scene.ellipsoid.radii.z },
    WGS84,
    "a globe still appears, on WGS84",
  );
  reset();
}

// --- a declared TMS source: that provider, on the session's ellipsoid ---
{
  const widget = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    ellipsoid: ODD,
    imagery: { url: "imagery/", layout: "tms" },
  });
  const provider = built().options.baseLayer.provider;
  assert.equal(provider.url, "imagery/", "the declared pyramid, not the bundled one");
  assert.equal(
    provider.options.ellipsoid,
    widget.scene.ellipsoid,
    "the provider is handed the shape rather than left to read the static",
  );
  reset();
}

// --- a declared XYZ source: a template provider, Web Mercator by default, depth carried over ---
{
  const widget = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    ellipsoid: ODD,
    imagery: { url: "https://host/tiles/{z}/{x}/{y}.png", layout: "xyz", maxLevel: 7 },
  });
  const { options } = built().options.baseLayer.provider;
  assert.equal(options.url, "https://host/tiles/{z}/{x}/{y}.png", "the template is passed verbatim");
  assert.equal(options.maximumLevel, 7, "the declared depth reaches the provider");
  assert.equal(
    options.tilingScheme.constructor.name,
    "WebMercatorTilingScheme",
    "a template means {z}/{x}/{y}, which is Web Mercator",
  );
  assert.equal(
    options.tilingScheme.ellipsoid,
    widget.scene.ellipsoid,
    "the tiling scheme is built on the declared shape, whose semi-major axis scales the projection",
  );
  reset();
}

// --- tiling: "geographic" states the other scheme ---
{
  const widget = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    ellipsoid: ODD,
    imagery: { url: "imagery/{z}/{x}/{y}.png", layout: "xyz", tiling: "geographic" },
  });
  const { tilingScheme } = built().options.baseLayer.provider.options;
  assert.equal(tilingScheme.constructor.name, "GeographicTilingScheme", "the declared scheme");
  assert.equal(tilingScheme.ellipsoid, widget.scene.ellipsoid, "on the declared shape as well");
  reset();
}

// --- imagery: false — no base layer at all, and a flat colour instead ---
{
  const widget = await createScene(makeContainer(), { baseUrl: "cesium/", imagery: false });
  assert.equal(built().options.baseLayer, false, "the widget is told to build no base layer");
  assert.equal(
    widget.scene.globe.baseColor,
    globalThis.__cesium.Color.DIMGRAY,
    "a bare globe wears one flat colour",
  );
  reset();
}

// --- lighting: the globe is lit from the sun only where the declaration asks for it ---
{
  const even = await createScene(makeContainer(), { baseUrl: "cesium/" });
  assert.equal(even.scene.globe.enableLighting, false, "an undeclared globe is evenly lit");
  const lit = await createScene(makeContainer(), { baseUrl: "cesium/", lighting: true });
  assert.equal(lit.scene.globe.enableLighting, true, "a declared globe carries a terminator");
  reset();
}

// --- stars: `false` builds no sky at all, and `undefined` is what asks Cesium for its own ---
{
  await createScene(makeContainer(), { baseUrl: "cesium/" });
  assert.equal(built().options.skyBox, false, "black behind an undeclared globe");
  await createScene(makeContainer(), { baseUrl: "cesium/", stars: true });
  assert.equal(built().options.skyBox, undefined, "the widget builds its own star field");
  assert.equal(built().options.skyAtmosphere, false, "the limb glow stays off either way");
  reset();
}

// --- a source that will not build: the bundled texture, loudly, and no credit for it ---
{
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const container = makeContainer();
  await createScene(container, {
    baseUrl: "cesium/",
    imagery: { url: "https://dead-host/tiles", layout: "tms", credit: "Somebody else's tiles" },
  });
  console.error = realError;
  assert.equal(errors.length, 1, "the reader is told once");
  assert.match(errors[0], /dead-host/, "the message names the URL that failed");
  assert.equal(
    built().options.baseLayer.provider,
    await loadImagery("cesium/"),
    "the globe draws the bundled texture rather than nothing",
  );
  assert.deepEqual(container.children, [], "the declared credit does not describe what is drawn");
  reset();
}

// --- a credit is text: a string that looks like markup appears as that string ---
{
  const container = makeContainer();
  const credit = '<script>alert("tiles")</script>';
  await createScene(container, {
    baseUrl: "cesium/",
    imagery: { url: "imagery/", layout: "tms", credit },
  });
  assert.equal(container.children.length, 1, "one line, appended to the viewer's container");
  const [el] = container.children;
  assert.equal(el.textContent, credit, "written with textContent, so it is never parsed as markup");
  assert.equal(el.innerHTML, undefined, "nothing sets innerHTML");
  assert.match(el.style.cssText, /pointer-events:none/, "it never takes a click meant for the globe");
  reset();
}

// --- no credit declared, no element ---
{
  const container = makeContainer();
  await createScene(container, { baseUrl: "cesium/", imagery: { url: "imagery/", layout: "tms" } });
  assert.deepEqual(container.children, [], "a source with no credit adds nothing to the container");
  reset();
}

// --- several viewers on one page: no two of them draw into a buffer of the same size ---
// Chrome can give two WebGL canvases of one size the same buffer from its GPU pool. The second
// viewer then shows the picture of the first. Each viewer therefore takes a size slot of its own.
{
  globalThis.__cesium.canvases.length = 0;
  const first = await createScene(makeContainer(), { baseUrl: "cesium/" });
  const second = await createScene(makeContainer(), { baseUrl: "cesium/" });
  const third = await createScene(makeContainer(), { baseUrl: "cesium/" });
  assert.equal(first.resolutionScale, 1, "a page with one viewer keeps its full resolution");
  const scales = [first, second, third].map((w) => w.resolutionScale);
  assert.equal(new Set(scales).size, 3, "three viewers, three buffer sizes");
  assert.ok(Math.min(...scales) > 0.99, "and each of them stays within one percent of what it asks for");

  // A notebook cell that runs again destroys its viewer and builds another. The slot of the
  // destroyed viewer must come back, or the resolution of the cell falls at each run.
  const destroyed = second.canvas;
  globalThis.__cesium.canvases = globalThis.__cesium.canvases.filter((c) => c !== destroyed);
  const replacement = await createScene(makeContainer(), { baseUrl: "cesium/" });
  assert.equal(
    replacement.resolutionScale,
    second.resolutionScale,
    "a viewer that is destroyed gives its slot back to the next viewer built",
  );
  assert.notEqual(replacement.resolutionScale, first.resolutionScale,
                  "and it does not take the slot of another viewer");
  reset();
}

// --- the slots are one whole pixel apart, on a canvas of any size ---
// A step below one pixel is no step at all: the canvas truncates the buffer to whole pixels, and two
// slots then land on one size. A small canvas is where a step of a fixed fraction fails.
{
  globalThis.__cesium.canvases.length = 0;
  globalThis.__cesium.canvasSize = { clientWidth: 100, clientHeight: 100 };
  const widgets = [];
  for (let i = 0; i < 3; i++) widgets.push(await createScene(makeContainer(), { baseUrl: "cesium/" }));
  const sizes = widgets.map((w) => Math.trunc(100 * w.resolutionScale));
  assert.deepEqual(sizes, [100, 99, 98], "each slot takes one more whole pixel off a 100 px canvas");
  globalThis.__cesium.canvasSize = { clientWidth: 900, clientHeight: 520 };
  reset();
}

// --- a backed entry draws two layers, an unbacked entry one ---
// The bundled texture goes below the declared source. Cesium walks a tile that will not load up to
// a ready ancestor, finds none, and draws the layer below, so the globe stays.
{
  const backed = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [{ url: "https://host/{z}/{y}/{x}.jpeg", layout: "xyz", maxLevel: 8, backing: true }],
  });
  assert.equal(backed.scene.imageryLayers.length, 2, "a backed entry puts two layers on the globe");
  assert.equal(
    backed.scene.imageryLayers.get(0).provider,
    await loadImagery("cesium/"),
    "the bundled texture is the bottom layer",
  );
  assert.equal(
    backed.scene.imageryLayers.get(1).provider.options.url,
    "https://host/{z}/{y}/{x}.jpeg",
    "the declared source draws above it",
  );

  const bare = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [{ url: "https://host/{z}/{y}/{x}.jpeg", layout: "xyz" }],
  });
  assert.equal(bare.scene.imageryLayers.length, 1, "an unbacked entry puts one layer on the globe");
  reset();
}

// --- a set of more than one: entry 0 is what the globe wears at startup ---
{
  const container = makeContainer();
  await createScene(container, {
    baseUrl: "cesium/",
    imagery: [
      { url: "imagery/", layout: "tms", name: "First", credit: "The first source" },
      { url: "https://host/{z}/{x}/{y}.png", layout: "xyz", name: "Second" },
    ],
  });
  assert.equal(built().options.baseLayer.provider.url, "imagery/", "entry 0 wears the globe");
  assert.equal(container.children[0].textContent, "The first source", "and entry 0 owns the credit");
  reset();
}

// --- the bundled entry carries no URL: the page builds the one it answers on ---
{
  const widget = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [{ url: "", layout: "tms", name: "Natural Earth", bundled: true }],
  });
  assert.equal(widget.scene.imageryLayers.length, 1, "the bundled entry is one layer");
  assert.equal(
    widget.scene.imageryLayers.get(0).provider,
    await loadImagery("cesium/"),
    "and that layer is the bundled texture",
  );
  reset();
}

// --- what the picker's creation function hands back: a list, read without waiting ---
// `ProviderViewModel` calls the function and asks `Array.isArray` of the answer, so a promise there
// is one layer built from a list of providers. Each element may be a promise, and the view model
// adds every one of them at index 0 and tracks the result as one unit — which is what makes a
// switch replace both layers of a backed entry rather than one.
{
  const backed = {
    url: "https://host/{z}/{y}/{x}.jpeg", layout: "xyz", maxLevel: 8, name: "Blue Marble",
    backing: true,
  };
  const providers = basemapProviders(backed, Ellipsoid.WGS84, "cesium/");
  assert.ok(Array.isArray(providers), "a list, not a promise of one");
  assert.equal(providers.length, 2, "a backed entry is two providers, tracked as one unit");
  assert.equal(await providers[0], await loadImagery("cesium/"), "the bundled texture is first");
  assert.equal((await providers[1]).options.url, backed.url, "the declared source is second");

  const bare = basemapProviders({ ...backed, backing: false }, Ellipsoid.WGS84, "cesium/");
  assert.equal(bare.length, 1, "an unbacked entry is one provider");

  const bundled = basemapProviders({ url: "", layout: "tms", bundled: true }, Ellipsoid.WGS84,
                                   "cesium/");
  assert.equal(bundled.length, 1, "the bundled entry is one provider");
  assert.equal(await bundled[0], await loadImagery("cesium/"), "and it is the bundled texture");
  reset();
}

// --- the declared set, as the picker reads it: one object is a set of one ---
{
  const one = { url: "imagery/", layout: "tms" };
  assert.deepEqual(basemapSet(one), [one], "one object is a set of one");
  assert.deepEqual(basemapSet([one, one]), [one, one], "a list travels as it stands");
  assert.deepEqual(basemapSet(false), [], "`false` declares no basemap to pick");
  assert.deepEqual(basemapSet(undefined), [], "and neither does an absent declaration");
}

console.log("scene: ok");
