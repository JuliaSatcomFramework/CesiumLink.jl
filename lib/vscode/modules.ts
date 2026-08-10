// Where a declared module is imported from, inside a webview.
//
// The server declares a module as `/modules/<id>/<file>`, a URL under its own root. The page is not
// served from that root, so the root is replaced — the move `rebaseImagery` makes for a tile
// directory. Which root, though, depends on where the module lives: one vendored in the viewer dist
// is under the dist, and one shipped from its own package is a directory of its own that the
// extension grants the panel and names in the mount map.
//
// Assuming the dist for both is what left the panel unable to run any third-party module at all.

/** How a module directory is keyed in the mount map. An assets mount name holds no `/`, so the two
 * namespaces cannot collide. */
export const MODULE_MOUNT = (id: string): string => `modules/${id}`;

const DECLARED = /^\/?modules\/([^/]+)\/(.+)$/;

/**
 * The URL this host imports a declared module from.
 *
 * `mounts` maps a mount name to its base, each ending in a slash. `distBase` ends in one too, and
 * stands for the built viewer tree. A module the map names is imported from its own directory;
 * anything else keeps its path under the dist, which is where a vendored module is.
 */
export function moduleUrl(
  url: string,
  mounts: Record<string, string>,
  distBase: string,
): string {
  const m = DECLARED.exec(url);
  const base = m ? mounts[MODULE_MOUNT(m[1])] : undefined;
  return base === undefined ? distBase + url.replace(/^\//, "") : base + m![2];
}
