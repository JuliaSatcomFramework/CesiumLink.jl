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
  createViewer,
  firstDeclaration,
  loadImagery,
  PROTOCOL_VERSION,
  type AssetBase,
  type Declaration,
  type ViewerHandle,
  type ViewerModule,
} from "../core/src/index";
import { vsApi } from "./api";
import { rebaseImagery } from "./imagery";
import { moduleUrl } from "./modules";
import { VsCodeTransport } from "./transport";
import { installWorkerShim } from "./workers";

// How long a connected server gets to declare the session before the globe is built on WGS84
// without it. The same wait the browser host gives, and generous next to the channel's own cost.
const DECLARATION_TIMEOUT_MS = 5000;

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
  let live = true;
  try {
    await t.ready;
  } catch (e) {
    report(`the extension opened no socket: ${String(e)}`);
    live = false;
  }

  let declaration: Declaration | null = null;
  if (live) {
    t.notify("ready", { protocol: PROTOCOL_VERSION });
    // The globe is built on the ellipsoid the server names, and the first paint shows the furniture
    // the session asked for. Everything the server replays behind the declaration waits on the
    // transport until the viewer exists to receive it.
    declaration = await firstDeclaration(t, DECLARATION_TIMEOUT_MS);
    if (declaration === null) {
      report(`the server declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
        `showing a WGS84 globe`);
    }
  }

  // The declaration is the only thing that names a basemap here: this host has no address bar, so
  // it takes no `?imagery=`.
  const imagery = declaration?.imagery;
  const handle = await createViewer(container, {
    baseUrl,
    ellipsoid: declaration?.ellipsoid,
    imagery: imagery ? rebaseImagery(imagery, imageryBase) : imagery,
    lighting: declaration?.lighting,
    stars: declaration?.stars,
    furniture: declaration?.furniture,
    importModule,
    assetBase: mountBase,
    expand,
  });
  publish(handle);
  if (live) {
    t.onClose = showStale;
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
    throw err;
  });
}

// A server that stops leaves the scene drawn and interactive, so say that what is on the globe is
// no longer being updated. The one way on is a different scene, not this one again: a server that
// drops has usually stopped, and a restarted one binds a new port, so the address this page was
// given is dead.
function showStale(): void {
  if (document.getElementById("stale")) return;
  const banner = document.createElement("div");
  banner.id = "stale";
  banner.textContent =
    "Disconnected — this scene is no longer live. Run “CesiumLink: Pick a scene”.";
  banner.setAttribute("style",
    "position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:10;" +
    "padding:6px 12px;border-radius:6px;background:rgba(120,20,20,0.88);color:#fff;" +
    "font:13px/1.4 system-ui,sans-serif;pointer-events:none");
  container.appendChild(banner);
}

function publish(handle: ViewerHandle): void {
  (globalThis as Record<string, unknown>).viewer = handle;
}
