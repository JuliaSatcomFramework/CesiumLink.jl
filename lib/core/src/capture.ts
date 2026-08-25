// A canvas capture: one PNG of what the viewer drew (ADR-0033). The furniture, the overlay and the
// floats are HTML above the canvas, so a capture never holds them.
//
// Two doors reach the same picture. The server sends a `core/capture` command, and the Core answers
// with the bytes. The `canvasCapture` furniture button copies the picture to the clipboard, or
// writes it to a file. The button holds no setting between two presses, and this file stores
// nothing in the browser.
//
// `scene.ts` builds the widget with no `preserveDrawingBuffer`, so the canvas holds a picture only
// inside the tick that drew it. The read below therefore renders and calls `toDataURL` with no
// `await` between the two. `toBlob` answers on a later tick, which is why nothing here calls it.

import type { CesiumWidget, Scene } from "@cesium/engine";

/**
 * PNG bytes in a buffer of their own. A `Blob` takes only that form, and the frame's region carries
 * the same bytes, so the capture never hands on a view into a larger buffer.
 */
export type PngBytes = Uint8Array<ArrayBuffer>;

/** What one capture gives: the PNG bytes, or the reason there is no picture. */
export type Capture = { ok: true; bytes: PngBytes } | { ok: false; error: string };

/** The scales the popup offers. A scale the GPU cannot draw is shown, and disabled. */
const SCALES = [1, 2, 3, 4];

/** How long a touch press must last to count as a long press, in milliseconds. */
const HOLD_MS = 500;

/** How long the button says what the last press did, in milliseconds. */
const NOTE_MS = 1600;

/**
 * The largest texture this GPU builds, or 0 where the scene will not say.
 *
 * `scene.context` is internal, and reaching it is what `warnIfSoftwareRenderer` in `scene.ts` does
 * for the renderer string. A 0 turns the size check off, which is better than a refusal built on a
 * number nobody could read.
 */
