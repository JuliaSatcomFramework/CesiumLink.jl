// A declared basemap, made to load inside a webview.
//
// A server that mounts a tile directory declares it as `assets/imagery/`, a URL under the server's
// own root. The page is not served from that root, so the path is kept and the root is replaced.
// This is the move `importModule` makes for a declared module, and the extension gives the page the
// second base it needs.
//
// A declared absolute URL travels untouched. It is already where it says it is, and the extension
// names its origin in the page's `img-src` and `connect-src`.

import type { ImagerySpec } from "../core/src/index.ts";

// What a mounted tile directory declares itself as. The `assets/` prefix is optional so a recording
// made before every served directory became a named mount still rebases: a recording carries the
// declaration it was made with, and that one said `imagery/`.
const MOUNT_PREFIX = /^\/?(?:assets\/)?imagery\/?/;

/**
 * The declared basemap set, with every relative URL resolved against `base`. One object is a set of
 * one, so the answer is always a list.
 *
 * `base` ends with a slash and stands for the server's own `assets/imagery/` mount. An empty `base`
 * is a server that declared a directory this host was not told about — the extension reads the
 * directory from the discovery file, and a scene that writes none leaves the URL as it stands.
 */
export function rebaseImagery(
  imagery: ImagerySpec | ImagerySpec[],
  base: string,
): ImagerySpec[] {
  const set = Array.isArray(imagery) ? imagery : [imagery];
  return set.map((spec) => rebaseOne(spec, base));
}

// The bundled entry carries no URL: the page builds the one it answers on from `CESIUM_BASE_URL`,
// so there is nothing here to rebase.
function rebaseOne(spec: ImagerySpec, base: string): ImagerySpec {
  if (spec.bundled || base === "" || /^[a-z][a-z0-9+.-]*:/i.test(spec.url)) return spec;
  return { ...spec, url: base + spec.url.replace(MOUNT_PREFIX, "") };
}
