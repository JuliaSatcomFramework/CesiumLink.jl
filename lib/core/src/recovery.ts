// What a viewer does when the browser takes its WebGL context away.
//
// A browser keeps a small number of WebGL contexts for each page, 16 in Chrome. When a page makes
// one more, the browser loses the context that the page made first, whether it is on screen or not.
// A figure elsewhere on the page that leaks contexts thus stops a viewer that the reader looks at.
//
// Cesium cannot draw on a context that comes back: its buffers, textures and shaders went with the
// old one. So the Core builds the viewer again on a new canvas, and the server sends the scene
// again. This file decides when that happens: when the container comes into view, or when the
// reader clicks it. The build itself belongs to the caller.
//
// Pure DOM, and no Cesium import, so it unit-tests without WebGL.

/** The part of a Cesium widget that this file reads. */
export interface Watched {
  readonly canvas: HTMLCanvasElement;
  readonly scene: {
    renderError: { addEventListener(cb: (scene: unknown, err: unknown) => void): () => void };
  };
  useDefaultRenderLoop: boolean;
  showErrorPanel(title: string, message: string | undefined, error: unknown): void;
}

export interface Recovery {
  /** Watch the context of `widget`, the widget that the last build made. */
  watch(widget: Watched, contextLost: () => boolean): void;
  destroy(): void;
}

/**
 * The limit on builds that start without a click, in a sliding period. Two viewers on screen can
 * take the context from each other: each build makes the newest context, and the page then loses
 * the oldest one. Past the limit, a build waits for a click, so that loop stops.
 */
export const AUTO_REBUILDS = 3;
export const AUTO_REBUILD_PERIOD_MS = 60_000;

// Cesium's own title for a render loop that stops. This file shows it for each error that is not a
// lost context, because Cesium no longer shows its panel itself.
const RENDER_ERROR_TITLE = "An error occurred while rendering.  Rendering has stopped.";

const NOTE_STYLE =
  "position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;" +
  "padding:24px;box-sizing:border-box;text-align:center;background:rgba(0,0,0,0.7);color:#fff;" +
  "font:14px/1.4 system-ui,sans-serif";

/**
 * Keep a viewer in `container` alive through a loss of its WebGL context.
 *
 * `rebuild` destroys the viewer, builds a new one and calls `watch` on its widget. `null` means
 * that this host cannot build the scene again, and the note then asks the reader to reload the page.
 */
export function createRecovery(
  container: HTMLElement,
  rebuild: (() => Promise<void>) | null,
): Recovery {
  const autoStarts: number[] = [];
  let note: HTMLElement | null = null;
  let seen: IntersectionObserver | null = null;
  let unwatch: (() => void) | null = null;
  let building = false;
  let lost = false;
  let destroyed = false;

  const showNote = (text: string, clickable: boolean) => {
    note ??= container.appendChild(document.createElement("div"));
    note.setAttribute("style", NOTE_STYLE + (clickable ? ";cursor:pointer" : ""));
    note.textContent = text;
    if (clickable) note.addEventListener("click", onClick);
    else note.removeEventListener("click", onClick);
  };
  const removeNote = () => {
    note?.removeEventListener("click", onClick);
    note?.remove();
    note = null;
  };
  const stopSeeing = () => {
    seen?.disconnect();
    seen = null;
  };

  const start = async () => {
    if (building || destroyed || !rebuild) return;
    building = true;
    stopSeeing();
    showNote("Restoring the view…", false);
    try {
      await rebuild();
      lost = false;
      removeNote();
    } catch (e) {
      console.error("CesiumLink: the viewer did not build again after a lost WebGL context", e);
      showNote("The view did not come back. Click to try again.", true);
    } finally {
      building = false;
    }
  };

  function onClick(): void {
    void start();
  }

  const onSeen = (entries: IntersectionObserverEntry[]) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    const now = Date.now();
    while (autoStarts.length > 0 && now - autoStarts[0] > AUTO_REBUILD_PERIOD_MS) autoStarts.shift();
    if (autoStarts.length >= AUTO_REBUILDS) {
      // A loop: stop to observe the view, and let the click decide.
      stopSeeing();
      showNote("This view lost its graphics context again. Click to restore it.", true);
      return;
    }
    autoStarts.push(now);
    void start();
  };

  const onLost = (widget: Watched) => {
    if (lost || destroyed) return;
    lost = true;
    widget.useDefaultRenderLoop = false;
    if (!rebuild) {
      showNote("This view lost its graphics context to another view on the page. " +
        "Reload the page to restore it.", false);
      return;
    }
    console.warn("CesiumLink: the browser took the WebGL context of this viewer; the viewer " +
      "builds again when it is in view");
    showNote("This view lost its graphics context to another view on the page. " +
      "Click to restore it.", true);
    // The observer reports the current state first, so a view on screen builds again at once.
    seen = new IntersectionObserver(onSeen);
    seen.observe(container);
  };

  return {
    watch(widget, contextLost) {
      unwatch?.();
      const onEvent = () => onLost(widget);
      // A frame can run between the loss and its event, and then throws. Such an error is the
      // loss, and not a fault of the scene.
      const offError = widget.scene.renderError.addEventListener((_scene, err) => {
        if (contextLost()) onLost(widget);
        else widget.showErrorPanel(RENDER_ERROR_TITLE, undefined, err);
      });
      widget.canvas.addEventListener("webglcontextlost", onEvent);
      unwatch = () => {
        offError();
        widget.canvas.removeEventListener("webglcontextlost", onEvent);
      };
    },
    destroy() {
      destroyed = true;
      unwatch?.();
      stopSeeing();
      removeNote();
    },
  };
}
