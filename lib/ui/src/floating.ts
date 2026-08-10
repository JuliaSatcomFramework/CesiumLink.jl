// Floating objects: a declared box at a point on screen rather than in one of the overlay's corner
// regions. The declaration is the whole set, addressed by id, so a float goes away by being declared
// without and a client connecting later is replayed the set as it stands. Nothing about a float is
// remembered on the server beyond the declaration itself.
//
// `ui` owns the box — placement, chrome, the close affordance, the lifetime. What goes inside it is
// one of two kinds, and the isolation is what they differ in:
//
//   `html`   a server-authored fragment in its own shadow root, as a tooltip fragment is: its
//            `<style>` reaches nothing else, and no `<script>` in it ever runs.
//   `mount`  a plain element handed to a named module, which owns everything in it. Plain, not
//            shadowed, because a library that installs its stylesheet in `document.head` gets
//            nothing of it across a shadow boundary.
//
// An `adjustable` float is the one thing here the user decides rather than the declaration. A drag
// or a resize re-anchors the box to the screen, pins its size, and tells the server once on release.
// From then on that box ignores what a later declaration says about its anchor and its size, so a
// declaration already in flight when the pointer came up cannot snap it back. The box keeps that
// until it leaves the page: a float dropped from the declared set and declared again comes back
// where the declaration puts it.
//
// The mount contract below is deliberately not float-specific: any `ui` content site with a stable
// identity can hand a module a box on the same terms. A float is its one call site today.
//
// Pure DOM, no Cesium: where an anchor sits on screen is resolved by the caller and handed in, so
// placement, reconciliation and the mount lifecycle unit-test without WebGL.

import { place } from "./tooltip.ts";
import { applyStyle, el, PANEL, type Report, type Track } from "./widgets.ts";

/** Where a float sits: a point on screen, an entity some module owns, or a point on the globe. */
export type Anchor =
  | { anchor: "screen"; x: number; y: number }
  | { anchor: "entity"; module: string; kind: string; idx: number }
  | { anchor: "world"; lon: number; lat: number; height: number };

/**
 * What `ui` hands a module it mounts: the box, the identity of the site being filled, and the way
 * upward. **`ui` owns the box, the module owns everything inside it, and neither reaches across.**
 */
export interface MountSite {
  /** The element the module fills. Its contents are the module's alone.  */
  el: HTMLElement;
  /** The id of the site — a float's id — so a module filling two of them tells them apart. */
  id: string;
  /**
   * Report as the site itself: the same id and the same `ui/control` event a built-in widget sends,
   * so what filled it is indistinguishable on the Julia side.
   */
  report: Report;
}

/** What a mounted module hands back, so `ui` can drive the box it owns. */
export interface Mount {
  /**
   * The box was declared again and may now be a different size. A library that does not reflow on
   * its own is told here; one that does needs no `resize` at all.
   */
  resize?(): void;
  /** Take down everything the module put in the box. Called before the box leaves the page. */
  dispose?(): void;
}

/**
 * The export that makes a module mountable: `ui` calls `mount(site)` and drives what it returns.
 * A module that exports no `mount` cannot fill a content site, and one naming it renders nothing.
 */
export type MountFactory = (site: MountSite) => Mount | void;

/** One declared float, as it arrives on the wire. */
interface FloatSpec {
  id?: unknown;
  anchor?: unknown;
  html?: unknown;
  mount?: unknown;
  closable?: unknown;
  adjustable?: unknown;
  keyframed?: unknown;
  style?: unknown;
  [field: string]: unknown;
}

/** Where a box sits and how big it is, in whole container pixels. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A float on screen: what it was declared as, the box it owns, and what is inside it. */
interface Live {
  spec: FloatSpec;
  /** The declared spec, verbatim: a float whose spec is unchanged is left exactly where it is. */
  json: string;
  /** What the box holds, so a re-declaration knows whether the content can be reused. */
  key: string;
  box: HTMLElement;
  /** What the box holds, under the drag strip: the element an adjustable box scrolls. */
  inner: HTMLElement;
  /** Where an `html` float's fragment goes; null for a mounted one. */
  root: ShadowRoot | null;
  mount: Mount | null;
  close: HTMLElement | null;
  /** The drag handle of an adjustable box; null for one the user may not move. */
  strip: HTMLElement | null;
  anchor: Anchor | null;
  /**
   * Where the user put this box, once they have moved or resized it. It beats the anchor and the
   * size of every later declaration for as long as the box lives, so a declaration already in
   * flight when the pointer came up cannot snap the box back.
   */
  rect: Rect | null;
}

