// The scene a page reads out of its own address bar:
//
//   ?imagery=<url>[&tiling=geographic|mercator][&maxlevel=<n>][&credit=<text>][&ellipsoid=<a>,<b>]
//
// `index.html` and `player.html` both take these; the VSCode host has no address bar and takes the
// basemap from the declaration alone. Which of the two wins depends on whether anyone is behind the
// declaration: on `index.html` a live server owns the session and these parameters fill in only what
// it does not state, while on `player.html` they beat the recording's header, because that header
// describes a session that has ended and the reader is repairing it (ADR-0024).
//
// A bad value is dropped with a warning. The reader is typing into an address bar, so a mistyped
// `tiling` must cost them that one parameter rather than the whole page.
import type { ImagerySpec } from "./scene";

/** What `sceneFromQuery` reads: the two `createViewer` options a page can be told in its URL. */
export interface QueryScene {
  imagery?: ImagerySpec;
  ellipsoid?: { a: number; b: number };
}

/**
 * Read the scene parameters out of a page's query string.
 *
 * `?ellipsoid=` is raw radii in metres, semi-major first: `?ellipsoid=1737400,1737400` is the Moon.
 * A body name would need the radii table here as well as in Julia, and one physical constant with
 * two homes in two languages drifts apart in silence.
 *
 * A filesystem path is not detected and cannot work: with no server to mount it, `/home/me/tiles`
 * resolves as a relative URL and answers 404, which is what any wrong URL does.
 */
export function sceneFromQuery(
  q: URLSearchParams,
  warn: (message: string) => void = console.warn,
): QueryScene {
  const out: QueryScene = {};
  const url = q.get("imagery");
  if (url) out.imagery = imageryFrom(url, q, warn);
  const radii = q.get("ellipsoid");
  if (radii) {
    const ellipsoid = ellipsoidFrom(radii, warn);
    if (ellipsoid) out.ellipsoid = ellipsoid;
  }
  return out;
}

/**
 * The layout is read off the URL: a `{z}/{x}/{y}` template is XYZ, and anything else is the
 * directory of a TMS pyramid, which states its own tiling scheme and depth in `tilemapresource.xml`.
 * Those are the two shapes an address can hold, so no third parameter states which one it is.
 */
function imageryFrom(
  url: string,
  q: URLSearchParams,
  warn: (message: string) => void,
): ImagerySpec {
  const layout = url.includes("{z}") ? "xyz" : "tms";
  const spec: ImagerySpec = { url, layout };

  const tiling = q.get("tiling");
  if (tiling !== null) {
    if (tiling !== "geographic" && tiling !== "mercator") {
      warn(`CesiumLink: ignoring ?tiling=${tiling}, which is neither "geographic" nor "mercator"`);
    } else if (layout === "tms") {
      warn(`CesiumLink: ignoring ?tiling=${tiling}; the pyramid at ${url} states its own ` +
        `tiling scheme in tilemapresource.xml`);
    } else {
      spec.tiling = tiling;
    }
  }

  const maxLevel = q.get("maxlevel");
  if (maxLevel !== null) {
    // Digits and nothing else. `Number` reads "", "1e1" and "0x2" as levels, and an empty
    // `?maxlevel=` that arrives as level 0 pins the globe flat without saying a word.
    if (!/^\d+$/.test(maxLevel)) {
      warn(`CesiumLink: ignoring ?maxlevel=${maxLevel}, which is not a whole level`);
      // A TMS pyramid reads its depth from `tilemapresource.xml`, which makes a stated one unusable
      // rather than wrong. Julia drops it in the same silence, for the same reason.
    } else if (layout !== "tms") {
      spec.maxLevel = Number(maxLevel);
    }
  }

  // Third-party tiles usually carry an attribution requirement, and a page that names its basemap
  // in its address has nowhere else to put the notice. The viewer renders a credit as text and
  // never as markup, so one arriving from a query string cannot become an element.
  const credit = q.get("credit");
  if (credit) spec.credit = credit;
  return spec;
}

function ellipsoidFrom(
  radii: string,
  warn: (message: string) => void,
): { a: number; b: number } | undefined {
  const [a, b, ...rest] = radii.split(",").map(Number);
  if (rest.length > 0 || !positive(a) || !positive(b)) {
    warn(`CesiumLink: ignoring ?ellipsoid=${radii}, which is not two positive radii in metres ` +
      `(semi-major first, e.g. ?ellipsoid=1737400,1737400 for the Moon)`);
    return undefined;
  }
  return { a, b };
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
