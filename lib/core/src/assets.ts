// Resolving `assets/<mount>/<file>` — the path a payload carries — into a URL this host can fetch.
//
// The Core never reads inside a payload, so it cannot rewrite a path for a module; the module cannot
// build the URL either, because the three hosts disagree about where a mount is. A browser page is
// served by the server itself, so the declared path already resolves. A webview page lives at an
// origin that holds no files, and every root the extension grants it gets its own opaque URI. A
// recording player has no server at all and is told a base, or nothing.
//
// So the Core holds the map the declaration carries, the host says where each mount is, and this is
// where the two meet (ADR-0021).

/** What the `modules` declaration carries: mount name to the same-origin base it answers. */
export type AssetMounts = Record<string, string>;

/** Where a host fetches one mount from — a base ending in a slash — or null when it cannot reach it. */
export type AssetBase = (name: string) => string | null;

const PATH = /^assets\/([^/]+)\/(.*)$/;

/**
 * Build the `ctx.assetUrl` every module is handed. `mounts` is read live, because the declaration
 * arrives after the viewer is built. `base` is the host's own resolver; a host that omits it is
 * served by the server, and a declared path is returned unchanged.
 *
 * An unresolvable path answers null and warns, and the family draws what it can. It never throws: a
 * throw inside a window callback takes down more than the one family that asked.
 */
export function createAssetUrl(
  mounts: () => AssetMounts,
  base: AssetBase | undefined,
  warn: (message: string) => void = (m) => console.warn(m),
): (path: string) => string | null {
  // A model family asks once per entity per tick, so a bad path would otherwise warn every frame
  // forever. One line per distinct path is enough to find it.
  const warned = new Set<string>();
  const once = (path: string, why: string): null => {
    if (!warned.has(path)) {
      warned.add(path);
      warn(`CesiumLink: ${why}: ${path}`);
    }
    return null;
  };
  return (path: string): string | null => {
    const m = PATH.exec(path);
    if (!m) return once(path, "an asset path is `assets/<mount>/<file>`");
    const [, name, rest] = m;
    if (!(name in mounts())) {
      return once(path, `this session declares no assets mount named ${JSON.stringify(name)}`);
    }
    if (!base) return path;
    const at = base(name);
    if (at === null) {
      return once(path, `this host cannot reach the assets mount ${JSON.stringify(name)}`);
    }
    return at + rest;
  };
}