export interface Floats {
  /** Apply one `ui/floating` command: the whole declared set, in order. */
  declare(payload: unknown): void;
  /** The keyframed fields of every declared float, for the window that addresses them by id. */
  tracks(): Track[];
  /** Put every box where its anchor is now; one that does not resolve hides its box. */
  reposition(): void;
  destroy(): void;
}

export interface FloatDeps {
  container: HTMLElement;
  /** Where `anchor` sits in container coordinates now, or null when it does not resolve. */
  screenOf(anchor: Anchor): { x: number; y: number } | null;
  /** The mount factory a module exports, or null when nothing loaded under that id exports one. */
  mountOf(module: string): MountFactory | null;
  /** Report upward, as `ui` itself: the close affordance and a mounted module both travel this way. */
  notify(topic: string, payload: unknown): void;
}

// Takes the pointer, unlike the tooltip: a float carries a close affordance and may carry a module
// that is interacted with.
const BOX = "position:absolute;z-index:6;pointer-events:auto;max-width:480px";

// Sits over the box's own top-right padding, so it costs the content no layout. On an adjustable
// box it goes in the drag strip instead, which reserves that row already.
const CLOSE = "position:absolute;top:1px;right:5px;cursor:pointer;line-height:1;opacity:0.65";

// What an adjustable box wears over its chrome: the browser's own resize grip in the bottom-right
// corner, room at the top for the drag strip, and a floor under the size so a box cannot be shrunk
// to nothing. `box-sizing` makes the width the browser writes the width that reads back.
//
// `overflow` must not be `visible` or the corner does not resize at all. It is `hidden` rather than
// `auto` because the box must not scroll: the content element below is what scrolls, so the bar
// stands beside the text and leaves the drag strip its full width. The box owns its top padding row
// instead of `PANEL`'s, because the drag strip stands in that row and bleeds to the box's edges.
const ADJUSTABLE = "resize:both;overflow:hidden;box-sizing:border-box;" +
  "max-width:none;min-width:80px;min-height:48px;padding-top:0";

// The drag handle across the top of an adjustable box, and the gap under it. It captures the
// pointer for the whole drag, so a drag that wanders over the globe never reaches Cesium's canvas.
//
// It is the box's first child and it does not scroll, so it keeps the box's full width and stays
// where the pointer expects it. The negative side margins take it out to the box's own edges, which
// `PANEL`'s padding would otherwise inset it from.
const STRIP_HEIGHT = 16;
const STRIP_GAP = 8;
const STRIP = `position:relative;height:${STRIP_HEIGHT}px;margin:0 -10px ${STRIP_GAP}px;` +
  "cursor:move;touch-action:none;border-radius:6px 6px 0 0;background:#1b202b";

// What an adjustable box's content element wears: the scrolling, and the height left over once the
// strip and its gap are taken off the box. The box sets `box-sizing:border-box`, so `100%` here is
// what remains inside its padding. A box nobody has sized yet has an automatic height, `100%`
// resolves to `auto` with it, and the content grows the box instead of scrolling in it.
//
// Blink ignores every `::-webkit-scrollbar` rule on an element carrying a `scrollbar-width` or a
// `scrollbar-color`, and those rules are what shape the bar below. `scrollbar-color` **inherits**,
// so a host page that sets one reaches in here and silences them: a VSCode webview does exactly
// that, and the bar comes back at the browser default. `auto` is the initial value and hands the
// styling back — measured in the webview, 15 px without it and 8 px with it. Never name a colour
// or a width here; that would silence the same rules from the other direction.
const CONTENT = "overflow:auto;scrollbar-color:auto;" +
  `height:calc(100% - ${STRIP_HEIGHT + STRIP_GAP}px)`;

