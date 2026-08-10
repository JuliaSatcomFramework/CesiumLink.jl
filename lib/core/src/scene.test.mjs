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
    this.scene = {
      ellipsoid: options.ellipsoid ?? Ellipsoid.default,
      globe: { baseColor: null, enableLighting: false },
    };
    this.clock = {};
  }
}
globalThis.__cesium.Ellipsoid = Ellipsoid;
globalThis.__cesium.Color = Color;
`;

globalThis.__cesium = { fetched: [], built: [] };
// The DOM the builder touches: the detached div the Cesium credits are sent to, and the credit line
// a declared basemap adds. `textContent` is the only property the credit is allowed to write, so the
// stand-in element carries nothing else.
globalThis.document = { createElement: () => ({ style: {} }) };
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
const { createScene, loadImagery } = await import(
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

console.log("scene: ok");
