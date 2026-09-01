import "@cesium/engine/Source/Widget/CesiumWidget.css";
import "@cesium/widgets/Source/widgets.css";
import {
  connectAndDeclare,
  createViewer,
  DECLARATION_TIMEOUT_MS,
  ignoredByDeclaration,
  loadImagery,
  publish,
  sceneFromQuery,
  showStale,
  WsTransport,
} from "../core/src/index";

const container = document.getElementById("app") as HTMLElement;
const baseUrl = "cesium/";

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
    // No server means no window and no clock, so the three time items have nothing to say. They are
    // left out for the same reason `cameraFollow` hides itself until a viewpoint arrives.
    publish(await createViewer(container, {
      baseUrl,
      ...asked,
      furniture: { items: { timeline: false, animation: false, keyframe: false } },
    }));
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = ws === "" || ws === "auto" ? `${scheme}://${location.host}/ws` : ws;

  const t = new WsTransport(url);
  const { live, declaration, error } = await connectAndDeclare(t);
  if (!live) {
    console.error("CesiumLink: WS connect failed", url, error);
  } else {
    console.log("CesiumLink: connected to", url);
    if (declaration === null) {
      console.warn(`CesiumLink: ${url} declared no session within ${DECLARATION_TIMEOUT_MS} ms; ` +
        `showing ${asked.ellipsoid || asked.imagery
          ? "the globe this page's own parameters ask for"
          : "a WGS84 globe"}`);
    }
  }

  const ignored = ignoredByDeclaration(asked, declaration);
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
    namedPlaces: declaration?.namedPlaces,
    countryBorders: declaration?.countryBorders,
    regionBorders: declaration?.regionBorders,
    furniture: declaration?.furniture,
  });
  publish(handle);
  if (live) {
    // This page keeps its address, and the server it names may be started again on the same port.
    t.onClose = () => showStale(container,
      "Disconnected — this scene is no longer live. Reload to reconnect.");
    handle.attachTransport(t, declaration);
  }
}
