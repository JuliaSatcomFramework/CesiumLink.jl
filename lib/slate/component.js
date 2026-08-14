// The Slate component a rendered `Server` mounts. Slate injects this module's text into the page,
// so it holds a mount point and nothing more: the viewer bundle is tens of megabytes and is served
// from the route the extension declares for the package.
//
// `params.channel` is the channel this scene's frames ride, and `params.height` is the cell's height
// in CSS pixels.
import { html } from "@slate/widget";

// Against the page, not against this module: Slate may inject a component as a `data:` module, and
// such a module has no base URL — a root-relative specifier then resolves to nothing at all.
const HOST = new URL("/ext-assets/CesiumLink/slate.js", location.href).href;

export default ({ params }) => html`
  <div
    style="width:100%;height:${params.height ?? 520}px;position:relative;background:#000"
    ref=${(el) => mount(el, params.channel)}
  ></div>`;

// Preact calls a ref again on every render of the component, and a cell may render several times per
// mount. The flag is what keeps one viewer per element.
async function mount(el, channel) {
  if (!el || el.dataset.cesiumlink) return;
  el.dataset.cesiumlink = channel;
  try {
    // Cesium's widget styles ride the bundle as a sibling stylesheet, and a notebook page has no
    // <head> of ours to declare it in. One link per page: the widget is unusable without it.
    if (!document.getElementById("cesiumlink-css")) {
      const link = document.createElement("link");
      link.id = "cesiumlink-css";
      link.rel = "stylesheet";
      link.href = HOST.replace(/\.js$/, ".css");
      document.head.appendChild(link);
    }
    const host = await import(HOST);
    await host.mount(el, channel);
  } catch (e) {
    // A notebook cell has nowhere else to show this: the bundle is served by Slate on the package's
    // behalf, so a failure here is a mount that is missing rather than a scene that is empty.
    el.textContent = `CesiumLink: the viewer did not load from ${HOST} — ${e}`;
  }
}
