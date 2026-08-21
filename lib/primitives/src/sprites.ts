// What a node family draws its entities with, in the four forms a marker name takes: a stock glyph,
// a file the server serves, a `data:` URI, or a sprite a peer module registered here.
//
// Each stock glyph is a small white canvas drawn once and shared by every family that asks for it,
// so per-entity colour is the billboard's tint and no family needs an image of its own.

import { sayOnce } from "../../core/src/once.ts";
import { sourceOf } from "../../core/src/source.ts";
import { registry } from "./registry.ts";

// A stock name holds no `.` and no `/`: either would read as a module name or an asset path.
export type Marker = "disc" | "square" | "diamond" | "triangle" | "triangle_down"
                   | "triangle_right" | "triangle_left" | "pentagon" | "hexagon" | "star"
                   | "cross" | "x";

const SIZE = 32;

const cache = new Map<Marker, HTMLCanvasElement>();

function canvas(draw: (g: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = cv.height = SIZE;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";
  g.lineJoin = "round";
  draw(g, SIZE);
  // A dark rim under the fill keeps a light marker readable against imagery of any brightness.
  g.lineWidth = SIZE * 0.1;
  g.strokeStyle = "rgba(0,0,0,0.85)";
  g.stroke();
  return cv;
}

const polygon = (g: CanvasRenderingContext2D, points: [number, number][]) => {
  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
};

/** Corners of a regular `sides`-gon of radius `r` about the canvas centre, first corner at `phase`. */
function regular(sides: number, r: number, phase: number): [number, number][] {
  const c = SIZE / 2;
  return Array.from({ length: sides }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / sides;
    return [c + r * Math.cos(a), c + r * Math.sin(a)] as [number, number];
  });
}

// Corners of a plus in units of its radius, going around from the tip of the right arm. Turned an
// eighth of a turn it is the x.
const PLUS: [number, number][] = [
  [1, 0.3], [0.3, 0.3], [0.3, 1], [-0.3, 1], [-0.3, 0.3], [-1, 0.3],
  [-1, -0.3], [-0.3, -0.3], [-0.3, -1], [0.3, -1], [0.3, -0.3], [1, -0.3],
];

/** `PLUS` scaled to radius `r`, turned by `phase`, about the canvas centre. */
function plus(r: number, phase: number): [number, number][] {
  const c = SIZE / 2, k = Math.cos(phase), n = Math.sin(phase);
  return PLUS.map(([x, y]) => [c + r * (x * k - y * n), c + r * (x * n + y * k)] as [number, number]);
}

const DRAW: Record<Marker, (g: CanvasRenderingContext2D, s: number) => void> = {
  disc: (g, s) => {
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2);
    g.fill();
  },
  star: (g, s) => {
    const R = s * 0.46, r = R * 0.4, c = s / 2;
    polygon(g, Array.from({ length: 10 }, (_, i) => {
      const rad = i % 2 ? r : R;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      return [c + rad * Math.cos(a), c + rad * Math.sin(a)] as [number, number];
    }));
  },
  square: (g, s) => polygon(g, regular(4, s * 0.42, Math.PI / 4)),
  diamond: (g, s) => polygon(g, regular(4, s * 0.44, -Math.PI / 2)),
  triangle: (g, s) => polygon(g, regular(3, s * 0.44, -Math.PI / 2)),
  triangle_down: (g, s) => polygon(g, regular(3, s * 0.44, Math.PI / 2)),
  triangle_right: (g, s) => polygon(g, regular(3, s * 0.44, 0)),
  triangle_left: (g, s) => polygon(g, regular(3, s * 0.44, Math.PI)),
  pentagon: (g, s) => polygon(g, regular(5, s * 0.44, -Math.PI / 2)),
  hexagon: (g, s) => polygon(g, regular(6, s * 0.44, -Math.PI / 2)),
  cross: (g, s) => polygon(g, plus(s * 0.44, 0)),
  x: (g, s) => polygon(g, plus(s * 0.44, Math.PI / 4)),
};

/** What a registered sprite answers with: an image URL, or a canvas drawn in the browser. */
export type SpriteFactory = () => HTMLCanvasElement | string;

const sprites = registry<SpriteFactory>("node sprite");

/**
 * Register a node sprite another module draws, under an owner-namespaced name (`orbits.pulse`) that
 * a scene then names as its `marker`. Call it from your module's `setup`.
 *
 * Cesium keys its texture cache on what the factory answers, so answer the same canvas — or the same
 * URL — every call. A factory that draws a fresh canvas per call costs one texture per call.
 */
export const defineNodeSprite = sprites.define;

/**
 * Drop every registered sprite. Called when `primitives` unloads: the modules that registered them
 * are unloaded alongside it, and their factories close over a context that no longer exists.
 *
 * The names already warned about go with them. A host re-imports this module from its own cache, so
 * a name still unanswered after a reload gets its line again rather than staying silent behind the
 * set the last session filled.
 */
export function clearNodeSprites(): void {
  sprites.clear();
  say = reporter();
}

// One line per unresolvable name. A family rebuilds on every replacing window, so a marker nobody
// answers for is unanswered on every one of them.
const reporter = () => sayOnce((message: string) => console.warn(message));
let say = reporter();

/**
 * What a family draws its entities with, read off the marker name: a `data:` URI passed to Cesium as
 * it stands, a file the server serves, a sprite a peer module registered, or the shared canvas of a
 * stock glyph. A name nothing answers for falls back to the disc, which keeps a typo visible rather
 * than leaving the family unmarked.
 *
 * A remote URL is no form of the rule. The webview serves the page under `default-src 'none'`, and
 * its `img-src` names `data:` and its own origin only, so a marker fetched from another origin draws
 * in a browser tab and draws nothing at all in an editor tab. `assetUrl` answers a URL on the host's
 * own origin, which is why an `assets/<mount>/<file>` path is a form and an `https://` one is not.
 *
 * Cesium loads a URL itself, and asynchronously: the family stands unmarked for the frames that
 * takes. It also keys its texture cache on the string, so one image serves every family that names
 * it however long the string is.
 */
export function markerSprite(marker: string,
                             assetUrl: (path: string) => string | null): HTMLCanvasElement | string {
  const source = sourceOf(marker);
  switch (source.kind) {
    case "data":
      return source.uri;
    case "asset":
      // `assetUrl` writes its own line for a path this host cannot reach, so this only draws.
      return assetUrl(source.path) ?? stock("disc");
    case "module": {
      const factory = sprites.get(source.name);
      if (factory) return factory();
      say(marker, `primitives: no node sprite named ${JSON.stringify(marker)} is registered; ` +
                  "the disc is drawn");
      return stock("disc");
    }
    case "stock":
      // Silent: the stock table is this module's own, and a name outside it is a typo the disc shows.
      return stock(source.name);
  }
}

/** True for a name the stock table draws. */
const isStock = (name: string): name is Marker => name in DRAW;

/** The shared canvas of a stock glyph, drawn on first use. An unknown name is the disc. */
function stock(name: string): HTMLCanvasElement {
  const key = isStock(name) ? name : "disc";
  let cv = cache.get(key);
  if (!cv) cache.set(key, (cv = canvas(DRAW[key])));
  return cv;
}