// The chrome a pseudo-element owns, which an inline style cannot reach: a small wedge in the resize
// corner, and a scrollbar that is a thumb and nothing else — no track, no stepper arrows, no square
// where the two bars meet.
//
// The wedge appears only while the box is under the pointer. A panel and the globe behind it are
// close enough in tone that a bare corner is hard to aim at, and a mark that is always on is chrome
// nobody asked to read; hover answers both. It is drawn as the box's own `::after` rather than in
// `::-webkit-resizer`, because **Blink repaints a resizer only when something else invalidates the
// element**: the hover rule matches and nothing is drawn until an unrelated change forces a repaint.
// Measured on Chrome 149. The `::after` is 9 px held 2 px off both edges, clear of the 6 px corner
// radius, which cuts anything flush with it into a sliver. It takes no pointer, so the browser's own
// resize corner is still what the drag reaches.
//
// Keep every rule on its own selector rather than in a comma-separated list: Gecko knows none of the
// `-webkit-scrollbar` names, and one unknown selector invalidates a whole list. Firefox draws its
// stock scrollbar there; the wedge is ordinary CSS and reaches it.
const CONTENT_SEL = '[data-float] > [data-ui="content"]';
const WEDGE_SEL = "[data-float][data-adjustable]";
const WEDGE = "linear-gradient(315deg,rgba(230,230,230,0.9) 0 30%,transparent 30%)";
const GRIP = [
  "[data-float]::-webkit-resizer{background:transparent}",
  `${WEDGE_SEL}::after{content:"";position:absolute;right:2px;bottom:2px;width:9px;height:9px;` +
    `pointer-events:none;opacity:0;transition:opacity 90ms linear;background:${WEDGE}}`,
  `${WEDGE_SEL}:hover::after{opacity:1}`,
  `${CONTENT_SEL}::-webkit-scrollbar{width:8px;height:8px}`,
  `${CONTENT_SEL}::-webkit-scrollbar-track{background:transparent}`,
  `${CONTENT_SEL}::-webkit-scrollbar-button{display:none}`,
  `${CONTENT_SEL}::-webkit-scrollbar-corner{background:transparent}`,
  `${CONTENT_SEL}::-webkit-scrollbar-thumb{background:rgba(230,230,230,0.22);border-radius:4px}`,
  `${CONTENT_SEL}::-webkit-scrollbar-thumb:hover{background:rgba(230,230,230,0.38)}`,
].join("");

