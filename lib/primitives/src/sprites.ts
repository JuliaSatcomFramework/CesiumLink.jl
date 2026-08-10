// The stock marker glyphs. Each is a small white canvas drawn once and shared by every family that
// asks for it, so per-entity colour is the billboard's tint and no family needs an image of its own.

export type Marker = "disc" | "star" | "square" | "triangle";

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
  triangle: (g, s) => polygon(g, regular(3, s * 0.44, -Math.PI / 2)),
};

/**
 * What a family draws its entities with: the shared canvas for a stock glyph, drawn on first use, or
 * a `data:` URI passed to Cesium as it stands. An unknown name falls back to the disc.
 *
 * A `data:` URI is the one image source both hosts admit. The webview serves the page under
 * `default-src 'none'`, and its `img-src` names `data:` but no remote origin, so a marker fetched
 * over http draws in the browser and draws nothing at all in an editor tab.
 *
 * Cesium loads the URI itself, and asynchronously: the family stands unmarked for the frames that
 * takes. It also keys its texture cache on the string, so one image serves every family that names
 * it however long the string is.
 */
export function markerSprite(marker: string): HTMLCanvasElement | string {
  if (marker.startsWith("data:")) return marker;
  const stock = marker as Marker;
  const draw = DRAW[stock] ?? DRAW.disc;
  const key = DRAW[stock] ? stock : "disc";
  let cv = cache.get(key);
  if (!cv) cache.set(key, (cv = canvas(draw)));
  return cv;
}
