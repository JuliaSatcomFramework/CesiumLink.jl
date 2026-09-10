// Two things the Core draws on the globe itself, both declared by the server and neither belonging
// to any module: the graticule over it, and whether the globe stands in the depth buffer in front of
// what is drawn above it.
//
// The graticule hides its own far half rather than leaning on the depth setting. A line drawn
// through the Earth is what the setting exists to stop, but the setting is scene-wide, it is
// bypassed in 2-D, and with it on the occlusion comes from the tiles that happen to have loaded. The
// same limb test the place names use answers all three at once, and answers them per line.

import {
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
const DEFAULT_WIDTH = 1;
const DEFAULT_ALTITUDE_M = 30_000;

/**
 * The longest a segment may span, as degrees of arc along its own line.
 *
 * The viewer joins two vertices with a straight chord, so this is what decides how far a drawn line
 * departs from the circle it stands for: three degrees sits about 2.2 km inside the sphere at the
 * middle of a segment. It is also what a graticule costs to draw, since it sets how many vertices
 * the limb test walks.
 */
const CUT_DEG = 3;

/**
 * How much the camera must move before the limb is worked out again: a quarter degree of rotation,
 * or a hundredth of the range.
 *
 * Finer buys nothing a reader can see, and the test runs once per frame either way — what the
 * threshold governs is how often the lines are cut and handed to the GPU again.
 */
const SETTLED_COS = Math.cos((0.25 * Math.PI) / 180);
const SETTLED_RANGE = 0.01;

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
 * The runs of a line the camera can see, as index ranges `[first, last]` into its vertices.
 *
 * `visible` reports whether each vertex is on the camera's own side of the Earth. A run stops at the
 * last vertex before one that is not, so a line reaches the limb from inside rather than overshooting
 * it into space — the same direction of error the place names take, and the one a reader does not
 * notice.
 */
export function visibleRuns(visible: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= visible.length; i++) {
    if (i < visible.length && visible[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      // A run of one vertex is a point, and a point is not a line.
      if (i - start >= 2) runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}

/** What a declaration was resolved to, kept so a camera move can cut the lines again. */
interface Drawn {
  lines: GraticuleLine[];
  /** The vertices of each line as world positions, in the same order. */
  positions: Cartesian3[][];
  labels: GraticuleLabel[];
  color: Color;
  width: number;
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
  let drawn: Drawn | null = null;
  const sayBadColour = sayOnce((message: string) => console.warn(message));

  // The camera the lines were last cut for: its direction, its range, and the scene mode. A mode
  // has no far side unless it is 3-D, and then the whole graticule is drawn and cut once.
  const lastEye = new Cartesian3();
  let haveEye = false;
  let lastMode: SceneMode | null = null;
  const direction = new Cartesian3();
  const lastDirection = new Cartesian3();

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

  // Cut the lines to the runs this camera can see, and hide the labels it cannot. `eye` is the
  // camera's world position, or undefined for a view with no far side, which draws everything.
  //
  // The polylines already in the collection are written over rather than replaced. A `Polyline`
  // destroys its own material as it leaves the collection, so a cut that cleared the collection
  // could not share one material between lines — and giving every run a material of its own, every
  // time the camera moves, is what this reuse costs instead. The pool keeps whatever the widest
  // view needed and hides the surplus.
  const cut = (eye: Cartesian3 | undefined) => {
    const at = drawn;
    const pl = lines;
    if (!at || !pl) return;
    let used = 0;
    for (let i = 0; i < at.lines.length; i++) {
      const line = at.lines[i];
      const positions = at.positions[i];
      const visible = eye
        ? line.lon.map((lon, k) => !behindGlobe(lon, line.lat[k], eye))
        : line.lon.map(() => true);
      for (const [first, last] of visibleRuns(visible)) {
        const run = positions.slice(first, last + 1);
        if (used < pl.length) {
          const drawnLine = pl.get(used);
          drawnLine.positions = run;
          drawnLine.width = at.width;
          drawnLine.show = true;
          drawnLine.material.uniforms.color = at.color;
        } else {
          pl.add({
            positions: run,
            width: at.width,
            material: Material.fromType("Color", { color: at.color }),
          });
        }
        used++;
      }
    }
    for (let i = used; i < pl.length; i++) pl.get(i).show = false;
    for (let i = 0; labels && i < at.labels.length; i++) {
      const anchor = at.labels[i];
      labels.get(i).show = !eye || !behindGlobe(anchor.lon, anchor.lat, eye);
    }
    scene.requestRender?.();
  };

  // One frame's worth of work: the direction and range the camera stands at, against the ones the
  // lines were cut for. The test is two dot products and a subtraction; the cut behind it is what
  // the threshold is protecting.
  const onPreRender = () => {
    if (!drawn) return;
    const mode = scene.mode;
    if (mode !== SceneMode.SCENE3D) {
      if (mode === lastMode) return;
      lastMode = mode;
      haveEye = false;
      cut(undefined);
      return;
    }
    const eye = scene.camera.positionWC;
    const range = Cartesian3.magnitude(eye);
    if (mode === lastMode && haveEye) {
      Cartesian3.normalize(eye, direction);
      Cartesian3.normalize(lastEye, lastDirection);
      const turned = Cartesian3.dot(direction, lastDirection) < SETTLED_COS;
      const moved = Math.abs(range - Cartesian3.magnitude(lastEye)) >
        SETTLED_RANGE * Cartesian3.magnitude(lastEye);
      if (!turned && !moved) return;
    }
    lastMode = mode;
    haveEye = true;
    Cartesian3.clone(eye, lastEye);
    cut(eye);
  };

  const clear = () => {
    drawn = null;
    haveEye = false;
    lastMode = null;
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
      drawn = {
        lines: geometry.lines,
        positions: geometry.lines.map((line) =>
          line.lon.map((lon, k) => Cartesian3.fromDegrees(lon, line.lat[k], altitude))
        ),
        labels: decl.labels === false ? [] : geometry.labels,
        color: colourOf(decl.color, DEFAULT_COLOR),
        width: decl.width ?? DEFAULT_WIDTH,
      };
      const labelColor = colourOf(decl.labelColor, DEFAULT_LABEL_COLOR);
      for (const at of drawn.labels) {
        labels.add({
          position: Cartesian3.fromDegrees(at.lon, at.lat, altitude),
          text: at.text,
          font: decl.labelFont ?? DEFAULT_LABEL_FONT,
          fillColor: labelColor,
          style: LabelStyle.FILL,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
        });
      }
      // Cut for wherever the camera stands now, rather than waiting for it to move.
      haveEye = false;
      lastMode = null;
      onPreRender();
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
