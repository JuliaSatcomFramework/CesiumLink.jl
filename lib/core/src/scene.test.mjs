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
export const Color = {
  DIMGRAY: "the flat colour of a bare globe",
  BLACK: { withAlpha: (a) => "black/" + a },
  WHITE: { withAlpha: (a) => "white/" + a },
  fromCssColorString: (css) => css,
};
export class Cartesian3 { static fromDegrees(lon, lat) { return { lon, lat }; } }
export const HeightReference = { NONE: "none", CLAMP_TO_GROUND: "clamped" };
export const SceneMode = { SCENE3D: "3d" };
export const HorizontalOrigin = { LEFT: "left", CENTER: "centre" };
export const VerticalOrigin = { CENTER: "centre" };
export const LabelStyle = { FILL_AND_OUTLINE: "fill and outline" };
export class PolylineOutlineMaterialProperty {
  constructor(options) { Object.assign(this, options); }
}
export const SceneTransforms = {
  // A plain equirectangular projection onto the canvas, which is enough to give every name a box.
  worldToWindowCoordinates: (scene, position) => ({
    x: (position.lon + 180) / 360 * scene.canvas.clientWidth,
    y: (90 - position.lat) / 180 * scene.canvas.clientHeight,
  }),
};
export class LabelCollection {
  constructor(options) { this.options = options; this.labels = []; this.show = true; }
  add(label) { this.labels.push(label); return label; }
  removeAll() { this.labels.length = 0; }
  get length() { return this.labels.length; }
}
export const GeoJsonDataSource = {
  load(source, options) {
    globalThis.__cesium.assets.push(typeof source === "string" ? source : "<features>");
    // entities.values is what the caller walks to give every line its dark edge.
    return Promise.resolve({
      url: source, options, show: true, features: source.features, entities: { values: [] },
    });
  },
};
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
      mode: "3d",
      renderError: { addEventListener() {} },
      imageryLayers: {
        add(layer) { layers.push(layer); },
        get(i) { return layers[i]; },
        get length() { return layers.length; },
      },
    };
    this.clock = {};
    // The annotation layers: a primitive collection and a data source list, plus the camera whose
    // movement repopulates the names.
    const listeners = (this.listeners = []);
    const event = () => ({ addEventListener: (fn) => listeners.push(fn) });
    this.camera = {
      percentageChanged: 0.5,
      changed: event(),
      moveEnd: event(),
      positionCartographic: { height: 2e7 },
      // Twenty thousand kilometres over 90 degrees east, 45 degrees north: straight above the one
      // name that this height carries, so the globe hides nothing the test asks for.
      positionWC: { x: 0, y: 1.865e7, z: 1.865e7 },
      computeViewRectangle: () => undefined,
    };
    this.primitives = [];
    this.scene.camera = this.camera;
    this.scene.canvas = this.canvas;
    this.scene.primitives = { add: (p) => (this.primitives.push(p), p) };
    this.dataSources = {
      sources: [],
      add(s) { this.sources.push(s); },
      remove(s) { this.sources.splice(this.sources.indexOf(s), 1); },
    };
  }
}
globalThis.__cesium.Ellipsoid = Ellipsoid;
globalThis.__cesium.Color = Color;
`;

globalThis.__cesium = { fetched: [], assets: [], built: [], canvases: [], canvasSize: { clientWidth: 900, clientHeight: 520 } };
// The parts of the DOM that the builder uses: the detached div that takes the Cesium credits, and
// the canvases that the page already holds. `canvases` is read on every call, because a document of
// an iframe holds its own list and a test replaces one.
const makeDocument = (canvases) => ({
  createElement: () => ({ style: {} }),
  querySelectorAll: (selector) => {
    const attribute = selector.match(/^canvas\[([\w-]+)\]$/)?.[1];
    assert.ok(attribute, `the stand-in answers "canvas[attribute]" and nothing else, not ${selector}`);
    return canvases().filter((c) => c.getAttribute(attribute) !== null);
  },
});
globalThis.document = makeDocument(() => globalThis.__cesium.canvases);
// The annotation names, which the builder fetches beside the Cesium tree. Two rows is enough to say
// which URL was asked for and that the collection was filled from what came back.
globalThis.__cesium.places = [
  { name: "ASIA", lon: 90, lat: 45, importance: 44580000, kind: "continent", minz: 0, maxz: 2 },
  { name: "Rome", lon: 12.48, lat: 41.9, importance: 3339000, kind: "capital", minz: 3, maxz: 99 },
];
globalThis.fetch = (url) => {
  globalThis.__cesium.assets.push(url);
  return Promise.resolve({ json: async () => globalThis.__cesium.places });
};
// The frame tree that the builder walks to find the viewers beside it. One page and no frames,
// until a test builds a tree. `top` of null means this window is the top one.
globalThis.window = { top: null, frames: [], document: globalThis.document };
/** The attribute that a viewer writes its size slot into. */
const VIEWER_MARK = "data-cesiumlink-viewer";
/** A container that records what the builder appends to it, and answers for its own children. */
const makeContainer = () => ({
  id: "app",
  children: [],
  appendChild(el) {
    el.parent = this;
    this.children.push(el);
  },
});

// The overlay owns the credit line and draws it (see overlay.test.mjs). What the builder decides is
// which string the line gets, so the stand-in records the calls and nothing else.
const makeOverlay = () => ({ credits: [], setCredit(credit) { this.credits.push(credit); } });

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
const { annotationsOf, basemapProviders, basemapSet, createScene, loadImagery } = await import(
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
  const widget = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(built().options.ellipsoid, undefined, "no ellipsoid is passed to the widget");
  assert.equal(widget.scene.ellipsoid, Ellipsoid.WGS84, "the scene is on Cesium's own default");
  assert.equal(Ellipsoid.default, Ellipsoid.WGS84, "the global default is left alone");
  reset();
}

// --- the imagery fetch is started once and joined, not repeated per scene ---
{
  const before = globalThis.__cesium.fetched.length;
  const started = loadImagery("cesium/");
  await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(globalThis.__cesium.fetched.length, before, "a started fetch is joined, not re-run");
  assert.equal(built().options.baseLayer.provider, await started, "the widget draws that fetch");
  reset();
}

// --- declared radii: the globe is built on them, and the default is set BEFORE it exists ---
{
  const widget = await createScene(makeContainer(), { baseUrl: "cesium/", ellipsoid: ODD }, makeOverlay());
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
    makeContainer(),
    { baseUrl: "cesium/", ellipsoid: declaration?.ellipsoid },
    makeOverlay(),
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
  }, makeOverlay());
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
  }, makeOverlay());
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
  }, makeOverlay());
  const { tilingScheme } = built().options.baseLayer.provider.options;
  assert.equal(tilingScheme.constructor.name, "GeographicTilingScheme", "the declared scheme");
  assert.equal(tilingScheme.ellipsoid, widget.scene.ellipsoid, "on the declared shape as well");
  reset();
}

// --- imagery: false — no base layer at all, and a flat colour instead ---
{
  const widget = await createScene(makeContainer(), { baseUrl: "cesium/", imagery: false }, makeOverlay());
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
  const even = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(even.scene.globe.enableLighting, false, "an undeclared globe is evenly lit");
  const lit = await createScene(makeContainer(), { baseUrl: "cesium/", lighting: true }, makeOverlay());
  assert.equal(lit.scene.globe.enableLighting, true, "a declared globe carries a terminator");
  reset();
}

// --- stars: `false` builds no sky at all, and `undefined` is what asks Cesium for its own ---
{
  await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(built().options.skyBox, false, "black behind an undeclared globe");
  await createScene(makeContainer(), { baseUrl: "cesium/", stars: true }, makeOverlay());
  assert.equal(built().options.skyBox, undefined, "the widget builds its own star field");
  assert.equal(built().options.skyAtmosphere, false, "the limb glow stays off either way");
  reset();
}

// --- a source that will not build: the bundled texture, loudly, and no credit for it ---
{
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const overlay = makeOverlay();
  await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: { url: "https://dead-host/tiles", layout: "tms", credit: "Somebody else's tiles" },
  }, overlay);
  console.error = realError;
  assert.equal(errors.length, 1, "the reader is told once");
  assert.match(errors[0], /dead-host/, "the message names the URL that failed");
  assert.equal(
    built().options.baseLayer.provider,
    await loadImagery("cesium/"),
    "the globe draws the bundled texture rather than nothing",
  );
  assert.deepEqual(overlay.credits, [undefined],
    "the declared credit does not describe what is drawn, so the line stays off");
  reset();
}

// --- the declared credit reaches the overlay whole: sanitizing it is the overlay's job ---
{
  const overlay = makeOverlay();
  const credit = '<script>alert("tiles")</script><a href="https://example.org/">Somebody</a>';
  await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: { url: "imagery/", layout: "tms", credit },
  }, overlay);
  assert.deepEqual(overlay.credits, [credit],
    "the declared string is handed over verbatim, script and anchor alike");
  reset();
}

// --- no credit declared, no element ---
{
  const overlay = makeOverlay();
  await createScene(makeContainer(),
    { baseUrl: "cesium/", imagery: { url: "imagery/", layout: "tms" } }, overlay);
  assert.deepEqual(overlay.credits, [undefined], "a source with no credit asks for no line");
  reset();
}

// --- a set of several: the globe starts on entry 0, so entry 0 is what the line names ---
{
  const overlay = makeOverlay();
  await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [
      { url: "https://gibs/{z}/{y}/{x}.jpeg", layout: "xyz", key: "blue_marble",
        credit: "NASA EOSDIS GIBS" },
      { url: "https://tile/{z}/{x}/{y}.png", layout: "xyz", credit: "Somebody else's tiles" },
      { url: "", layout: "xyz", key: "offline_natural_earth", bundled: true },
    ],
  }, overlay);
  assert.deepEqual(overlay.credits, ["NASA EOSDIS GIBS"],
    "the globe starts on entry 0, so entry 0 is what the line names");
  reset();
}

// --- several viewers on one page: no two of them draw into a buffer of the same size ---
// Chrome can give two WebGL canvases of one size the same buffer from its GPU pool. The second
// viewer then shows the picture of the first. Each viewer therefore takes a size slot of its own.
{
  globalThis.__cesium.canvases.length = 0;
  const first = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  const second = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  const third = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(first.resolutionScale, 1, "a page with one viewer keeps its full resolution");
  const scales = [first, second, third].map((w) => w.resolutionScale);
  assert.equal(new Set(scales).size, 3, "three viewers, three buffer sizes");
  assert.ok(Math.min(...scales) > 0.99, "and each of them stays within one percent of what it asks for");

  // A notebook cell that runs again destroys its viewer and builds another. The slot of the
  // destroyed viewer must come back, or the resolution of the cell falls at each run.
  const destroyed = second.canvas;
  globalThis.__cesium.canvases = globalThis.__cesium.canvases.filter((c) => c !== destroyed);
  const replacement = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(
    replacement.resolutionScale,
    second.resolutionScale,
    "a viewer that is destroyed gives its slot back to the next viewer built",
  );
  assert.notEqual(replacement.resolutionScale, first.resolutionScale,
                  "and it does not take the slot of another viewer");
  reset();
}

// --- two viewers in two iframes of one page ---
// The buffer pool belongs to the browser and not to a document, so two players embedded in one page
// collide exactly as two viewers in one document do. The builder therefore reads the marks of every
// same-origin frame, and not only of its own document.
{
  globalThis.__cesium.canvases.length = 0;
  // The frame beside this one already holds slot 0, which is all this one can see of it.
  const sibling = [{ getAttribute: (name) => (name === VIEWER_MARK ? "0" : null) }];
  const siblingWindow = { frames: [], document: makeDocument(() => sibling) };
  globalThis.window.top = {
    frames: [globalThis.window, siblingWindow],
    document: makeDocument(() => []),
  };
  const embedded = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.notEqual(embedded.resolutionScale, 1,
                  "a viewer whose sibling frame holds slot 0 does not take slot 0 as well");

  // A frame of another origin throws on `.document`. It is stepped over, and the walk goes on.
  globalThis.__cesium.canvases.length = 0;
  globalThis.window.top = {
    frames: [{ get document() { throw new Error("cross-origin"); }, frames: [] },
             globalThis.window, siblingWindow],
    document: makeDocument(() => []),
  };
  const past = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  assert.equal(past.resolutionScale, embedded.resolutionScale,
               "and a frame of another origin costs the walk nothing but itself");
  globalThis.window.top = null;
  reset();
}

// --- the slots are one whole pixel apart, on a canvas of any size ---
// A step below one pixel is no step at all: the canvas truncates the buffer to whole pixels, and two
// slots then land on one size. A small canvas is where a step of a fixed fraction fails.
{
  globalThis.__cesium.canvases.length = 0;
  globalThis.__cesium.canvasSize = { clientWidth: 100, clientHeight: 100 };
  const widgets = [];
  for (let i = 0; i < 3; i++) widgets.push(await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay()));
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
  }, makeOverlay());
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
  }, makeOverlay());
  assert.equal(bare.scene.imageryLayers.length, 1, "an unbacked entry puts one layer on the globe");
  reset();
}

// --- a set of more than one: entry 0 is what the globe wears at startup ---
{
  const overlay = makeOverlay();
  await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [
      { url: "imagery/", layout: "tms", name: "First", credit: "The first source" },
      { url: "https://host/{z}/{x}/{y}.png", layout: "xyz", name: "Second" },
    ],
  }, overlay);
  assert.equal(built().options.baseLayer.provider.url, "imagery/", "entry 0 wears the globe");
  assert.deepEqual(overlay.credits, ["The first source"], "and entry 0 owns the credit");
  reset();
}

// --- the bundled entry carries no URL: the page builds the one it answers on ---
{
  const widget = await createScene(makeContainer(), {
    baseUrl: "cesium/",
    imagery: [{ url: "", layout: "tms", name: "Natural Earth", bundled: true }],
  }, makeOverlay());
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

// --- a source that will not build falls back where the providers are built, not above them ---
// The picker calls `basemapProviders` itself, so a fallback that lived in the scene builder alone
// would leave a picked entry drawing a bare globe (ADR-0020).
{
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  let fellBack = 0;
  const dead = basemapProviders({ url: "https://dead-host/tiles", layout: "tms" },
                                Ellipsoid.WGS84, "cesium/", () => fellBack++);
  const [only] = await Promise.all(dead);
  console.error = realError;
  assert.equal(only, await loadImagery("cesium/"),
               "the entry draws the bundled texture rather than nothing");
  assert.equal(fellBack, 1, "the caller hears it once, so the credit it wrote can come down");
  assert.equal(errors.length, 1, "and the reader is told once");
  assert.match(errors[0], /dead-host/, "by a message that names the URL that failed");
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

// --- the annotation layers go on above the base, and are not basemaps ---
// The picker removes only the base layers it counted from the entry on the globe, so a layer that
// is not an imagery layer at all cannot be taken off by a switch (ADR-0036).
{
  globalThis.__cesium.assets.length = 0;
  const widget = await createScene(makeContainer(), { baseUrl: "cesium/" }, makeOverlay());
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(globalThis.__cesium.assets.includes("annotations/named-places.json"),
            "the names are fetched beside the Cesium tree, not inside it");
  assert.ok(globalThis.__cesium.assets.includes("annotations/country-borders.geojson"),
            "and so are the boundaries");
  assert.equal(widget.scene.imageryLayers.length, 1, "the globe still wears one base layer");
  assert.equal(widget.primitives.length, 1, "the names are a primitive collection");
  assert.equal(widget.dataSources.sources.length, 1, "the boundaries are a data source");
  assert.equal(widget.primitives[0].length, 1,
               "and the collection holds only what this camera height carries");
  assert.equal(widget.camera.percentageChanged, 0.1,
               "the camera reports movement four times as finely as Cesium's own default");
  assert.equal(widget.listeners.length, 2, "on `changed` as well as on `moveEnd`");
  reset();
}

// --- the two flags, each taking one layer off and leaving the other drawn (ADR-0036) ---
{
  const off = await createScene(makeContainer(),
                                { baseUrl: "cesium/", namedPlaces: false }, makeOverlay());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(off.primitives[0].length, 0,
               "a session that declares no place names holds none: the pass is what costs, so a " +
               "hidden label is not enough");
  assert.equal(off.dataSources.sources[0].show, true, "and the borders are still drawn");
  reset();

  const bare = await createScene(makeContainer(),
                                 { baseUrl: "cesium/", countryBorders: false }, makeOverlay());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bare.dataSources.sources[0].show, false, "the borders come off on their own");
  assert.equal(bare.primitives[0].length, 1, "and the names stay");
  reset();
}

// --- each layer still switches on its own once the globe is built (ADR-0036) ---
{
  const held = await createScene(makeContainer(), { baseUrl: "cesium/", countryBorders: false },
                                 makeOverlay());
  await new Promise((r) => setTimeout(r, 0));
  const layers = annotationsOf(held);
  assert.equal(held.dataSources.sources[0].show, false, "the borders start off, as declared");
  layers.showBorders(true);
  assert.equal(held.dataSources.sources[0].show, true, "and the switch brings them back");
  layers.showPlaces(false);
  assert.equal(held.primitives[0].length, 0, "while the names come off on their own");
  reset();
}

console.log("scene: ok");
