// The hover tooltip. Content is authored entirely in Julia and arrives as a list of fragments, one
// per contributing listener in chain order; each is mounted in its own shadow root, so a fragment's
// `<style>` and `style=` apply to that fragment alone and cannot reach another contributor's markup.
// A `<script>` in a fragment never runs: assigning `innerHTML` does not execute one.
//
// One box, and it is stateless: hover in, HTML out, replaced wholesale on the next pointer move.
// Content that stays put while the cursor moves on is a floating object instead — it has an identity,
// an anchor of its own and a lifetime the server controls.
//
// Anchoring is local. The module tracks the cursor and flips or clamps the box to stay inside the
// container, so following the pointer costs no round trip.
//
// Pure DOM, no Cesium, so the placement rule and the box behaviour unit-test without WebGL.

interface CursorPoint {
  x: number;
  y: number;
}

export interface Tooltip {
  /** Apply one `ui/tooltip` command: `{html, bare}`, or `{html: null}` to hide. */
  apply(payload: unknown): void;
  /** Where the cursor is now; the box follows it. */
  track(cursor: CursorPoint): void;
  destroy(): void;
}

const CHROME =
  "background:rgba(20,24,33,0.92);color:#e6e6e6;" +
  "font:12px/1.45 system-ui,sans-serif;border-radius:6px;padding:6px 8px;" +
  "box-shadow:0 2px 8px rgba(0,0,0,0.5)";

// Never captures the pointer: a box under the cursor must not stop the drag that moved it there.
const BOX = "position:absolute;z-index:6;pointer-events:none;max-width:340px";

// Pixels between the cursor and the corner of the box, so the box never sits under the pointer.
const GAP = 14;

/**
 * Where a box of size `box` goes for a point at `at`, kept inside `bounds`. With `beside`, the
 * point names a thing the box must not cover — the cursor, an entity — so the box sits down-right
 * of it and flips to the other side when that would overflow. Without `beside`, the point is the
 * box's top-left exactly. Either way the box clamps inside the container, and a box wider than its
 * container starts at the edge rather than off-screen.
 */
export function place(
  at: CursorPoint,
  box: { w: number; h: number },
  bounds: { w: number; h: number },
  beside = true,
): { left: number; top: number } {
  const axis = (point: number, size: number, limit: number) => {
    const after = point + GAP;
    const start = !beside ? point : after + size > limit ? point - GAP - size : after;
    return Math.max(0, Math.min(start, Math.max(0, limit - size)));
  };
  return { left: axis(at.x, box.w, bounds.w), top: axis(at.y, box.h, bounds.h) };
}

/** Create the tooltip over the viewer container. The box appears on its first content. */
export function createTooltip(container: HTMLElement): Tooltip {
  let box: HTMLElement | null = null;
  let cursor: CursorPoint = { x: 0, y: 0 };

  const boxOf = (): HTMLElement => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = BOX;
      // Names what this is, for anyone reading the page: it is otherwise an anonymous div over
      // the globe.
      box.setAttribute("data-ui", "tooltip");
      container.appendChild(box);
    }
    return box;
  };

  const position = () => {
    if (!box || box.style.display === "none") return;
    const p = place(cursor, { w: box.offsetWidth, h: box.offsetHeight },
                    { w: container.clientWidth, h: container.clientHeight });
    box.style.left = `${p.left}px`;
    box.style.top = `${p.top}px`;
  };

  return {
    apply(payload) {
      const p = (payload ?? {}) as { html?: unknown; bare?: unknown };
      // One fragment per contributing listener; a lone string is the same thing with one
      // contributor. Nothing to say hides the box rather than leaving an empty one on the globe.
      const fragments = (Array.isArray(p.html) ? p.html : p.html == null ? [] : [p.html])
        .map((h) => String(h));
      const node = boxOf();
      if (!fragments.length) {
        node.style.display = "none";
        node.replaceChildren();
        return;
      }
      // `bare` drops this module's own chrome, so a contributor can own the whole box.
      node.style.cssText = BOX + (p.bare === true ? "" : ";" + CHROME);
      node.replaceChildren(...fragments.map(isolate));
      node.style.display = "block";
      position();
    },
    track(at) {
      cursor = { x: at.x, y: at.y };
      position();
    },
    destroy() {
      box?.remove();
      box = null;
    },
  };
}

// One fragment, in its own shadow root: styles written inside it apply to it alone, in both
// directions, which is the isolation a wrapper element on its own does not give.
function isolate(html: string): HTMLElement {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  // Inherited properties cross a shadow boundary, so a fragment that styles nothing still reads as
  // part of the box; `innerHTML` mounts the markup without ever running a script in it.
  root.innerHTML = html;
  return host;
}
