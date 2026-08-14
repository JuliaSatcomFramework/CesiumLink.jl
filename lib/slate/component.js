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
    ref=${(el) => (el ? mount(el, params.channel) : queueMicrotask(sweep))}
  ></div>`;

// The viewer drawn into each element, by that element. A cell that re-runs or is deleted takes its
// element out of the page, and the viewer that drew into it keeps its render loop and its WebGL
// context until it is destroyed. A browser holds only so many of those contexts, and it drops the
// oldest to make room — so a leaked viewer eventually costs a live one its picture.
const mounted = new Map();

// Take down every viewer whose element has left the page. This runs rather than a teardown on the
// ref's `null`, because Preact passes `null` on every re-render as well as on unmount: the element
// being gone from the document is what says the viewer is no longer wanted.
function sweep() {
  for (const [el, viewer] of mounted) {
    if (document.contains(el)) continue;
    mounted.delete(el);
    viewer.then((destroy) => destroy?.(), () => {});
  }
}

// Preact calls a ref again on every render of the component, and a cell may render several times per
// mount. The flag is what keeps one viewer per element. The viewer is recorded before it is built,
// so a sweep during the load still finds it.
function mount(el, channel) {
  sweep();
  if (el.dataset.cesiumlink) return;
  el.dataset.cesiumlink = channel;
  const viewer = build(el, channel);
  mounted.set(el, viewer);
  // Sweep again once this viewer is up. Slate swaps a cell's output in an order of its own, and the
  // element the previous viewer drew into can still be in the page at the moment this one starts —
  // by the time this one is drawing, it has gone.
  viewer.then(sweep, sweep);
}

// Build the viewer, and give back the call that takes it down.
async function build(el, channel) {
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
    return await host.mount(el, channel);
  } catch (e) {
    // A notebook cell has nowhere else to show this: the bundle is served by Slate on the package's
    // behalf, so a failure here is a mount that is missing rather than a scene that is empty.
    el.textContent = `CesiumLink: the viewer did not load from ${HOST} — ${e}`;
  }
}
