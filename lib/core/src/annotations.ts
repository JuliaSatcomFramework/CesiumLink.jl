// Place names and country borders, drawn above whatever basemap the reader picked.
//
// Neither is a basemap. The session owns them, the Core adds them once, and the picker never
// touches them: it removes only the base layers it counted from the entry on the globe, so a layer
// added above survives a switch (ADR-0036).
//
// The names and the country borders are independent, and either may be off while the other is on.

import {
  Cartesian3,
  type CesiumWidget,
  Color,
  GeoJsonDataSource,
  HeightReference,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  type Rectangle,
  SceneMode,
  SceneTransforms,
  VerticalOrigin,
} from "@cesium/engine";

/** One row of `named-places.json`, as the generator writes it. */
export interface NamedPlace {
  name: string;
  /** Degrees. */
  lon: number;
  lat: number;
  /**
   * Population for a city, a capital and a country; area for a continent, an ocean and a sea. It
   * ranks within a kind and is only roughly comparable across kinds.
   */
  importance: number;
  kind: "continent" | "ocean" | "sea" | "country" | "city" | "capital";
  /** The geographic levels this name belongs to, inclusive. */
  minz: number;
  maxz: number;
}

/** The two layers, each switchable. */
export interface Annotations {
  /** Whether the place names are drawn: what the session declared, until something switches it. */
  readonly places: boolean;
  /** Whether the country borders are drawn. */
  readonly borders: boolean;
  /** Draw the place names, or take them off. */
  showPlaces(on: boolean): void;
  /** Draw the country borders, or take them off. */
  showBorders(on: boolean): void;
}

/**
 * Which of the two layers the session asked for.
 *
 * Both are drawn when absent, so each flag states only a departure from the default.
 */
export interface AnnotationFlags {
  places?: boolean;
  borders?: boolean;
}

// The handle for a viewer, so that whatever puts the flags on the wire can reach the layers
// without every caller of `createScene` having to carry them.
const attached = new WeakMap<CesiumWidget, Annotations>();

/** The annotation layers of a viewer, or `undefined` for one built without them. */
export function annotationsOf(widget: CesiumWidget): Annotations | undefined {
  return attached.get(widget);
}

/**
 * How many names the collection may hold at once.
 *
 * A `LabelCollection` builds one billboard per glyph, so the whole pool of 7,897 names is about
 * 280,000 billboards and the median frame goes to seconds. `distanceDisplayCondition` hides a
 * label; it does not stop Cesium paying for it. The collection therefore holds only what the
 * camera can see, and a rebuild costs about 3 ms.
 */
const ON_SCREEN = 400;

/**
 * How much of the view must alter before `camera.changed` fires. Cesium's own default is 0.5 —
 * half the view — which is far too coarse: over a five second flight from 14,000 km to 200 km it
 * leaves the names a level or more behind for most of the way down. Finer than 0.1 buys nothing.
 */
const CAMERA_STEP = 0.1;

/** The camera height, in metres, at which a geographic level is the legible one. */
const LEVEL_HEIGHT = 4e7;

/**
 * How a country line is drawn: white at just over half strength, two pixels wide.
 *
 * Strong enough to read over a photograph and a drawn relief map alike, and faint enough that a
 * whole-globe view is a globe with borders rather than a net with a globe behind it. No dark edge:
 * an edge makes a line legible at any width by making it heavier, and heavier is the fault.
 */
const COUNTRY_LINE = Color.WHITE.withAlpha(0.55);
const COUNTRY_LINE_WIDTH = 2;

/** How each kind of name is drawn. A `dot` kind hangs its text to the right of its position. */
const STYLE: Record<NamedPlace["kind"], { font: string; fill: string; dot: boolean }> = {
  ocean: { font: "italic bold 15px sans-serif", fill: "#d7ebff", dot: false },
  continent: { font: "bold 19px sans-serif", fill: "#ffffff", dot: false },
  sea: { font: "italic 12px sans-serif", fill: "#c8e1fa", dot: false },
  country: { font: "bold 13px sans-serif", fill: "#ffffff", dot: false },
  capital: { font: "bold 12px sans-serif", fill: "#fff5d2", dot: true },
  city: { font: "11px sans-serif", fill: "#f0f0f0", dot: true },
};

