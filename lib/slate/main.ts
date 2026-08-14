// The KaimonSlate host: the same Core as the browser host, mounted in a notebook cell.
//
// Three things differ from the browser host, and they are the three questions any non-browser host
// asks. What is the transport (the notebook's own page socket, not a socket of ours). Where are the
// assets (a route Slate serves for the package, not the page's own origin). How does a declared
// module get imported (the server names it under its own root, which is not this origin).
//
// This entry exports a function instead of running on load: a cell mounts it, and one page may hold
// several cells. `lib/slate/component.js` is the small module Slate injects, and it calls this.

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

// Slate serves a package's declared directories under this route, and the notebook page is on the
// same origin — so a worker needs no shim here, unlike in a webview.
const EXT_ASSETS = "/ext-assets/";
// The built viewer tree, declared by the extension under the package's own name.
const DIST = `${EXT_ASSETS}CesiumLink/`;
// A directory the Julia server serves, by mount name. The extension declares one Slate route per
// mount, named by this rule, so the page needs no map and nothing goes stale when a scene adds one.
const mountBase: AssetBase = (name) => `${EXT_ASSETS}CesiumLink-mount-${name}/`;

/**
 * Draw the scene on `channel` into `container`. Resolves once the viewer is built and attached, and
 * gives back the call that takes it down again.
 *
 * A cell that re-runs or is deleted takes its element out of the page. The viewer that drew into it
 * keeps its render loop and its WebGL context until something destroys it, and a browser holds only
 * so many contexts — so the caller owes this call whenever the element goes.
 *
 * The bootstrap is the Core's, the same one the browser host and the VSCode host run. What stays
 * here is the sentence: this host's reader is a notebook author, and the console is where they
 * look. A Slate channel is already open, so `live` is never false and there is nothing to report
 * about the connection itself.
 */
export async function mount(container: HTMLElement, channel: string): Promise<() => void> {
  loadImagery(`${DIST}cesium/`);
  const t = new SlateTransport(channel);
  const { declaration } = await connectAndDeclare(t);
  if (declaration === null) {
    console.warn(`CesiumLink: the server declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
      `showing a WGS84 globe`);
  }
  const handle = await createViewer(container, {
    baseUrl: `${DIST}cesium/`,
    ellipsoid: declaration?.ellipsoid,
    imagery: declaration?.imagery,
    lighting: declaration?.lighting,
    stars: declaration?.stars,
    furniture: declaration?.furniture,
    importModule,
    assetBase: mountBase,
  });
  handle.attachTransport(t, declaration);
  // The Core destroys everything the Core built. The transport is the host's, so the host closes it.
  return () => {
    handle.destroy();
    t.close();
  };
}

// The server declares a module as `/modules/<id>/<id>.js`, a URL under its own root. The extension
// declares a Slate route for every module the server holds, named after the module, so the path is
// kept and the root is replaced. A module the extension has not declared falls back to the dist,
// which is where a vendored module lives.
function importModule(url: string): Promise<{ default: ViewerModule }> {
  const id = moduleId(url);
  const mounts = id === undefined ? {} : { [MODULE_MOUNT(id)]: `${EXT_ASSETS}CesiumLink-module-${id}/` };
  return import(moduleUrl(url, mounts, DIST)) as Promise<{ default: ViewerModule }>;
}
