// The Slate component that a rendered `Server` mounts. Slate puts the text of this module into the
// page, so the module holds a mount point and nothing more. The viewer bundle is tens of megabytes,
// and Slate serves it from the route that the extension declares for the package.
//
// `params.channel` is the channel that carries the frames of this scene. `params.height` is the
// height of the cell in CSS pixels.
import { html } from "@slate/widget";

// Resolve against the page, and not against this module. Slate can put a component into the page as
// a `data:` module, and such a module has no base URL. A specifier that starts at the root then
// resolves to nothing.
const HOST = new URL("/ext-assets/CesiumLink/slate.js", location.href).href;

export default ({ params }) => html`
  <div
    style="width:100%;height:${params.height ?? 520}px;position:relative;background:#000"
    ref=${(el) => (el ? mount(el, params.channel) : queueMicrotask(sweep))}
  ></div>`;

// The viewer for each element, keyed by that element. A cell that runs again, or that is deleted,
// removes its element from the page. The viewer keeps its render loop and its WebGL context until
// something destroys it. A browser holds only a small number of those contexts, and it drops the
// oldest one to make room. A viewer that stays thus takes the picture from a live viewer.
const mounted = new Map();

// Destroy each viewer whose element is no longer in the page. A teardown on the `null` of the ref
// does not work, because Preact gives `null` at each render and not only at unmount. The absence of
// the element from the document is the signal that the viewer is no longer necessary.
function sweep() {
  for (const [el, viewer] of mounted) {
    if (document.contains(el)) continue;
    mounted.delete(el);
    viewer.then((destroy) => destroy?.(), () => {});
  }
}

// Preact calls a ref again at each render of the component, and a cell can render several times for
// one mount. The flag keeps one viewer for each element. The map records the viewer before the build
// starts, so a sweep during the load finds it.
function mount(el, channel) {
  sweep();
  if (el.dataset.cesiumlink) return;
  el.dataset.cesiumlink = channel;
  const viewer = build(el, channel);
  mounted.set(el, viewer);
  // Sweep again when this viewer is up. Slate replaces the output of a cell in its own order. The
  // element of the previous viewer can still be in the page when this viewer starts, but it is gone
  // when this viewer draws.
  viewer.then(sweep, sweep);
}

// Build the viewer, and give back the call that takes it down.
async function build(el, channel) {
  try {
    // The Cesium widget styles come with the bundle as a sibling stylesheet, and a notebook page
    // has no <head> of ours to declare them in. Add one link for each page. The widget does not
    // work without it.
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
    // A notebook cell has no other place to show this. Slate serves the bundle for the package, so
    // a failure here means a mount that is absent, and not a scene that is empty.
    el.textContent = `CesiumLink: the viewer did not load from ${HOST} — ${e}`;
  }
}
