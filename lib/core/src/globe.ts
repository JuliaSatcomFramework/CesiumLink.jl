// Two things the Core draws on the globe itself, both declared by the server and neither belonging
// to any module: the graticule over it, and whether the globe stands in the depth buffer in front of
// what is drawn above it.
//
// The lines of the graticule are drawn whole. In 3-D, with the depth setting off, Cesium's depth
// plane hides the far half of every line. A label is a billboard, and the part of it that stands
// past the limb misses the depth plane, so the labels take the limb test the place names use.

import {
  Cartesian2,
  Cartesian3,
  type CesiumWidget,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Material,
  PolylineCollection,
  SceneMode,
  VerticalOrigin,
} from "@cesium/engine";
import { behindGlobe } from "./annotations";
import { sayOnce } from "./once";

/** The graticule the server declares. `lon` absent or null is the graticule switched off. */
export interface GraticuleDeclaration {
  /** Degrees between meridians. */
  lon?: number | null;
  /** Degrees between parallels. */
  lat?: number | null;
  /** A CSS colour string. One the browser cannot read draws the default instead. */
  color?: string;
  /** Pixels. */
  width?: number;
  /** Write the longitude and latitude of each line. */
  labels?: boolean;
  labelColor?: string;
  labelFont?: string;
  /** Metres above the ellipsoid the lines and their labels stand at. */
  altitudeM?: number;
}

/** The graticule of a viewer: what the last declaration said, until the next one. */
export interface Graticule {
  /** Draw the graticule this declaration states, in place of whatever stands. */
  declare(decl: GraticuleDeclaration): void;
  destroy(): void;
}

const DEFAULT_COLOR = "#33333340";
const DEFAULT_LABEL_COLOR = "#222222d0";
const DEFAULT_LABEL_FONT = "12px system-ui";
// A label is anchored on the crossing of its line with the axis it stands along, and the text is
// kept off both lines: its top-left corner hangs this far below and to the right of the anchor, so
// neither line runs through the numbers.
const LABEL_OFFSET_PX = 4;
const DEFAULT_WIDTH = 0.75;
const DEFAULT_ALTITUDE_M = 0;

/**
 * The longest a segment may span, as degrees of arc along its own line.
 *
 * The viewer joins two vertices with a straight chord, so this is what decides how far a drawn line
 * departs from the circle it stands for: three degrees sits about 2.2 km inside the sphere at the
 * middle of a segment.
 */
const CUT_DEG = 3;

/**
 * How many segments a line spanning `spanDeg` is cut into. `radius` is the radius of the circle it
 * runs on as a fraction of the globe's: 1 for a meridian, and the cosine of its latitude for a
 * parallel.
 *
 * The chord error of a segment falls with the square of the angle it spans and rises with the radius
 * it is cut from, so a circle of a quarter the radius carries the same error over segments twice as
 * wide. Cutting by the root is what holds that error at `CUT_DEG` on every line: a parallel at 80°
 * is a fifth of the equator, and cutting it like the equator would spend five times the vertices it
 * needs on the shortest circles of the graticule.
 */
export function cuts(spanDeg: number, radius: number): number {
  return Math.max(2, Math.ceil((spanDeg * Math.sqrt(Math.max(radius, 0))) / CUT_DEG));
}

/** A degree, as a label writes it: at most two decimals, and no trailing zeros. */
function degrees(v: number): string {
  return String(Math.round(Math.abs(v) * 100) / 100);
}

/**
 * The label a meridian carries, and the one a parallel carries. The prime meridian and the equator
 * are both `0°`, which is why one label serves both where they cross.
 */
export function meridianLabel(lon: number): string {
  return lon === 0 ? "0°" : `${degrees(lon)}°${lon > 0 ? "E" : "W"}`;
}

export function parallelLabel(lat: number): string {
  return lat === 0 ? "0°" : `${degrees(lat)}°${lat > 0 ? "N" : "S"}`;
}

