// Where a declared module is imported from, for a host that the server does not serve.
//
// The server declares a module as `/modules/<id>/<file>`, a URL under its own root. A webview page
// and a notebook cell are on an origin that holds none of those files, so the host replaces the
// root. `rebaseImagery` makes the same move for a tile directory. The new root depends on where the
// module is. A module vendored in the viewer dist is under the dist. A module that comes with its
// own package is a directory of its own, which the host serves and names in the mount map.
//
// While it assumed the dist for both, the VSCode panel could not run any third-party module at all.
// This file sits beside `assets.ts` because the two answer the same question for the same reason
// (ADR-0021): the Core holds what the declaration carries, and the host says where a mount is.

/** How a module directory is keyed in the mount map. An assets mount name holds no `/`, so the two
 * namespaces cannot collide. */
export const MODULE_MOUNT = (id: string): string => `modules/${id}`;

const DECLARED = /^\/?modules\/([^/]+)\/(.+)$/;

/** The id a declared module URL names, or `undefined` for a URL that declares no module. */
export function moduleId(url: string): string | undefined {
  return DECLARED.exec(url)?.[1];
}

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