function maxTextureSize(scene: Scene): number {
  try {
    const gl = (scene as unknown as { context: { _gl: WebGLRenderingContext } }).context._gl;
    return Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The reason `scale` gives no picture, or null where it gives one.
 *
 * `width` and `height` are the drawing buffer as it stands, and `max` is the GPU limit. A scale past
 * that limit draws nothing at all, so it must be refused before the render rather than after it: the
 * canvas answers a failed render with a blank picture, and a blank picture reads as a real one.
 */
export function scaleError(
  scale: number,
  width: number,
  height: number,
  max: number,
): string | null {
  if (!Number.isFinite(scale) || scale <= 0) {
    return `the scale ${scale} is not a positive number`;
  }
  if (width === 0 || height === 0) {
    return "the viewer has no size on screen yet";
  }
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (max > 0 && Math.max(w, h) > max) {
    return `the scale ${scale} asks for ${w}x${h} pixels, and this GPU draws at most ${max}`;
  }
  return null;
}

/** The bytes a `data:` URL carries. `toDataURL` writes base64, which is what this reads. */
export function bytesOfDataUrl(url: string): PngBytes {
  const text = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * One PNG of the canvas at `scale` times the size it draws at now.
 *
 * `separateDrawingBuffer` in `scene.ts` owns `resolutionScale`, and it gives each viewer on the page
 * a value of its own. So the capture reads that value, multiplies it, and puts back exactly what it
 * read. Do not put back 1: that hands two viewers on one page the same buffer size, and each then
 * shows the other's frames.
 *
 * The scene renders twice for a scaled capture. The second render puts the screen back inside the
 * same tick, so the reader never sees the larger buffer stretched across the page.
 */
export function takeCapture(widget: CesiumWidget, scale: number): Capture {
  const canvas = widget.canvas;
  const bad = scaleError(scale, canvas.width, canvas.height, maxTextureSize(widget.scene));
  if (bad) return { ok: false, error: bad };
  const held = widget.resolutionScale;
  const resized = scale !== 1;
  try {
    if (resized) {
      widget.resolutionScale = held * scale;
      widget.resize();
    }
    // One tick, no `await`: the drawing buffer is not preserved, so anything that yields between
    // these two lines gives a blank picture.
    widget.scene.render(widget.clock.currentTime);
    return { ok: true, bytes: bytesOfDataUrl(canvas.toDataURL("image/png")) };
  } catch (err) {
    return { ok: false, error: `the viewer did not draw the picture (${err})` };
  } finally {
    if (resized) {
      widget.resolutionScale = held;
      widget.resize();
      widget.scene.render(widget.clock.currentTime);
    }
  }
}

/**
 * The name the popup starts with: the page title, then the time, then the extension.
 *
 * The viewer knows no session title. The page title is the nearest thing it holds, and a host that
 * writes a better one into `document.title` gets it here for free.
 */
export function captureName(title: string, when: Date): string {
  const stem = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "capture";
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${stem}-${day}-${time}.png`;
}

/**
 * Whether this page reaches the clipboard.
 *
 * The clipboard needs a secure page, so `localhost` and HTTPS have one and plain HTTP to another
 * machine has none. It also needs a real press, which is why Julia never copies.
 */
export function canCopy(): boolean {
  return (
    typeof ClipboardItem === "function" &&
    typeof globalThis.navigator?.clipboard?.write === "function"
  );
}

/** Why the `Copy` button is dead, which the button itself says on the page that cannot copy. */
const NO_CLIPBOARD = "This page cannot reach the clipboard. Open the viewer over HTTPS, " +
  "or on localhost, or download the file instead.";

async function copyToClipboard(bytes: PngBytes): Promise<void> {
  const blob = new Blob([bytes], { type: "image/png" });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function downloadPng(bytes: PngBytes, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  // Firefox starts a download only for a link the document holds.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser starts the download on a later tick, and it reads the URL then.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A camera, in Cesium's own 128-unit icon box. The lens is a hole, so the rule is `evenodd`. */
const CAMERA_PATH =
  "M 50 24 L 44 38 L 16 38 A 8 8 0 0 0 8 46 " +
  "L 8 100 A 8 8 0 0 0 16 108 L 112 108 " +
  "A 8 8 0 0 0 120 100 L 120 46 " +
  "A 8 8 0 0 0 112 38 L 84 38 L 78 24 z " +
  "M 64 50 A 23 23 0 1 0 64 96 A 23 23 0 1 0 64 50 z";

const PANEL = "position:absolute;top:36px;right:0;z-index:1;display:none;flex-direction:column;" +
  "gap:6px;width:216px;padding:8px;font:12px/18px sans-serif;color:#edffff;" +
  "background:rgba(38,38,38,0.92);border:1px solid #444;border-radius:3px;text-align:left;";
const FIELD = "width:100%;box-sizing:border-box;font:inherit;color:inherit;" +
  "background:rgba(0,0,0,0.35);border:1px solid #666;border-radius:3px;padding:2px 4px;";
const ACTION = "flex:1;font:inherit;color:inherit;background:rgba(56,56,56,0.9);" +
  "border:1px solid #666;border-radius:3px;padding:2px 0;cursor:pointer;";
const NOTE = "position:absolute;top:36px;right:0;z-index:1;display:none;white-space:nowrap;" +
  "font:12px/22px sans-serif;color:#edffff;padding:0 8px;" +
  "background:rgba(38,38,38,0.9);border:1px solid #444;border-radius:3px;";
const DIM = "color:#9fb6b6";

/** What the Core holds on to for one capture cell. */
export interface CaptureCell {
  destroy(): void;
}

/**
 * The `canvasCapture` furniture cell: one button, and the popup behind it.
 *
 * A left press copies the canvas at scale 1. A right press opens the popup, and so does a left press
 * on a page with no clipboard, so the button is never dead. The popup names the file, picks the
 * scale, and offers both `Copy` and `Download`.
 *
 * A touch screen has no right press, so a long press opens the popup as well.
 */
export function captureCell(cell: HTMLElement, widget: CesiumWidget): CaptureCell {
  // The popup and the note sit against this box, so the cell needs a position of its own. Without
  // it they would anchor to the overlay region instead, which is the whole corner of the screen.
  const root = document.createElement("div");
  root.style.cssText = "position:relative;width:32px;height:32px";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cesium-button cesium-toolbar-button";
  button.title = "Copy a picture of the globe. Press the right button for the file and the scale.";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "cesium-svgPath-svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", CAMERA_PATH);
  path.setAttribute("fill-rule", "evenodd");
  svg.appendChild(path);
  button.appendChild(svg);

  // What the last press did, for the presses that open no popup. A copy is otherwise silent, and a
  // reader has no way to tell it apart from a button that does nothing.
  const noteEl = document.createElement("div");
  noteEl.style.cssText = NOTE;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  const panel = document.createElement("div");
  panel.style.cssText = PANEL;
  const nameLabel = document.createElement("div");
  nameLabel.textContent = "File name";
  nameLabel.style.cssText = DIM;
  const nameEl = document.createElement("input");
  nameEl.type = "text";
  nameEl.style.cssText = FIELD;
  const scaleLabel = document.createElement("div");
  scaleLabel.textContent = "Scale";
  scaleLabel.style.cssText = DIM;
  const scaleEl = document.createElement("select");
  scaleEl.style.cssText = FIELD;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px";
  const copyEl = document.createElement("button");
  copyEl.type = "button";
  copyEl.textContent = "Copy";
  copyEl.style.cssText = ACTION;
  const saveEl = document.createElement("button");
  saveEl.type = "button";
  saveEl.textContent = "Download";
  saveEl.style.cssText = ACTION;
  const messageEl = document.createElement("div");
  messageEl.style.cssText = DIM + ";white-space:normal";
  row.append(copyEl, saveEl);
  panel.append(nameLabel, nameEl, scaleLabel, scaleEl, row, messageEl);
  root.append(button, noteEl, panel);
  cell.appendChild(root);

  // Both buttons are always on the panel. A page with no clipboard shows a dead `Copy` and says why,
  // because a missing button reads as a viewer that never had the feature.
  if (!canCopy()) {
    copyEl.disabled = true;
    copyEl.style.cursor = "not-allowed";
    copyEl.title = NO_CLIPBOARD;
  }

  const say = (text: string) => {
    noteEl.textContent = text;
    noteEl.style.display = "block";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteEl.style.display = "none";
    }, NOTE_MS);
  };

  /** The scale list, built against the canvas as it stands. It disables a scale the GPU refuses. */
  const listScales = () => {
    const canvas = widget.canvas;
    const max = maxTextureSize(widget.scene);
    scaleEl.replaceChildren(
      ...SCALES.map((scale) => {
        const option = document.createElement("option");
        const bad = scaleError(scale, canvas.width, canvas.height, max);
        option.value = String(scale);
        option.textContent = `${scale}x`;
        option.disabled = bad !== null;
        if (bad) option.title = bad;
        return option;
      }),
    );
    scaleEl.value = "1";
  };

  let open = false;

  const shut = () => {
    if (!open) return;
    open = false;
    panel.style.display = "none";
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  };

  // A press anywhere else puts the popup away. Capture phase, so a control that stops the event
  // still lets the popup close.
  function onOutside(e: Event) {
    if (!root.contains(e.target as Node)) shut();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") shut();
  }

  const show = () => {
    if (open) return;
    open = true;
    // A fresh name and a fresh scale list on every opening. The viewer keeps neither: two captures
    // one minute apart must not land on one file name.
    nameEl.value = captureName(document.title, new Date());
    listScales();
    messageEl.textContent = "";
    noteEl.style.display = "none";
    panel.style.display = "flex";
    nameEl.focus();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
  };

  /** The picture the popup asks for, or null once the reason is on the panel. */
  const shoot = (scale: number): PngBytes | null => {
    const shot = takeCapture(widget, scale);
    if (shot.ok) return shot.bytes;
    messageEl.textContent = shot.error;
    return null;
  };

  const onCopy = () => {
    const bytes = shoot(Number(scaleEl.value));
    if (!bytes) return;
    copyToClipboard(bytes).then(
      () => shut(),
      (err) => {
        messageEl.textContent = `the clipboard refused the picture (${err})`;
      },
    );
  };

  const onSave = () => {
    const bytes = shoot(Number(scaleEl.value));
    if (!bytes) return;
    try {
      downloadPng(bytes, nameEl.value || captureName(document.title, new Date()));
    } catch (err) {
      // A page that refuses an object URL still has the popup open, and it now says why.
      messageEl.textContent = `the browser refused the download (${err})`;
      return;
    }
    shut();
  };

  // A long press already opened the popup, so the press that follows it must do nothing.
  let holdOpened = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      holdOpened = true;
      show();
    }, HOLD_MS);
  };
  const onPointerUp = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const onClick = () => {
    if (holdOpened) {
      holdOpened = false;
      return;
    }
    if (open) {
      shut();
      return;
    }
    // The button is never dead: a page that cannot copy gets the popup, which can still download.
    if (!canCopy()) {
      show();
      return;
    }
    const shot = takeCapture(widget, 1);
    if (!shot.ok) {
      say(shot.error);
      return;
    }
    copyToClipboard(shot.bytes).then(
      () => say("Copied"),
      (err) => say(`The clipboard refused the picture (${err})`),
    );
  };

  const onContextMenu = (e: MouseEvent) => {
    // The browser menu covers the popup and offers nothing about the canvas, so it goes away.
    e.preventDefault();
    show();
  };

  button.addEventListener("click", onClick);
  button.addEventListener("contextmenu", onContextMenu);
  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerUp);
  button.addEventListener("pointercancel", onPointerUp);
  copyEl.addEventListener("click", onCopy);
  saveEl.addEventListener("click", onSave);

  return {
    destroy() {
      shut();
      clearTimeout(holdTimer);
      clearTimeout(noteTimer);
      button.removeEventListener("click", onClick);
      button.removeEventListener("contextmenu", onContextMenu);
      button.removeEventListener("pointerdown", onPointerDown);
      button.removeEventListener("pointerup", onPointerUp);
      button.removeEventListener("pointercancel", onPointerUp);
      copyEl.removeEventListener("click", onCopy);
      saveEl.removeEventListener("click", onSave);
      root.remove();
    },
  };
}
