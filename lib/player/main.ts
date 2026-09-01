// A viewer that plays a recorded session with no server behind it.
//
//   player.html?rec=<url>[&speed=<n>][&modules=<base>][&assets=<base>]
//              [&imagery=<url>][&tiling=geographic|mercator][&maxlevel=<n>][&credit=<text>][&ellipsoid=<a>,<b>]
//
// The first four say where files are, which no recording can know. The rest restate the scene and
// beat what the recording states, which is how a basemap that did not travel with the file is named
// again (ADR-0024).
//
// The page is standalone, so a documentation page embeds it in an iframe rather than importing it.
// What works and what does not is stated in lib/core/src/recording.ts.
import "@cesium/engine/Source/Widget/CesiumWidget.css";
import "@cesium/widgets/Source/widgets.css";
import {
  createViewer,
  fetchRecording,
  loadImagery,
  publish,
  RecordingTransport,
  sceneFromQuery,
  type AssetBase,
} from "../core/src/index";

const container = document.getElementById("app") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const baseUrl = "cesium/";

loadImagery(baseUrl);

void start();

async function start(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const rec = q.get("rec");
  if (rec == null) {
    fail("no recording named. Add ?rec=<url> to this page's address.");
    return;
  }
  const speed = q.get("speed") === null ? undefined : Number(q.get("speed"));
  const modulesBase = q.get("modules") ?? undefined;
  // Where the folders the recorded session served were copied to. `assets/<mount>/<file>` is what a
  // payload names, so a mount is a directory under this base. A page given none reaches no mount at
  // all, and a family that wanted one draws what it can.
  const assetsBase = q.get("assets");
  const assetBase: AssetBase | undefined =
    assetsBase === null ? undefined : (name) => `${assetsBase.replace(/\/?$/, "/")}${name}/`;
  const asked = sceneFromQuery(q);

  let transport: RecordingTransport;
  try {
    transport = new RecordingTransport(await fetchRecording(rec), {
      speed, modulesBase, ...asked,
      onWarn: (m) => console.warn(m),
    });
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
    return;
  }

  // Cesium builds the globe before the first payload is decoded, so it is built from the
  // declaration the recording states, with the query string over the top (ADR-0024). A basemap the
  // recorded server mounted is the one thing the file cannot carry: without `?imagery=` naming
  // where those tiles went, the globe wears the widget's bundled Earth texture.
  const scene = transport.declaration;
  const handle = await createViewer(container, {
    baseUrl,
    assetBase,
    ellipsoid: scene.ellipsoid,
    imagery: scene.imagery,
    lighting: scene.lighting,
    stars: scene.stars,
    namedPlaces: scene.namedPlaces,
    countryBorders: scene.countryBorders,
    regionBorders: scene.regionBorders,
    // Before the first paint, so the page never flashes the default set on its way to the recorded
    // one. The retained `core/furniture` command arrives behind it and says the same thing.
    furniture: scene.furniture,
  });
  publish(handle);
  handle.attachTransport(transport, transport.declaration);
  status.hidden = true;
}

function fail(message: string): void {
  status.className = "failed";
  status.textContent = `The recording did not play: ${message}`;
  console.error("player:", message);
}
