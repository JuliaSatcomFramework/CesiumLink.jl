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
import { addAnnotations } from "./annotations";
import type { Overlay } from "./overlay";

/**
 * One basemap of the declared set. A server that mounts a directory decides `layout` by what the
 * directory holds; a page told a URL in its own address reads it off the shape of that URL. The scene itself sniffs nothing. A TMS source reads its own tiling scheme and depth
 * from `tilemapresource.xml`, so `tiling` and `maxLevel` belong to an XYZ source only.
 */
export interface ImagerySpec {
  /**
   * Where the tiles are: relative to the page, or absolute. The bundled entry carries none — the
   * page builds the URL it answers on from `baseUrl`, and only the page knows that value.
   */
  url?: string;
  /**
   * `"tms"` for a `tilemapresource.xml` pyramid, `"xyz"` for a `{z}/{x}/{y}` template. Absent on
   * the bundled entry, which names no URL to lay out.
   */
  layout?: "tms" | "xyz";
  /** XYZ only. `"mercator"` is what `{z}/{x}/{y}` means on the web, and is the default. */
  tiling?: "geographic" | "mercator";
  /** XYZ only. The deepest level the source holds. Absent means Cesium asks for any level. */
  maxLevel?: number;
  /**
   * An attribution line. The string is HTML, because a linked attribution is what a tile source
   * asks for, and the viewer draws it as markup. It comes from whoever started the server, so
   * `overlay.setCredit` passes it through `DOMPurify.sanitize` first and draws only what comes
   * back.
   */
  credit?: string;
  /** The label the picker draws for this basemap. A set of one draws no picker and needs no name. */
  name?: string;
  /**
   * Which catalogue basemap this is, as the server's own key: `"blue_marble"`, `"blue_marble_relief"`. The picker
   * draws its icon and its drop-down category from this, so renaming a label changes nothing. A
   * basemap an author declared themselves carries none, and the picker falls back.
   */
  key?: string;
  /**
   * Draw the bundled Earth texture below this source. Cesium walks a tile that will not load up to
   * a ready ancestor, finds none, and draws the layer below, so a source that stops answering
   * leaves a globe rather than a hole. It is a property of this basemap and not a second basemap:
   * it carries no alpha, no order and no name of its own.
   */
  backing?: boolean;
  /**
   * This entry is the bundled Earth texture itself. It carries no `url`, because the one it answers
   * on is built from `baseUrl`, and only the page knows that.
   */
  bundled?: boolean;
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
   * - a list — that set of tile sources. Entry 0 is what the globe wears at startup, and the
   *   reader picks within the set.
   */
  imagery?: false | ImagerySpec | ImagerySpec[];
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
  /**
   * Draw the place names over the globe — continents, oceans and seas, countries and their larger
   * cities. Absent draws them, so this option states only the departure from the default.
   */
  namedPlaces?: boolean;
  /**
   * Draw the boundary lines between countries. Absent draws them. It is separate from
   * `namedPlaces` because a border is a political claim, and a reader may want the names without
   * one (ADR-0036).
   */
  countryBorders?: boolean;
}

// The imagery fetch, kept so it can be started before the globe's shape is known and awaited once
// it is. The texture is a flat NaturalEarthII image reprojected onto whatever ellipsoid the widget
// is given, so nothing about it depends on that shape.
//
// The map key is the base URL, because a page can hold more than one viewer, and two viewers can
// read from two different trees. Two viewers on one base URL share the provider. That is safe:
// `ImageryLayer` only reads a provider, and each viewer builds a layer of its own.
const imagery = new Map<string, Promise<ImageryProvider>>();

/**
 * Start (or join) the fetch of the offline imagery `createScene` draws the globe with. Calling this
 * as the page loads overlaps the fetch with whatever else the host is waiting for.
 */