/** Create the floating-object host over `deps.container`. Boxes appear as they are declared. */
export function createFloats(deps: FloatDeps): Floats {
  // In declared order, keyed by the id a declaration and a window's tracks both address.
  const live = new Map<string, Live>();

  const anchorOf = (a: unknown): Anchor | null => {
    const kind = (a as { anchor?: unknown } | null)?.anchor;
    return kind === "screen" || kind === "entity" || kind === "world" ? (a as Anchor) : null;
  };

  const fragment = (one: Live) => {
    if (one.root) one.root.innerHTML = typeof one.spec.html === "string" ? one.spec.html : "";
  };

  const create = (id: string, key: string): Live => {
    const box = el("div", BOX);
    box.setAttribute("data-float", id);
    const inner = el("div", "");
    // Named so the stylesheet can reach the element that scrolls, which no inline style can shape.
    inner.setAttribute("data-ui", "content");
    box.appendChild(inner);
    const one: Live = { spec: {}, json: "", key, box, inner, root: null, mount: null, close: null,
                        strip: null, anchor: null, rect: null };
    if (key === "html") {
      one.root = inner.attachShadow({ mode: "open" });
    } else {
      one.mount = mountInto(id, key.slice("mount:".length), inner);
    }
    deps.container.appendChild(box);
    live.set(id, one);
    return one;
  };

  // Hand `inner` to the named module. A module that is declared but not loaded, or loaded but
  // exporting no `mount`, leaves the box empty and says so — the float still stands, so a later
  // declaration reconciles against it.
  const mountInto = (id: string, module: string, inner: HTMLElement): Mount | null => {
    const factory = deps.mountOf(module);
    if (!factory) {
      console.warn(`ui: float ${JSON.stringify(id)} mounts ${JSON.stringify(module)}, which is ` +
                   "not a loaded module exporting `mount`; the box renders nothing");
      return null;
    }
    try {
      return factory({ el: inner, id, report: (value) => deps.notify("control", { id, value }) })
        ?? null;
    } catch (err) {
      console.warn(`ui: float ${JSON.stringify(id)} failed to mount ${JSON.stringify(module)}: ${err}`);
      return null;
    }
  };

  // Everything about a box a declaration decides. The content element is not among them: it is what
  // reuse turns on, so a re-declared float that still holds the same module keeps that module alive.
  const dress = (id: string, one: Live) => {
    const adjustable = one.spec.adjustable === true;
    one.box.style.cssText = BOX + ";" + PANEL
      + (adjustable ? ";" + ADJUSTABLE : one.spec.closable === true ? ";padding-right:20px" : "");
    one.inner.style.cssText = adjustable ? CONTENT : "";
    // The stylesheet's hook: only a box the user may resize wears the corner wedge.
    one.box.toggleAttribute("data-adjustable", adjustable);
    applyStyle(one.box, one.spec.style);
    one.anchor = anchorOf(one.spec.anchor);
    fragment(one);
    if (adjustable) sheet();
    handles(id, one, adjustable);
    // Last, over everything the declaration just wrote: what the user did to this box outlives it.
    keep(one);
  };

  // The drag strip and the close affordance. Both are rebuilt whenever a declaration changes, which
  // costs nothing — neither holds state between two of them.
  const handles = (id: string, one: Live, adjustable: boolean) => {
    one.strip?.remove();
    one.close?.remove();
    one.strip = null;
    one.close = null;
    if (adjustable) {
      one.strip = el("div", STRIP);
      // Names what this is, for anyone reading the page.
      one.strip.setAttribute("data-ui", "drag");
      one.strip.onpointerdown = (e) => drag(id, one, e);
      // First, so it stands above the content in the scroll flow and can stick to the top of it.
      one.box.prepend(one.strip);
      watch(id, one);
    } else {
      one.box.onpointerdown = null;
      one.box.onpointerup = null;
    }
    if (one.spec.closable === true) {
      const x = el("div", CLOSE, "×");
      // The × owns its own gesture. Without this the strip under it starts a drag and captures the
      // pointer, the button never sees the release, and a closable box cannot be closed.
      x.onpointerdown = (e) => e.stopPropagation();
      // Dismissal is the server's: this says the user asked, and the float leaves when the server
      // declares the set without it. Nothing is removed here.
      x.onclick = () => deps.notify("close", { id });
      (one.strip ?? one.box).appendChild(x);
      one.close = x;
    }
  };

  const px = (v: string) => Math.round(parseFloat(v) || 0);

  const rectOf = (box: HTMLElement): Rect => ({
    x: px(box.style.left), y: px(box.style.top),
    w: Math.round(box.offsetWidth), h: Math.round(box.offsetHeight),
  });

  // Where the box is now becomes what the user last did, and the server is told once.
  const settle = (id: string, one: Live) => {
    one.rect = rectOf(one.box);
    deps.notify("rect", { id, ...one.rect });
  };

  // Put the box back where the user left it. A drag re-anchors the float to the screen, so nothing
  // else has to know that this box no longer follows what it was declared against.
  const keep = (one: Live) => {
    if (!one.rect) return;
    one.anchor = { anchor: "screen", x: one.rect.x, y: one.rect.y };
    one.box.style.width = `${one.rect.w}px`;
    one.box.style.height = `${one.rect.h}px`;
  };

  // Move the box with the pointer. The strip holds the pointer for the whole gesture, so the box
  // follows a drag that leaves it and Cesium below never sees one of these events.
  const drag = (id: string, one: Live, e: PointerEvent) => {
    // The strip owns this gesture: the resize watch below must not count it as a second one.
    e.stopPropagation();
    e.preventDefault();
    const strip = one.strip!;
    const box = one.box;
    const from = { x: e.clientX, y: e.clientY };
    const at = { x: px(box.style.left), y: px(box.style.top) };
    let moved = false;
    strip.setPointerCapture(e.pointerId);
    strip.onpointermove = (m) => {
      moved = true;
      // The same clamp the renderer uses, so where the drag puts the box is where it stays.
      const to = place({ x: at.x + m.clientX - from.x, y: at.y + m.clientY - from.y },
                       { w: box.offsetWidth, h: box.offsetHeight },
                       { w: deps.container.clientWidth, h: deps.container.clientHeight }, false);
      one.anchor = { anchor: "screen", x: to.left, y: to.top };
      box.style.left = `${to.left}px`;
      box.style.top = `${to.top}px`;
    };
    strip.onpointerup = (u) => {
      strip.onpointermove = null;
      strip.onpointerup = null;
      strip.releasePointerCapture(u.pointerId);
      // A click that moved nothing is not an interaction, and says nothing upward.
      if (moved) settle(id, one);
    };
  };

  // The resize is the browser's own, which reports no move while it runs and writes the size
  // straight onto the box. So measure the box on either side of the gesture and speak on release.
  const watch = (id: string, one: Live) => {
    let before: Rect | null = null;
    one.box.onpointerdown = () => { before = rectOf(one.box); };
    one.box.onpointerup = () => {
      const now = rectOf(one.box);
      if (before && (now.w !== before.w || now.h !== before.h)) settle(id, one);
      before = null;
    };
  };

  // The grip rule, put on the page by the first adjustable float and never before: a float nobody
  // may adjust needs no stylesheet at all.
  let grip: HTMLStyleElement | null = null;
  const sheet = () => {
    if (grip) return;
    grip = el("style", "");
    grip.textContent = GRIP;
    deps.container.appendChild(grip);
  };

  const drop = (id: string, one: Live) => {
    try {
      one.mount?.dispose?.();
    } catch (err) {
      console.warn(`ui: float ${JSON.stringify(id)} threw while disposing its mount: ${err}`);
    }
    one.box.remove();
    live.delete(id);
  };

  const reposition = () => {
    for (const one of live.values()) {
      const at = one.anchor && deps.screenOf(one.anchor);
      // An anchor that resolves to nothing — an entity a window renumbered away, a module that
      // cannot be anchored to, a point behind the camera — hides the box. The server declaring the
      // set without this float is the removal; this is only where it is not drawable.
      if (!at) {
        one.box.style.display = "none";
        continue;
      }
      one.box.style.display = "block";
      // A screen anchor is where the box's top-left goes, exactly. An entity or a point on the
      // globe names a thing to sit beside, so the box keeps its gap and its flip near an edge.
      const beside = one.anchor?.anchor !== "screen";
      const p = place(at, { w: one.box.offsetWidth, h: one.box.offsetHeight },
                      { w: deps.container.clientWidth, h: deps.container.clientHeight }, beside);
      one.box.style.left = `${p.left}px`;
      one.box.style.top = `${p.top}px`;
    }
  };

  return {
    declare(payload) {
      const specs = (Array.isArray(payload) ? payload : []) as FloatSpec[];
      const declared = new Set<string>();
      // The floats whose box a declaration touched, told after the placement below rather than
      // before it, so a module measuring itself sees the box where it will actually sit.
      const dressed: Live[] = [];
      for (const spec of specs) {
        if (spec?.id == null) {
          console.warn("ui: a float declares no id, so nothing can address it; skipped");
          continue;
        }
        const id = String(spec.id);
        if (declared.has(id)) {
          console.warn(`ui: float ${JSON.stringify(id)} is declared twice; the second is ignored`);
          continue;
        }
        declared.add(id);
        const json = JSON.stringify(spec);
        const key = spec.mount == null ? "html" : `mount:${String(spec.mount)}`;
        const prev = live.get(id);
        if (prev && prev.json === json) continue;   // unchanged: it keeps everything it had
        // Reuse turns on the content alone. A float that moved, was restyled or was re-worded keeps
        // its element and its mounted module; only a different content kind builds a new box.
        if (prev && prev.key !== key) drop(id, prev);
        const one = live.get(id) ?? create(id, key);
        one.spec = spec;
        one.json = json;
        dress(id, one);
        dressed.push(one);
      }
      for (const [id, one] of [...live]) {
        if (!declared.has(id)) drop(id, one);
      }
      reposition();
      for (const one of dressed) one.mount?.resize?.();
    },

    tracks() {
      const out: Track[] = [];
      for (const [id, one] of live) {
        const named = (Array.isArray(one.spec.keyframed) ? one.spec.keyframed : [])
          .filter((f): f is string => typeof f === "string");
        if (!named.length) continue;
        // A crossing rewrites an `html` float's fragment in place and leaves a mounted module
        // standing: a module's per-keyframe data reaches it through the window addressed to it, so
        // rebuilding the box on every crossing would tear down and rebuild what is drawing.
        out.push({ id, fields: new Set(named), spec: one.spec, show: () => fragment(one) });
      }
      return out;
    },

    reposition,

    destroy() {
      for (const [id, one] of [...live]) drop(id, one);
      grip?.remove();
      grip = null;
    },
  };
}