/** One line of the graticule: its vertices in degrees, in the order they join. */
export interface GraticuleLine {
  lon: number[];
  lat: number[];
}

/** Where a label stands, and what it says. */
export interface GraticuleLabel {
  lon: number;
  lat: number;
  text: string;
}

/**
 * The lines of a graticule and the labelled anchors along its two axes.
 *
 * ±180° is one meridian and not two, and the poles carry no parallel, so both are dropped. A
 * meridian is labelled where it crosses the equator and a parallel where it crosses the prime
 * meridian, so the numbers stand along two axes through the middle of the map rather than repeating
 * across it; at 0°, 0° the meridian's label is the only one written, and it serves the equator too.
 */
export function graticuleGeometry(
  lonSpacing: number,
  latSpacing: number,
): { lines: GraticuleLine[]; labels: GraticuleLabel[] } {
  const lines: GraticuleLine[] = [];
  const labels: GraticuleLabel[] = [];

  const meridians = Math.floor(360 / lonSpacing);
  for (let i = 0; i < meridians; i++) {
    const lon = -180 + i * lonSpacing;
    if (lon >= 180) break;
    const n = cuts(180, 1);
    const line: GraticuleLine = { lon: [], lat: [] };
    for (let k = 0; k <= n; k++) {
      line.lon.push(lon);
      line.lat.push(-90 + (180 * k) / n);
    }
    lines.push(line);
    labels.push({ lon, lat: 0, text: meridianLabel(lon) });
  }

  // The outermost parallel the spacing reaches without landing on a pole, which carries no circle.
  const rest = 90 % latSpacing;
  const top = 90 - (rest === 0 ? latSpacing : rest);
  // By index rather than by accumulation: a spacing that does not divide 90 evenly would otherwise
  // drift, and the equator would miss the test that stops its label being written twice.
  const parallels = Math.round((2 * top) / latSpacing);
  for (let j = 0; j <= parallels; j++) {
    const lat = -top + j * latSpacing;
    const n = cuts(360, Math.cos((lat * Math.PI) / 180));
    const line: GraticuleLine = { lon: [], lat: [] };
    for (let k = 0; k <= n; k++) {
      line.lon.push(-180 + (360 * k) / n);
      line.lat.push(lat);
    }
    lines.push(line);
    // The equator's own label already stands at 0°, 0°, written there by the prime meridian.
    if (Math.abs(lat) > 1e-9) labels.push({ lon: 0, lat, text: parallelLabel(lat) });
  }

  return { lines, labels };
}

/**
 * Add the graticule to a widget, and answer the handle the server's declarations reach it through.
 *
 * Nothing is on the globe until a declaration asks for one. The collections are built on the first
 * declaration that draws and emptied by one that does not, so a session that never declares a
 * graticule pays for none of this.
 */
