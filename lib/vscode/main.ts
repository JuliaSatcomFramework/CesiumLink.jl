// The VSCode host: the same Core as the browser host, mounted in a webview.
//
// Three things differ from the browser host, and they are the three questions any non-browser host
// asks. What is the transport (the extension's channel, not a socket). Where are the assets (a
// folder the extension serves, not the page's own origin). How does a declared module get imported
// (the server names it under its own root, which is not this origin).
//
// The extension writes the asset base into the page before this runs.

import "@cesium/engine/Source/Widget/CesiumWidget.css";
import "@cesium/widgets/Source/widgets.css";
import {
  connectAndDeclare,
  createViewer,
  DECLARATION_TIMEOUT_MS,
  loadImagery,
  publish,
  showStale,
  type AssetBase,
  type ViewerModule,
} from "../core/src/index";
import { vsApi } from "./api";
import { rebaseImagery } from "./imagery";
import { MODULE_MOUNT, moduleId, moduleUrl } from "../core/src/modules";
import { VsCodeTransport } from "./transport";
import { installWorkerShim } from "./workers";

const container = document.getElementById("app") as HTMLElement;
// Ends with a slash, and holds the `cesium/` and `modules/` trees the Julia server would serve.
const assetBase = (globalThis as { CESIUM_LINK_ASSET_BASE?: string }).CESIUM_LINK_ASSET_BASE ?? "";
const baseUrl = `${assetBase}cesium/`;
// Every directory the server serves, by mount name, as the webview URI the extension made for it.
// Each ends with a slash. The extension grants the panel one resource root per entry when the panel
// is created, so this map is what the page can reach and nothing else.
//
// It holds two namespaces. An assets mount is under its own name, and a registered module's own
// directory is under `modules/<id>`. An assets mount name is one path element and holds no `/`, so
// the two cannot collide, and `ctx.assetUrl` cannot name a module directory.
const mounts = (globalThis as { CESIUM_LINK_MOUNTS?: Record<string, string> })
  .CESIUM_LINK_MOUNTS ?? {};
// A mount this host can reach, for `ctx.assetUrl`. A directory the extension host could not see is
// absent from the map, and every path into it then resolves to null and warns once.
const mountBase: AssetBase = (name) => mounts[name] ?? null;
// The tile directory, under the reserved mount name. Empty for every scene that declares no
// directory, which is every scene that declares no basemap and every scene whose basemap is a URL.
const imageryBase = mounts.imagery ?? "";

// Nothing in a webview reaches a terminal, and the developer tools of one are two menus deep. So
// the failures that leave a blank page go to the extension, which writes them where the reader is
// already looking. Only these three: they are the ones with no other way out.
function report(line: string): void {
  vsApi().postMessage({ type: "log", line });
}
window.addEventListener("error", (e) => report(`error: ${e.error?.stack ?? e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  report(`rejection: ${(e.reason as Error)?.stack ?? String(e.reason)}`));
document.addEventListener("securitypolicyviolation", (e) =>
  report(`csp: ${e.violatedDirective} <- ${e.blockedURI || "(inline)"}`));

// Before Cesium is built: the widget tessellates terrain in a worker on its first frame.
installWorkerShim(assetBase);
loadImagery(baseUrl);

void start();

async function start(): Promise<void> {
  const t = new VsCodeTransport();
  const { live, declaration, error } = await connectAndDeclare(t);
  if (!live) {
    report(`the extension opened no socket: ${String(error)}`);
  } else if (declaration === null) {
    report(`the server declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
      `showing a WGS84 globe`);
  }

  // The declaration is the only thing that names a basemap here: this host has no address bar, so
  // it takes no `?imagery=` and asks `ignoredByDeclaration` nothing.
  const imagery = declaration?.imagery;
  const handle = await createViewer(container, {
    baseUrl,
    ellipsoid: declaration?.ellipsoid,
    imagery: imagery ? rebaseImagery(imagery, imageryBase) : imagery,
    lighting: declaration?.lighting,
    stars: declaration?.stars,
    namedPlaces: declaration?.namedPlaces,
    countryBorders: declaration?.countryBorders,
    furniture: declaration?.furniture,
    importModule,
    assetBase: mountBase,
    expand,
  });
  publish(handle);
  if (live) {
    // The one way on is a different scene, not this one again: a server that drops has usually
    // stopped, and a restarted one binds a new port, so the address this page was given is dead.
    t.onClose = () => showStale(container,
      "Disconnected — this scene is no longer live. Run “CesiumLink: Pick a scene”.");
    handle.attachTransport(t, declaration);
  }
}

// A webview cannot go full screen: the fullscreen API is absent, and no host shape gets it back. So
// the full-screen button asks the extension for the nearest thing the editor has, which is Zen Mode
// — one editor group, no bars, and the window itself full screen.
function expand(): void {
  vsApi().postMessage({ type: "expand" });
}

// The server declares a module as `/modules/<id>/<id>.js`, a URL under its own root. The extension
// serves the same tree from somewhere else, so the path is kept and the root is replaced — with the
// module's own granted directory when the map names one, and the dist otherwise.
//
// A failure is reported rather than left to the console. The Core warns and loads the rest, which
// is right, but a module missing from the scene with no line anywhere is the most expensive kind of
// silence there is.
function importModule(url: string): Promise<{ default: ViewerModule }> {
  const target = moduleUrl(url, mounts, assetBase);
  return (import(target) as Promise<{ default: ViewerModule }>).catch((err) => {
    report(`module ${url} did not load from ${target}: ${String(err)}`);
    // A module registered after this panel was created has no mount here, and a webview takes its
    // roots when it is created — so this page can never reach that module, however it retries. Name
    // the module to the host, which can build the panel again with the directory granted. Anything
    // the map does name failed for another reason, and reopening would not help it.
    const id = moduleId(url);
    if (id !== undefined && mounts[MODULE_MOUNT(id)] === undefined) {
      vsApi().postMessage({ type: "moduleMissing", id });
    }
    throw err;
  });
}