export function loadImagery(baseUrl: string): Promise<ImageryProvider> {
  const base = useBaseUrl(baseUrl);
  let fetching = imagery.get(base);
  if (fetching === undefined) {
    fetching = TileMapServiceImageryProvider.fromUrl(base + "/Assets/Textures/NaturalEarthII");
    imagery.set(base, fetching);
  }
  return fetching;
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
 * The declared basemaps, in the order the wire states them. One object is a set of one, and
 * `false` or an absent declaration is a set of none.
 */
export function basemapSet(imagery: SceneOptions["imagery"]): ImagerySpec[] {
  if (!imagery) return [];
  return Array.isArray(imagery) ? imagery : [imagery];
}

/**
 * The providers one basemap draws with, bottom first. A backed entry gives two: the bundled Earth
 * texture below and the declared source above. Cesium walks a tile that will not load up to a ready
 * ancestor, finds none, and draws the layer below, so a source that stops answering leaves a globe.
 *
 * The list is an array of promises and not a promise of an array, because the picker reads it
 * synchronously: `ProviderViewModel` calls its creation function and asks `Array.isArray` of the
 * answer, and a promise there is one layer built from a list. The list is handed on whole. The
 * picker adds every provider of it at index 0 and tracks them as one unit, so a switch replaces
 * both layers of a backed entry together.
 *
 * A source that will not build gives the bundled Earth texture in its place, and one loud message:
 * the scene is the point and the texture is decoration, so a globe wearing the wrong face beats a
 * page that draws nothing (ADR-0020). The fallback lives here rather than in the caller because the
 * picker builds its own layers and must fall back the same way. `onFallback` is how a caller hears
 * that it happened; it runs before the list settles, and a credit that names the declared source
 * has to come down when it does. A backed entry then holds the bundled texture twice, which draws
 * as one texture.
 *
 * Only `TileMapServiceImageryProvider.fromUrl` and the bundled fetch can reach the catch.
 * `UrlTemplateImageryProvider` constructs synchronously and never throws, so an XYZ source at a dead
 * host gives blank tiles and one console error per tile, and no fallback at all.
 */
export function basemapProviders(
  spec: ImagerySpec,
  ellipsoid: Ellipsoid,
  baseUrl: string,
  onFallback?: () => void,
): Promise<ImageryProvider>[] {
  if (spec.bundled) return [loadImagery(baseUrl)];
  const built = (async () => buildProvider(spec, ellipsoid))();
  const declared = built.catch((err) => {
    console.error(
      `CesiumLink: the declared basemap at ${spec.url} did not build (${err}). ` +
        `The globe below wears the bundled Earth texture, which is not what this scene declared.`,
    );
    onFallback?.();
    return loadImagery(baseUrl);
  });
  return spec.backing ? [loadImagery(baseUrl), declared] : [declared];
}

/**
 * The base layers the declaration asks for, bottom first, and whether the globe wears what the
 * scene declared. `declared` is false when a source fell back to the bundled texture, and false
 * again when nothing was declared at all: either way the declared credit describes no layer here.
 */
async function buildBaseLayers(
  opts: SceneOptions,
  ellipsoid: Ellipsoid,
): Promise<{ layers: ImageryLayer[] | false; declared: boolean }> {
  if (opts.imagery === false) return { layers: false, declared: true };
  const [first] = basemapSet(opts.imagery);
  if (!first) {
    return { layers: [new ImageryLayer(await loadImagery(opts.baseUrl))], declared: false };
  }
  let declared = true;
  const providers = basemapProviders(first, ellipsoid, opts.baseUrl, () => {
    declared = false;
  });
  return { layers: (await Promise.all(providers)).map((p) => new ImageryLayer(p)), declared };
}

function buildProvider(
  spec: ImagerySpec,
  ellipsoid: Ellipsoid,
): ImageryProvider | Promise<ImageryProvider> {
  // Only the bundled entry declares no URL, and `basemapProviders` answers that one before it gets
  // here. A spec that reaches this line without one is a declaration the server should not have
  // written, so it is thrown rather than built into a provider that asks for `undefined`.
  if (spec.url === undefined) {
    throw new Error("a declared basemap that is not the bundled one names where its tiles are");
  }
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

/** The mark that this module puts on a canvas it builds. The value is the size slot that the viewer
 * holds, so that no other viewer takes the same slot. */
const VIEWER_MARK = "data-cesiumlink-viewer";

/**
 * Give this viewer a drawing buffer of a size that no other viewer on the page uses.
 *
 * Chrome draws a WebGL canvas into a GPU buffer from a pool. The key of that pool is the size of the
 * buffer. Two viewers of the same size thus draw from one bucket, and the compositor can give one
 * viewer a buffer that the other viewer just drew into. The second viewer then shows the picture of
 * the first, for one frame at a time. Measured on ANGLE/Direct3D11 with two canvases of 913x520
 * pixels. `preserveDrawingBuffer` does not stop this, but a difference in size does.
 *
 * The step is one pixel of the shorter side of the canvas, because the pool key is the buffer size
 * in whole pixels, and the canvas truncates that size. A step below one pixel can put two slots on
 * one size. The cost is that a later viewer draws a few pixels below the resolution that it asks
 * for, and a reader cannot see that difference. A canvas that becomes much smaller after the build
 * keeps its scale, and two slots can then meet again on one size.
 *
 * Each viewer takes the lowest slot that no live viewer holds, and writes the slot on its own
 * canvas. This reads the slots from the page and does not count them, so a viewer that is destroyed
 * gives its slot back. A notebook cell that runs again must take the slot of its own last viewer,
 * and not the slot of the viewer beside it.
 */
function separateDrawingBuffer(widget: CesiumWidget): void {
  const taken = new Set(
    reachableDocuments()
      .flatMap((doc) => [...doc.querySelectorAll(`canvas[${VIEWER_MARK}]`)])
      .map((c) => c.getAttribute(VIEWER_MARK)),
  );
  let slot = 0;
  while (taken.has(String(slot))) slot++;
  widget.canvas.setAttribute(VIEWER_MARK, String(slot));
  if (slot === 0) return; // Slot 0 keeps the resolution it asks for, so one viewer alone pays nothing.
  // A canvas with no layout yet reports 0. The side to fall back on is then 500 pixels.
  const side = Math.min(widget.canvas.clientWidth, widget.canvas.clientHeight) || 500;
  widget.resolutionScale = Math.max(0.5, 1 - slot / side);
}

/**
 * Every document whose marks this viewer may read: its own, and each same-origin document of the
 * window tree around it.
 *
 * The pool that hands out those buffers belongs to the browser and not to a document, so two
 * viewers in two iframes collide exactly as two viewers in one page do. A viewer that reads its own
 * document alone finds no mark, so both take slot 0 and both draw at one size. A documentation page
 * that embeds two players is where this happens.
 *
 * A frame of another origin throws on `.document`, and this steps over it. Two viewers on opposite
 * sides of that boundary cannot see each other, and nothing here can repair it.
 */
function reachableDocuments(): Document[] {
  const out: Document[] = [];
  const visit = (w: Window): void => {
    let doc: Document;
    try {
      doc = w.document;
    } catch {
      return;
    }
    out.push(doc);
    for (let i = 0; i < w.frames.length; i++) visit(w.frames[i]);
  };
  visit(window.top ?? window);
  if (!out.includes(document)) out.push(document);
  return out;
}

/**
 * A trimmed CesiumWidget on the declared imagery, or the offline NaturalEarthII texture: no ion
 * token, no skybox/atmosphere, ellipsoid terrain (the default). Fully offline, strict-CSP friendly.
 */
export async function createScene(
  container: HTMLElement,
  opts: SceneOptions,
  overlay: Pick<Overlay, "setCredit">,
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
  const { layers, declared } = await buildBaseLayers(opts, ellipsoid ?? Ellipsoid.default);

  // Detached container swallows the ion/Cesium credit chrome. It stays hidden, because showing it
  // brings the Cesium branding credit back with it; the basemap attribution is the overlay's line.
  const credits = document.createElement("div");
  credits.style.display = "none";

  const widget = new CesiumWidget(container, {
    baseLayer: layers === false ? false : layers[0],
    ellipsoid,
    // `undefined` is what asks for the default star field, and it brings the sun and the moon with
    // it. The blue limb glow is a separate thing and stays off, for the reason the ground
    // atmosphere does: it is haze over what the scene draws.
    skyBox: opts.stars ? undefined : false,
    skyAtmosphere: false,
    creditContainer: credits,
  });
  separateDrawingBuffer(widget);
  if (layers === false) widget.scene.globe.baseColor = BARE_GLOBE_COLOR;
  // A backed basemap is two layers. The widget takes the bottom one, and the rest go above it in
  // the order the list states.
  else for (const layer of layers.slice(1)) widget.scene.imageryLayers.add(layer);
  // No haze over the globe, for the reason there is no skybox and no sky atmosphere: what the
  // basemap and the scene are coloured is what the reader must see. Cesium's ground atmosphere
  // draws a blue wash over the whole disc, which lightens a dark basemap into grey and shifts every
  // colour drawn on the surface towards blue.
  widget.scene.globe.showGroundAtmosphere = false;
  // Place names and country borders, above the base and owned by the session rather than by the
  // pick. The picker removes only the base layers it counted, so these survive a switch (ADR-0036).
  addAnnotations(widget, opts.baseUrl, { places: opts.namedPlaces, borders: opts.countryBorders });
  // The sun's position comes from the clock, which the window playback drives, so the terminator
  // stands where the scene's own time puts it.
  if (opts.lighting) widget.scene.globe.enableLighting = true;
  // The credit describes the source the globe wears, so it names entry 0 and never the backing. The
  // bundled texture is public domain, so a globe that shows it under a dead source is not
  // under-credited. A fallback draws that texture in place of the source, which the declared credit
  // does not cover, so there the line stays off.
  const startsOn = basemapSet(opts.imagery)[0];
  overlay.setCredit(declared ? startsOn?.credit : undefined);
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
