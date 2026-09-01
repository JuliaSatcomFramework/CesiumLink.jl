// Place names and country borders, drawn above whatever basemap the reader picked.
//
// Neither is a basemap. The session owns both, the Core adds them once, and the picker never
// touches them: it removes only the base layers it counted from the entry on the globe, so a layer
// added above survives a switch (ADR-0036).
//
// The two are independent. Either may be off while the other is on.

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

/** The two layers, each switchable on its own. */
export interface Annotations {
  /** Draw the place names, or take them off. */
  showPlaces(on: boolean): void;
  /** Draw the country borders, or take them off. */
  showBorders(on: boolean): void;
}

// The handle for a viewer, so that whatever puts the two flags on the wire can reach the layers
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
 * The names to draw: the ones this level carries, inside the view, ranked, and capped at what a
 * frame can afford.
 *
 * This is the whole paging pass. A name is kept on three counts and no more — its level, its
 * position and its rank — so a declutter step that drops a name whose text would land on one
 * already kept goes after the sort and before the cap.
 */
export function visibleNames(
  rows: NamedPlace[],
  level: number,
  view: Rectangle | undefined,
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
  return rows
    .filter((r) => r.minz <= level && level <= r.maxz && inView(r))
    .sort((a, b) => a.minz - b.minz || b.importance - a.importance)
    .slice(0, ON_SCREEN);
}

/**
 * Add the two annotation layers to a widget, and answer the handle that switches each on and off.
 *
 * The data is fetched in the background: the layers appear when it arrives, and a fetch that fails
 * leaves the globe as it was and says so once. Nothing here reaches the network — both files ship
 * inside the viewer — so this opens no origin and asks for no credit.
 */
export function addAnnotations(widget: CesiumWidget, baseUrl: string): Annotations {
  const base = annotationBase(baseUrl);
  let labels: LabelCollection | null = null;
  let borders: GeoJsonDataSource | null = null;
  const on = { places: true, borders: true };

  const names = (async () => {
    const rows: NamedPlace[] = await (await fetch(base + "named-places.json")).json();
    const collection: LabelCollection = widget.scene.primitives.add(
      new LabelCollection({ scene: widget.scene }),
    );
    collection.show = on.places;
    labels = collection;
    const repopulate = () => {
      const camera = widget.scene.camera;
      collection.removeAll();
      const level = levelAt(camera.positionCartographic.height);
      for (const r of visibleNames(rows, level, camera.computeViewRectangle())) {
        collection.add(labelFor(r));
      }
    };
    // `moveEnd` fires only once the camera has settled, so on its own the names lag a zoom by the
    // whole of it and then snap. `changed` fires during the movement instead, every time the view
    // has altered by `percentageChanged`.
    widget.camera.percentageChanged = CAMERA_STEP;
    widget.camera.changed.addEventListener(repopulate);
    widget.camera.moveEnd.addEventListener(repopulate);
    repopulate();
  })();

  const lines = (async () => {
    // The boundaries arrive as LineString features, which Cesium turns into ground polylines. A
    // country polygon draws no outline on terrain: Cesium disables entity geometry outlines there
    // and says nothing, so the data source loads, the entities exist, `polygon.outline` reads true
    // and the globe is bare.
    const source = await GeoJsonDataSource.load(base + "country-borders.geojson", {
      stroke: Color.WHITE.withAlpha(0.55),
      strokeWidth: 2,
      clampToGround: true,
    });
    source.show = on.borders;
    borders = source;
    widget.dataSources.add(source);
  })();

  for (const [what, done] of [["place names", names], ["country borders", lines]] as const) {
    done.catch((err) => {
      console.warn(`CesiumLink: the ${what} did not load (${err}). The globe wears none.`);
    });
  }

  const handle: Annotations = {
    showPlaces(show) {
      on.places = show;
      if (labels) labels.show = show;
    },
    showBorders(show) {
      on.borders = show;
      if (borders) borders.show = show;
    },
  };
  attached.set(widget, handle);
  return handle;
}

function labelFor(r: NamedPlace) {
  const style = STYLE[r.kind];
  return {
    position: Cartesian3.fromDegrees(r.lon, r.lat),
    // A dotted kind marks a point rather than an area, so its text hangs beside that point.
    text: style.dot ? "  " + r.name : r.name,
    font: style.font,
    fillColor: Color.fromCssColorString(style.fill),
    outlineColor: Color.BLACK,
    outlineWidth: 3,
    style: LabelStyle.FILL_AND_OUTLINE,
    horizontalOrigin: style.dot ? HorizontalOrigin.LEFT : HorizontalOrigin.CENTER,
    verticalOrigin: VerticalOrigin.CENTER,
    heightReference: HeightReference.CLAMP_TO_GROUND,
    // Depth-tested, so a name on the far side of the globe is behind it rather than through it.
    disableDepthTestDistance: 0,
  };
}
