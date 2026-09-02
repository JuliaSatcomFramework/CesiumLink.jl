// The KaimonSlate host: the same Core as the browser host, mounted in a notebook cell.
//
// Three things are different from the browser host. They are the three questions that each
// non-browser host answers:
//   - Which transport? The page socket of the notebook, and not a socket of ours.
//   - Where are the assets? A route that Slate serves for the package, and not the page's origin.
//   - How is a declared module imported? The server names it under its own root, which is not this
//     origin.
//
// This entry exports a function and does not run at load, because a cell mounts it, and one page can
// hold several cells. `lib/slate/component.js` is the small module that Slate puts into the page,
// and it calls this function.

import "@cesium/engine/Source/Widget/CesiumWidget.css";
import "@cesium/widgets/Source/widgets.css";
import {
  connectAndDeclare,
  createViewer,
  DECLARATION_TIMEOUT_MS,
  loadImagery,
  type AssetBase,
  type ViewerModule,
} from "../core/src/index";
import { MODULE_MOUNT, moduleId, moduleUrl } from "../core/src/modules";
import { SlateTransport } from "./transport";

// Slate serves the declared directories of a package under this route, and the notebook page is on
// the same origin. A worker thus needs no shim here, but a worker in a webview does.
const EXT_ASSETS = "/ext-assets/";
// The built viewer tree, declared by the extension under the package's own name.
const DIST = `${EXT_ASSETS}CesiumLink/`;
// A directory that the Julia server serves, by mount name. The extension declares one Slate route
// for each mount, with the name that this rule makes. The page thus needs no map, and nothing
// becomes stale when a scene adds a mount.
const mountBase: AssetBase = (name) => `${EXT_ASSETS}CesiumLink-mount-${name}/`;

/**
 * Draw the scene on `channel` into `container`. Resolves when the viewer is built and attached, and
 * gives back the call that destroys it.
 *
 * Make that call when the element leaves the page. A cell that runs again, or that is deleted,
 * removes its element. The viewer keeps its render loop and its WebGL context until something
 * destroys it, and a browser holds only a small number of contexts.
 *
 * The bootstrap is the one in the Core, which the browser host and the VSCode host also run. Only
 * the message stays here, because the reader of this host is a notebook author, and that author
 * looks at the console. A Slate channel is already open, so `live` is never false, and there is
 * nothing to report about the connection.
 */
export async function mount(container: HTMLElement, channel: string): Promise<() => void> {
  loadImagery(`${DIST}cesium/`);
  const t = new SlateTransport(channel);
  let handle: Awaited<ReturnType<typeof createViewer>> | undefined;
  // A build that fails leaves the caller with no call to make, so take the transport down here.
  // Slate holds one stream handler for each channel, and a cell that runs again would otherwise
  // add one more handler at each run.
  try {
    const { declaration } = await connectAndDeclare(t);
    if (declaration === null) {
      console.warn(`CesiumLink: the server declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
        `showing a WGS84 globe`);
    }
    handle = await createViewer(container, {
      baseUrl: `${DIST}cesium/`,
      ellipsoid: declaration?.ellipsoid,
      imagery: declaration?.imagery,
      lighting: declaration?.lighting,
      stars: declaration?.stars,
      namedPlaces: declaration?.namedPlaces,
      countryBorders: declaration?.countryBorders,
      furniture: declaration?.furniture,
      importModule,
      assetBase: mountBase,
    });
    handle.attachTransport(t, declaration);
  } catch (e) {
    handle?.destroy();
    t.close();
    throw e;
  }
  // The Core destroys all that the Core built. The transport belongs to the host, so the host
  // closes it.
  const built = handle;
  return () => {
    built.destroy();
    t.close();
  };
}

// The server declares a module as `/modules/<id>/<id>.js`, a URL under its own root. The extension
// declares a Slate route for each module that the server holds, with the name of the module. The
// path thus stays, and only the root changes. A module that the extension does not declare falls
// back to the dist, where a vendored module is.
function importModule(url: string): Promise<{ default: ViewerModule }> {
  const id = moduleId(url);
  const mounts = id === undefined ? {} : { [MODULE_MOUNT(id)]: `${EXT_ASSETS}CesiumLink-module-${id}/` };
  return import(moduleUrl(url, mounts, DIST)) as Promise<{ default: ViewerModule }>;
}