export function addGraticule(widget: CesiumWidget): Graticule {
  const scene = widget.scene;
  let lines: PolylineCollection | null = null;
  let labels: LabelCollection | null = null;
  let anchors: GraticuleLabel[] = [];
  const sayBadColour = sayOnce((message: string) => console.warn(message));

  const colourOf = (css: string | undefined, fallback: string): Color => {
    const named = css === undefined ? undefined : Color.fromCssColorString(css);
    if (css !== undefined && named === undefined) {
      sayBadColour(
        css,
        `CesiumLink: the graticule asks to be drawn in "${css}", which is not a CSS colour this ` +
          `browser reads. It is drawn in ${fallback}.`,
      );
    }
    return named ?? Color.fromCssColorString(fallback);
  };

  // Hide each label the globe stands in front of. Only a globe has a far side, so 2-D and Columbus
  // view show every label. A few dozen dot products, so it runs on every frame drawn.
  const onPreRender = () => {
    if (!labels) return;
    const eye = scene.mode === SceneMode.SCENE3D ? scene.camera.positionWC : undefined;
    for (let i = 0; i < anchors.length; i++) {
      labels.get(i).show = !eye || !behindGlobe(anchors[i].lon, anchors[i].lat, eye);
    }
  };

  const clear = () => {
    anchors = [];
    lines?.removeAll();
    labels?.removeAll();
    scene.requestRender?.();
  };

  const stopPreRender = scene.preRender.addEventListener(onPreRender);

  return {
    declare(decl) {
      const lonSpacing = decl.lon ?? null;
      const latSpacing = decl.lat ?? null;
      if (lonSpacing === null || latSpacing === null || lonSpacing <= 0 || latSpacing <= 0) {
        clear();
        return;
      }
      if (!lines) lines = scene.primitives.add(new PolylineCollection()) as PolylineCollection;
      if (!labels) labels = scene.primitives.add(new LabelCollection({ scene })) as LabelCollection;
      lines.removeAll();
      labels.removeAll();

      const altitude = decl.altitudeM ?? DEFAULT_ALTITUDE_M;
      const geometry = graticuleGeometry(lonSpacing, latSpacing);
      const color = colourOf(decl.color, DEFAULT_COLOR);
      const width = decl.width ?? DEFAULT_WIDTH;
      // A `Polyline` destroys its material as it leaves the collection, so each line owns one.
      for (const line of geometry.lines) {
        lines.add({
          positions: line.lon.map((lon, k) => Cartesian3.fromDegrees(lon, line.lat[k], altitude)),
          width,
          material: Material.fromType("Color", { color }),
        });
      }
      anchors = decl.labels === false ? [] : geometry.labels;
      const labelColor = colourOf(decl.labelColor, DEFAULT_LABEL_COLOR);
      for (const at of anchors) {
        labels.add({
          position: Cartesian3.fromDegrees(at.lon, at.lat, altitude),
          text: at.text,
          font: decl.labelFont ?? DEFAULT_LABEL_FONT,
          fillColor: labelColor,
          style: LabelStyle.FILL,
          horizontalOrigin: HorizontalOrigin.LEFT,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(LABEL_OFFSET_PX, LABEL_OFFSET_PX),
        });
      }
      onPreRender();
      scene.requestRender?.();
    },
    destroy() {
      stopPreRender();
      clear();
      if (lines) scene.primitives.remove(lines);
      if (labels) scene.primitives.remove(labels);
      lines = null;
      labels = null;
    },
  };
}

/** Whether the globe stands in the depth buffer in front of what is drawn over it. */
export interface GlobeDepth {
  declare(on: boolean): void;
  destroy(): void;
}

/**
 * Take the globe's depth setting under the Core's ownership, and answer the handle the server's
 * declarations reach it through.
 *
 * Two things in Cesium write the setting on their own — the terrain picker, when a terrain provider
 * is chosen — and a scene morph rebuilds enough of the scene to be worth distrusting. Rather than
 * name them, the flag is asserted again before any frame that would be drawn without it, which costs
 * one boolean test per frame and heals whatever cleared it.
 *
 * A declaration of `false` puts back the value the widget was built with, so a scene that turned it
 * on and was replaced does not leave the setting behind it.
 */
export function addGlobeDepth(widget: CesiumWidget): GlobeDepth {
  const scene = widget.scene;
  const globe = scene.globe;
  const before = globe.depthTestAgainstTerrain;
  let stop: (() => void) | null = null;
  const sayHealed = sayOnce((message: string) => console.debug(message));

  const assert = () => {
    if (globe.depthTestAgainstTerrain) return;
    globe.depthTestAgainstTerrain = true;
    sayHealed(
      "globe-depth",
      "CesiumLink: depthTestAgainstTerrain was cleared by something else; asserting it again.",
    );
  };

  const off = () => {
    stop?.();
    stop = null;
    globe.depthTestAgainstTerrain = before;
    scene.requestRender?.();
  };

  return {
    declare(on) {
      if (!on) return off();
      globe.depthTestAgainstTerrain = true;
      scene.requestRender?.();
      stop ??= scene.preRender.addEventListener(assert);
    },
    destroy: off,
  };
}