/**
 * Where the annotation files are, given the base the host serves the Cesium runtime tree from.
 *
 * `baseUrl` ends in `cesium/` — a browser page passes the relative `"cesium/"`, a webview passes an
 * absolute URI ending the same way — and the annotation files sit beside that directory rather than
 * inside it. So the last segment comes off and `annotations/` goes on, which leaves a relative base
 * relative and an absolute one absolute.
 */
export function annotationBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return base.slice(0, base.lastIndexOf("/") + 1) + "annotations/";
}

/**
 * The geographic level the camera is looking at. Level 0 is the whole globe, and each level down
 * halves the height.
 */
export function levelAt(height: number): number {
  return Math.max(0, Math.round(Math.log2(LEVEL_HEIGHT / height)));
}

/**
 * Metres. The mean Earth radius: whether the globe stands in front of a name does not need the
 * ellipsoid's 0.3 per cent flattening.
 */
const EARTH_RADIUS = 6_371_000;

/**
 * How far past the limb a name must sit before it is kept, as a dot product. Zero would keep a name
 * exactly on the edge of the disc, where half its text falls into space.
 */
const LIMB_MARGIN = 0.02;

/** The width of a sans-serif glyph, as a fraction of the font size, averaged over mixed case. */
const GLYPH_WIDTH = 0.55;

/** Pixels of clearance around a name's box. The outline alone is 3 px wide. */
const BOX_PAD = 3;

/** A rectangle in window pixels, with y downward. */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What the camera makes of a place, which is what decides whether two names land on each other. */
export interface CameraView {
  /** The camera position in world coordinates, or `undefined` for a view with no far side. */
  eye: { x: number; y: number; z: number } | undefined;
  /**
   * Where a longitude and latitude land on the canvas, or `undefined` when they land nowhere on it.
   */
  window(lon: number, lat: number): { x: number; y: number } | undefined;
}

/**
 * Whether the globe stands between the camera and a place.
 *
 * A place's own surface normal and the direction from the camera to it agree only on the far
 * hemisphere. The view rectangle cannot answer this: at globe range it covers the whole world, so
 * without the test a name behind the Earth spends a slot from the cap, and one just past the limb
 * writes its letters into the black beside the disc — `SOUTH AMERICA` reads as `ERICA`.
 */
export function behindGlobe(lon: number, lat: number, eye: NonNullable<CameraView["eye"]>): boolean {
  const rad = Math.PI / 180;
  const cosLat = Math.cos(lat * rad);
  // On a sphere the unit surface normal is the direction of the point itself.
  const n = { x: cosLat * Math.cos(lon * rad), y: cosLat * Math.sin(lon * rad), z: Math.sin(lat * rad) };
  const dx = n.x * EARTH_RADIUS - eye.x;
  const dy = n.y * EARTH_RADIUS - eye.y;
  const dz = n.z * EARTH_RADIUS - eye.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return (n.x * dx + n.y * dy + n.z * dz) / len > -LIMB_MARGIN;
}

/** The text a name is drawn with, leading space and all. */
function textOf(r: NamedPlace): string {
  // A dotted kind marks a point rather than an area, so its text hangs beside that point.
  return STYLE[r.kind].dot ? "  " + r.name : r.name;
}

/**
 * Roughly where a name's text lands, given the pixel its position projects to.
 *
 * Character count against font size is enough. A name clipped by a neighbour it half touches is a
 * smaller fault than a name that vanishes, so the box errs neither way on purpose.
 */
function boxOf(r: NamedPlace, x: number, y: number): Box {
  const style = STYLE[r.kind];
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(style.font)?.[1] ?? 12);
  const width = textOf(r).length * size * GLYPH_WIDTH + 2 * BOX_PAD;
  const height = size * 1.2 + 2 * BOX_PAD;
  // A dotted kind hangs its text to the right of its position; every other kind is centred on it.
  const left = style.dot ? x - BOX_PAD : x - width / 2;
  return { left, right: left + width, top: y - height / 2, bottom: y + height / 2 };
}

