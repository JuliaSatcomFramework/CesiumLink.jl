// Where one customizable thing comes from, read off its name.
//
// A vendored module draws its stock things — a node sprite, an edge material — from a closed list it
// owns. A third-party package cannot add to a closed list, so it has to copy the whole module to
// change one glyph. One naming rule opens those lists: the first token of the name says where the
// thing comes from, and the four forms cannot collide.
//
// No form names a remote URL. The webview serves the page under `default-src 'none'`, and its
// `img-src` admits `data:` and its own origin only. An image fetched from another origin draws in a
// browser tab and draws nothing at all in an editor tab (`primitives/src/sprites.ts`). A server
// declares the few off-site origins it trusts for a basemap, and that set is fixed for the session.
//
// This sits in the Core because the Core already owns the `assets/` prefix (`assets.ts`). A second
// package that re-spelled that prefix would drift from it. It stays string work only: it imports no
// Cesium and holds no state, the same as `moduleId` in `modules.ts`. Each seam still resolves its
// own kind, because a sprite ends as an image and a material ends as a Cesium `Material`.

/** The four forms a customizable name can take. */
export type Source =
  | { kind: "data"; uri: string }
  | { kind: "asset"; path: string }
  | { kind: "module"; name: string }
  | { kind: "stock"; name: string };

/**
 * Read which form a name takes. It never throws: a caller that gets a kind it cannot resolve warns
 * and falls back to its stock default.
 *
 * A stock name holds no `.` and no `/`. A module name holds a `.` and no `/`. Assert the stock half
 * where a stock table is declared.
 *
 * A `/` name that is not an `assets/<mount>/<file>` path still reads as an asset, so the caller
 * reports it as the malformed asset path it is instead of as a name nobody registered.
 */
export function sourceOf(s: string): Source {
  // Read a `data:` URI first. A URI scheme can hold any character after it, so no test of shape
  // separates a data URI from the other three forms.
  // The other three forms differ in shape, so the order of their tests does not matter. An asset
  // path always holds a `/`. A stock name and a module name never hold one.
  if (s.startsWith("data:")) return { kind: "data", uri: s };
  if (s.includes("/")) return { kind: "asset", path: s };
  if (s.includes(".")) return { kind: "module", name: s };
  return { kind: "stock", name: s };
}
