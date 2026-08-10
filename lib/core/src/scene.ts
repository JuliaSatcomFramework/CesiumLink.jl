import {
  CesiumWidget,
  Color,
  Ellipsoid,
  GeographicTilingScheme,
  Ion,
  ImageryLayer,
  type ImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from "@cesium/engine";

/**
 * One tile source for the globe's single base layer. A server that mounts a directory decides
 * `layout` by what the directory holds; a page told a URL in its own address reads it off the shape
 * of that URL. The scene itself sniffs nothing. A TMS source reads its own tiling scheme and depth
 * from `tilemapresource.xml`, so `tiling` and `maxLevel` belong to an XYZ source only.
 */
export interface ImagerySpec {
  /** Where the tiles are: relative to the page, or absolute. */
  url: string;
  /** `"tms"` for a `tilemapresource.xml` pyramid, `"xyz"` for a `{z}/{x}/{y}` template. */
  layout: "tms" | "xyz";
  /** XYZ only. `"mercator"` is what `{z}/{x}/{y}` means on the web, and is the default. */
  tiling?: "geographic" | "mercator";
  /** XYZ only. The deepest level the source holds. Absent means Cesium asks for any level. */
  maxLevel?: number;
  /** An attribution line. It is user text and the viewer renders it as text, never as markup. */
  credit?: string;
}

export interface SceneOptions {
  /** CESIUM_BASE_URL — where the offline Assets/Workers tree is served, e.g. "cesium/". */
  baseUrl: string;
  /**
   * The shape the globe is built on: semi-major and semi-minor axes in metres. Absent leaves
   * Cesium's WGS84 default in place.
   */
  ellipsoid?: { a: number; b: number };
  /**
   * What the globe is textured with. The three states differ, and absent is not `false`:
   *
   * - absent — the bundled NaturalEarthII texture under `baseUrl`.
   * - `false` — no base layer at all: a globe of one flat colour.
   * - an object — that tile source, with the bundled texture as the fallback if it fails to build.
   */
  imagery?: false | ImagerySpec;
  /**
   * Light the globe from the sun at the clock's time, so a terminator runs across it and the night
   * side goes dark. Absent lights the globe evenly, which is what a scene whose colours carry the
   * data wants: a shaded globe dims them by where they sit rather than by what they say.
   */
  lighting?: boolean;
  /**
   * Draw the sky around the globe: the star field, the sun and the moon, at the clock's time. Absent
   * leaves black behind the globe, which is what a scene about the surface wants. Cesium draws its
   * own stars only on a WGS84 globe, so a session on another body gets black whatever this says.
   */
  stars?: boolean;
}

// The one imagery fetch, kept so it can be started before the globe's shape is known and awaited
// once it is. The texture is a flat NaturalEarthII image reprojected onto whatever ellipsoid the
// widget is given, so nothing about it depends on that shape.
// One page, one baseUrl — a second baseUrl would get the first one's fetch.
let imagery: Promise<ImageryProvider> | null = null;

/**
 * Start (or join) the fetch of the offline imagery `createScene` draws the globe with. Calling this
 * as the page loads overlaps the fetch with whatever else the host is waiting for.
 */
export function loadImagery(baseUrl: string): Promise<ImageryProvider> {
  const base = useBaseUrl(baseUrl);
  return (imagery ??= TileMapServiceImageryProvider.fromUrl(
    base + "/Assets/Textures/NaturalEarthII",
  ));
}

/**
 * Point Cesium at the offline asset tree and take the ion token away. A scene on a declared basemap
 * never touches the bundled texture, so this cannot live in the fetch alone: Cesium loads its
 * workers and its own assets from `CESIUM_BASE_URL` whatever the globe wears. Returns the base with
 * no trailing slash.
 */
function useBaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  (globalThis as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = base + "/";
  Ion.defaultAccessToken = "";
  return base;
}

/**
 * The base layer the declaration asks for. A source that will not build gives the bundled texture
 * and a loud message: the scene is the point and the texture is decoration, so a globe wearing the
 * wrong face beats a page that draws nothing (ADR-0020).
 *
 * Only `TileMapServiceImageryProvider.fromUrl` and the bundled fetch can reach the catch.
 * `UrlTemplateImageryProvider` constructs synchronously and never throws, so an XYZ source at a dead
 * host gives blank tiles and one console error per tile, and no fallback at all.
 */
async function buildBaseLayer(
  opts: SceneOptions,
  ellipsoid: Ellipsoid,
): Promise<{ layer: ImageryLayer | false; declared: boolean }> {
  if (opts.imagery === false) return { layer: false, declared: true };
  if (opts.imagery) {
    try {
      const provider = await buildProvider(opts.imagery, ellipsoid);
      return { layer: new ImageryLayer(provider), declared: true };
    } catch (err) {
      console.error(
        `CesiumLink: the declared basemap at ${opts.imagery.url} did not build (${err}). ` +
          `The globe below wears the bundled Earth texture, which is not what this scene declared.`,
      );
    }
  }
  return { layer: new ImageryLayer(await loadImagery(opts.baseUrl)), declared: false };
}

function buildProvider(
  spec: ImagerySpec,
  ellipsoid: Ellipsoid,
): ImageryProvider | Promise<ImageryProvider> {
  if (spec.layout === "tms") {
    // The pyramid states its own tiling scheme and depth in `tilemapresource.xml`.
    return TileMapServiceImageryProvider.fromUrl(spec.url, { ellipsoid });
  }
  const tilingScheme = spec.tiling === "geographic"
    ? new GeographicTilingScheme({ ellipsoid })
    : new WebMercatorTilingScheme({ ellipsoid });
  return new UrlTemplateImageryProvider({
    url: spec.url,
    tilingScheme,
    maximumLevel: spec.maxLevel,
  });
}

/** The colour of a globe with no base layer, which `imagery: false` asks for. */
const BARE_GLOBE_COLOR = Color.DIMGRAY;

/**
 * A trimmed CesiumWidget on the declared imagery, or the offline NaturalEarthII texture: no ion
 * token, no skybox/atmosphere, ellipsoid terrain (the default). Fully offline, strict-CSP friendly.
 */
export async function createScene(
  container: HTMLElement,
  opts: SceneOptions,
): Promise<CesiumWidget> {
  // Before anything is constructed: `Ellipsoid.default` is what every conversion helper that was
  // not handed an ellipsoid reads — `Cartesian3.fromDegrees` in a module decoding a payload above
  // all — so the globe and the coordinates drawn on it are the same shape only if it is set first.
  // A tiling scheme reads it too, and a Web Mercator projection scales by the semi-major axis, so
  // a provider built before this line puts Earth's metres on another body's globe.
  let ellipsoid: Ellipsoid | undefined;
  if (opts.ellipsoid) {
    ellipsoid = new Ellipsoid(opts.ellipsoid.a, opts.ellipsoid.a, opts.ellipsoid.b);
    Ellipsoid.default = ellipsoid;
  }

  useBaseUrl(opts.baseUrl);
  const { layer: baseLayer, declared } = await buildBaseLayer(opts, ellipsoid ?? Ellipsoid.default);

  // Detached container swallows the ion/Cesium credit chrome.
  const credits = document.createElement("div");
  credits.style.display = "none";

  const widget = new CesiumWidget(container, {
    baseLayer,
    ellipsoid,
    // `undefined` is what asks for the default star field, and it brings the sun and the moon with
    // it. The blue limb glow is a separate thing and stays off, for the reason the ground
    // atmosphere does: it is haze over what the scene draws.
    skyBox: opts.stars ? undefined : false,
    skyAtmosphere: false,
    creditContainer: credits,
  });
  if (baseLayer === false) widget.scene.globe.baseColor = BARE_GLOBE_COLOR;
  // No haze over the globe, for the reason there is no skybox and no sky atmosphere: what the
  // basemap and the scene are coloured is what the reader must see. Cesium's ground atmosphere
  // draws a blue wash over the whole disc, which lightens a dark basemap into grey and shifts every
  // colour drawn on the surface towards blue.
  widget.scene.globe.showGroundAtmosphere = false;
  // The sun's position comes from the clock, which the window playback drives, so the terminator
  // stands where the scene's own time puts it.
  if (opts.lighting) widget.scene.globe.enableLighting = true;
  // The credit describes the declared source. A fallback draws the bundled texture instead, which
  // that credit does not cover, so it stays off.
  if (declared && opts.imagery && opts.imagery.credit) addCredit(container, opts.imagery.credit);
  // `clock.canAnimate` belongs to the playback in `windows.ts`, which clears it to hold the clock over
  // frames the buffer does not reach. CesiumWidget otherwise rewrites that flag on every tick from
  // whether its DataSourceDisplay is up to date, which would erase the hold. The `models` module
  // does draw through that display: a glTF model is an entity in `viewer.entities`. What taking the
  // flag back costs is that the clock no longer waits for a model file to load — the scene runs and
  // the model appears when it arrives, which is what the playback hold exists to protect.
  widget.allowDataSourcesToSuspendAnimation = false;
  // Software-WebGL guard: a software rasterizer means single-digit FPS (see design notes).
  warnIfSoftwareRenderer(widget);
  return widget;
}

/**
 * The attribution line for a declared basemap: bottom right, and transparent to the pointer so it
 * never takes a click meant for the globe. Cesium's own credit container stays hidden, because
 * showing it brings the Cesium branding credit back with it.
 */
function addCredit(container: HTMLElement, credit: string): void {
  const el = document.createElement("div");
  // `textContent`, never `innerHTML`: the string comes from whoever started the server.
  el.textContent = credit;
  // 34px up, which is the band the Core's clock readout and ruler hold along the bottom edge — the
  // same inset the overlay's own bottom-right region starts at.
  el.style.cssText =
    "position:absolute;right:8px;bottom:34px;z-index:5;pointer-events:none;" +
    "font:11px/1.4 sans-serif;color:#fff;text-shadow:0 0 3px #000";
  container.appendChild(el);
}

function warnIfSoftwareRenderer(widget: CesiumWidget): void {
  try {
    // scene.context is internal; reach its live WebGL context for the renderer string.
    const ctx = (widget.scene as unknown as { context: { _gl: WebGLRenderingContext } })
      .context._gl;
    const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
    const r = dbg ? String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software/i.test(r)) {
      console.warn(`CesiumLink: software WebGL renderer (${r}) — expect low FPS. ` +
        `Enable hardware acceleration in the client.`);
    }
  } catch {
    /* renderer string unavailable — skip the guard */
  }
}