function hits(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Standing inside a kind, from 1 for the largest down to 1/n for the smallest.
 *
 * `importance` mixes units across the kinds — population for a city, a capital and a country, area
 * for a continent, an ocean and a sea — so the raw numbers are not one scale. Sorted raw, every
 * country outranks every city inside it, and the water sinks: an ocean reads about 10,000 against
 * a city's population, so over Europe at level 5 all 31 water names in view fall past the cap and
 * none is drawn. Standing puts the kinds on one scale and leaves the order within a kind exactly as
 * `importance` gives it, so no kind decides anything on its own.
 */
function standing(rows: NamedPlace[]): Map<NamedPlace, number> {
  const kinds = new Map<NamedPlace["kind"], NamedPlace[]>();
  for (const r of rows) {
    const same = kinds.get(r.kind);
    if (same) same.push(r);
    else kinds.set(r.kind, [r]);
  }
  const rank = new Map<NamedPlace, number>();
  for (const same of kinds.values()) {
    same.sort((a, b) => b.importance - a.importance);
    same.forEach((r, i) => rank.set(r, (same.length - i) / same.length));
  }
  return rank;
}

/**
 * The names to draw: the ones this level carries, on the near side of the globe, in view, ranked,
 * decluttered, and capped at what a frame can afford.
 *
 * This is the whole paging pass, and the order of its three parts is the design.
 *
 * 1. **Range.** A continent, an ocean and a country name stop competing where the cities inside
 *    them take over, and a name the globe hides never competes at all.
 * 2. **Rank.** Sorted before anything is dropped, so the name a reader most expects to see is the
 *    one that claims its pixels.
 * 3. **Collision.** A greedy walk down that order, keeping a name only when its box misses every
 *    box already kept. Without the rank ahead of it this keeps whichever name the file happened to
 *    list first: Rome and Vatican City are two kilometres apart and both are capitals.
 *
 * `camera` is what turns a position into pixels. Without one the pass stops after the rank, which
 * is what a caller measuring the filter alone wants.
 *
 * Four hundred boxes is 160,000 box tests, about 1 ms. If that ever shows in a frame, sort the
 * boxes into a grid before comparing them — do not reach for a grid first.
 */
export function visibleNames(
  rows: NamedPlace[],
  level: number,
  view: Rectangle | undefined,
  camera?: CameraView,
): NamedPlace[] {
  const deg = 180 / Math.PI;
  const south = view ? view.south * deg : -90;
  const north = view ? view.north * deg : 90;
  const west = view ? view.west * deg : -180;
  const east = view ? view.east * deg : 180;
  // A view straddling the antimeridian reports a west greater than its east, and the longitudes it
  // holds are the ones outside the pair rather than between them.
  const inView = (r: NamedPlace) =>
    !view || (r.lat >= south && r.lat <= north &&
      (west <= east ? r.lon >= west && r.lon <= east : r.lon >= west || r.lon <= east));
  const candidates = rows.filter((r) =>
    r.minz <= level && level <= r.maxz && inView(r) &&
    !(camera?.eye && behindGlobe(r.lon, r.lat, camera.eye)));

  const rank = standing(candidates);
  candidates.sort((a, b) => rank.get(b)! - rank.get(a)! || b.importance - a.importance);
  if (!camera) return candidates.slice(0, ON_SCREEN);

  const kept: NamedPlace[] = [];
  const boxes: Box[] = [];
  for (const r of candidates) {
    if (kept.length >= ON_SCREEN) break;
    const at = camera.window(r.lon, r.lat);
    if (!at) continue;
    const box = boxOf(r, at.x, at.y);
    if (boxes.some((b) => hits(box, b))) continue;
    boxes.push(box);
    kept.push(r);
  }
  return kept;
}

/**
 * Add the annotation layers to a widget, and answer the handle that switches each on and off.
 *
 * `show` is what the session declared. Every file is fetched either way, so a layer declared off
 * can still be switched on later; what a layer that is off does not pay for is the pass that fills
 * it, which is where the cost is.
 *
 * The data is fetched in the background: the layers appear when it arrives, and a fetch that fails
 * leaves the globe as it was and says so once. Nothing here reaches the network — every file ships
 * inside the viewer — so this opens no origin and asks for no credit.
 */
export function addAnnotations(
  widget: CesiumWidget,
  baseUrl: string,
  show: AnnotationFlags = {},
): Annotations {
  const base = annotationBase(baseUrl);
  let borders: GeoJsonDataSource | null = null;
  // Fills the label collection from the camera it is called under. It stays a no-op until the names
  // arrive, and switching the layer back on calls it rather than waiting for the camera to move.
  let repopulate = () => {};
  const on = {
    places: show.places !== false,
    borders: show.borders !== false,
  };
  const warn = (what: string) => (err: unknown) => {
    console.warn(`CesiumLink: the ${what} did not load (${err}). The globe wears none.`);
  };
  // `moveEnd` fires only once the camera has settled, so on its own the names lag a zoom by the
  // whole of it and then snap. `changed` fires during the movement instead, every time the view
  // has altered by `percentageChanged`.
  const onCamera = () => {
    repopulate();
  };
  widget.camera.percentageChanged = CAMERA_STEP;
  widget.camera.changed.addEventListener(onCamera);
  widget.camera.moveEnd.addEventListener(onCamera);

  const names = (async () => {
    const rows: NamedPlace[] = await (await fetch(base + "named-places.json")).json();
    const collection: LabelCollection = widget.scene.primitives.add(
      new LabelCollection({ scene: widget.scene }),
    );
    repopulate = () => {
      collection.removeAll();
      // A layer that is off holds no labels at all. `show = false` would hide them and still pay
      // for every one, which is the whole reason this pass exists.
      if (!on.places) return;
      const scene = widget.scene;
      const camera = scene.camera;
      const canvas = scene.canvas;
      // Only a globe has a far side. In 2D and Columbus view the camera's world position is not a
      // point over an ellipsoid, and the test read from it hides every name.
      const eye = scene.mode === SceneMode.SCENE3D ? camera.positionWC : undefined;
      const view: CameraView = {
        eye,
        window(lon, lat) {
          const at = SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(lon, lat));
          if (!at || at.x < 0 || at.y < 0 || at.x > canvas.clientWidth || at.y > canvas.clientHeight) {
            return undefined;
          }
          return at;
        },
      };
      const level = levelAt(camera.positionCartographic.height);
      for (const r of visibleNames(rows, level, camera.computeViewRectangle(), view)) {
        collection.add(labelFor(r));
      }
    };
    repopulate();
  })();

  const lines = (async () => {
    // The boundaries arrive as LineString features and draw as plain polylines on the ellipsoid,
    // never as ground polylines. A ground polyline is built in a worker that first fetches
    // `Assets/approximateTerrainHeights.json` for itself, and the worker keeps a fetch that failed
    // for good: every later line fails with it, and the failure is a bare object the primitive
    // throws from the render loop, which stops the globe. A VSCode webview answers that fetch with
    // 408 when its resource pipe is slow. This globe has no terrain, so a line at height zero lies
    // on the surface, and `depthTestAgainstTerrain` is off, so the globe never hides one.
    //
    // Lines, not polygon outlines: Cesium draws no outline for an entity polygon on the globe and
    // says nothing, so the data source loads, the entities exist, `polygon.outline` reads true and
    // the globe is bare.
    const source = await GeoJsonDataSource.load(base + "country-borders.geojson", {
      stroke: COUNTRY_LINE,
      strokeWidth: COUNTRY_LINE_WIDTH,
    });
    source.show = on.borders;
    borders = source;
    widget.dataSources.add(source);
  })();

  names.catch(warn("place names"));
  lines.catch(warn("country borders"));

  const handle: Annotations = {
    // Read off the same object the two setters write, so a control over the globe states what the
    // layers are rather than holding a second copy of it that can drift.
    get places() {
      return on.places;
    },
    get borders() {
      return on.borders;
    },
    showPlaces(draw) {
      on.places = draw;
      repopulate();
    },
    showBorders(draw) {
      on.borders = draw;
      if (borders) borders.show = draw;
    },
  };
  attached.set(widget, handle);
  return handle;
}

function labelFor(r: NamedPlace) {
  const style = STYLE[r.kind];
  return {
    position: Cartesian3.fromDegrees(r.lon, r.lat),
    text: textOf(r),
    font: style.font,
    fillColor: Color.fromCssColorString(style.fill),
    outlineColor: Color.BLACK,
    outlineWidth: 3,
    style: LabelStyle.FILL_AND_OUTLINE,
    horizontalOrigin: style.dot ? HorizontalOrigin.LEFT : HorizontalOrigin.CENTER,
    verticalOrigin: VerticalOrigin.CENTER,
    // On the ellipsoid, not clamped: there is no terrain to clamp to, and a clamped label in 2D
    // lands well away from its place.
    heightReference: HeightReference.NONE,
    // Depth-tested, so a name on the far side of the globe is behind it rather than through it.
    disableDepthTestDistance: 0,
  };
}
