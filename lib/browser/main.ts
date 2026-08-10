import "@cesium/engine/Source/Widget/CesiumWidget.css";
import "@cesium/widgets/Source/widgets.css";
import {
  createViewer,
  firstDeclaration,
  loadImagery,
  PROTOCOL_VERSION,
  sceneFromQuery,
  WsTransport,
  type Declaration,
  type ViewerHandle,
} from "../core/src/index";

const container = document.getElementById("app") as HTMLElement;
const baseUrl = "cesium/";

// How long a connected server gets to declare the session before the globe is built on WGS84
// without it. Generous next to any round trip, and short enough that a `?ws` pointing at a server
// that never answers reads as a wait rather than as a broken page.
const DECLARATION_TIMEOUT_MS = 5000;

// The imagery is the same offline texture whatever shape the globe turns out to be, so its fetch
// runs alongside the connection instead of behind it. The container shows the page background —
// black, which is also what Cesium paints behind an empty scene — until the widget exists.
loadImagery(baseUrl);

void start();

async function start(): Promise<void> {
  // ?ws=<url> | ?ws / ?ws=auto (→ same-origin /ws) connect live to a Julia server. There is one
  // inbound path: a viewer with no server declares no modules and shows an empty globe.
  const q = new URLSearchParams(location.search);
  const ws = q.get("ws");
  // ?imagery, ?tiling, ?maxlevel, ?credit and ?ellipsoid build the globe when no server declares
  // one, which makes an interactive globe over any published pyramid a URL and nothing else.
  const asked = sceneFromQuery(q);
  if (ws == null) {
    publish(await createViewer(container, { baseUrl, ...asked }));
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = ws === "" || ws === "auto" ? `${scheme}://${location.host}/ws` : ws;

  const t = new WsTransport(url);
  let live = true;
  let declaration: Declaration | null = null;
  try {
    await t.ready;
  } catch (e) {
    console.error("CesiumLink: WS connect failed", url, e);
    live = false;
  }
  if (live) {
    t.notify("ready", { protocol: PROTOCOL_VERSION });
    console.log("CesiumLink: connected to", url);
    // The globe is built on the ellipsoid the server names, so the coordinates a scene sends and
    // the surface they are drawn on cannot disagree. The declaration also names the furniture, so
    // the first paint shows the set the session asked for. Everything the server replays behind the
    // declaration waits on the transport until the viewer exists to receive it.
    declaration = await firstDeclaration(t, DECLARATION_TIMEOUT_MS);
    if (declaration === null) {
      console.warn(`CesiumLink: ${url} declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
        `showing ${asked.ellipsoid || asked.imagery
          ? "the globe this page's own parameters ask for"
          : "a WGS84 globe"}`);
    }
  }

  // A declared basemap beats the address bar: the server owns the session, and its coordinates are
  // on the shape it names. The parameters fill in only what no declaration states.
  const ignored = [
    asked.imagery && declaration?.imagery !== undefined ? "?imagery" : "",
    asked.ellipsoid && declaration?.ellipsoid !== undefined ? "?ellipsoid" : "",
  ].filter(Boolean);
  if (ignored.length > 0) {
    console.warn(`CesiumLink: ${url} declares the session, so ${ignored.join(" and ")} ` +
      `has no effect on this page.`);
  }
  const handle = await createViewer(container, {
    baseUrl,
    ellipsoid: declaration?.ellipsoid ?? asked.ellipsoid,
    imagery: declaration?.imagery ?? asked.imagery,
    lighting: declaration?.lighting,
    stars: declaration?.stars,
    furniture: declaration?.furniture,
  });
  publish(handle);
  if (live) {
    t.onClose = showStale;
    handle.attachTransport(t, declaration);
  }
}

// A server that stops leaves the scene drawn and interactive, so say that what is on the globe is
// no longer being updated. The page owns this rather than the scene: the server is gone, and a
// server is what declares anything the overlay shows.
function showStale(): void {
  if (document.getElementById("stale")) return;
  const banner = document.createElement("div");
  banner.id = "stale";
  banner.textContent = "Disconnected — this scene is no longer live. Reload to reconnect.";
  banner.setAttribute("style",
    "position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:10;" +
    "padding:6px 12px;border-radius:6px;background:rgba(120,20,20,0.88);color:#fff;" +
    "font:13px/1.4 system-ui,sans-serif;pointer-events:none");
  container.appendChild(banner);
}

function publish(handle: ViewerHandle): void {
  (globalThis as Record<string, unknown>).viewer = handle;
}
