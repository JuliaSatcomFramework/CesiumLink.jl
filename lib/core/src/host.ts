// What a host does around the Core: connect to the server, ask it to declare the session, publish
// the handle, and say when the session goes stale. The browser host and the VSCode host run the
// same sequence. They differ in where a line about it goes — a console the reader may never open,
// or the extension's output channel — so the sequence is here and the sentences stay in the host.
//
// A host is still a script. This is the part of it that was written twice, not a host interface.

import { firstDeclaration, PROTOCOL_VERSION, type Declaration, type Transport } from "./transport";
import type { QueryScene } from "./query";
import type { ViewerHandle } from "./index";

/**
 * How long a connected server gets to declare the session before the globe is built without it.
 * Generous next to any round trip, and short enough that a server that never answers reads as a
 * wait rather than as a broken page.
 */
export const DECLARATION_TIMEOUT_MS = 5000;

/** What {@link connectAndDeclare} found. */
export interface Bootstrap {
  /** Whether the transport connected. */
  live: boolean;
  /** What the server declared, or `null` if it connected and declared nothing in time. */
  declaration: Declaration | null;
  /** Why the connection failed. Present only when `live` is false. */
  error?: unknown;
}

/**
 * Connect `t`, tell the server this page is ready, and wait for the first declaration.
 *
 * The globe is built on the ellipsoid the server names, so the coordinates a scene sends and the
 * surface they are drawn on cannot disagree. The declaration also names the furniture, so the first
 * paint shows the set the session asked for. Everything the server replays behind the declaration
 * waits on the transport until the viewer exists to receive it.
 *
 * This reports nothing. Read the result and write the line where your host's reader is looking.
 */
export async function connectAndDeclare(
  t: Transport,
  timeoutMs: number = DECLARATION_TIMEOUT_MS,
): Promise<Bootstrap> {
  try {
    await t.ready;
  } catch (error) {
    return { live: false, declaration: null, error };
  }
  t.notify("ready", { protocol: PROTOCOL_VERSION });
  return { live: true, declaration: await firstDeclaration(t, timeoutMs) };
}

/**
 * Which of the page's own scene parameters a live server's declaration overrules, by name.
 *
 * A declared basemap beats the address bar: the server owns a session it is present for, and its
 * coordinates are on the shape it names (ADR-0019). A parameter fills in only what the declaration
 * does not state.
 *
 * A recording obeys the opposite rule, and `declarationOf` in `recording.ts` states it: there the
 * query string beats the file, because the file describes a session that has ended and its basemap
 * is the one thing that may not have travelled with it (ADR-0024). Keep the two apart.
 *
 * The caller reports the names it gets back. A host with no address bar asks nothing here.
 */
export function ignoredByDeclaration(asked: QueryScene, declaration: Declaration | null): string[] {
  return [
    asked.imagery && declaration?.imagery !== undefined ? "?imagery" : "",
    asked.ellipsoid && declaration?.ellipsoid !== undefined ? "?ellipsoid" : "",
  ].filter(Boolean);
}

/**
 * Put the stale banner over `container`, once.
 *
 * A server that stops leaves the scene drawn and interactive, so say that what is on the globe is
 * no longer updated. The page owns this rather than the scene: the server is gone, and a server is
 * what declares anything the overlay shows. `sentence` says what the reader can do next, which is
 * the one thing the hosts differ on.
 */
export function showStale(container: HTMLElement, sentence: string): void {
  if (document.getElementById("stale")) return;
  const banner = document.createElement("div");
  banner.id = "stale";
  banner.textContent = sentence;
  banner.setAttribute("style",
    "position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:10;" +
    "padding:6px 12px;border-radius:6px;background:rgba(120,20,20,0.88);color:#fff;" +
    "font:13px/1.4 system-ui,sans-serif;pointer-events:none");
  container.appendChild(banner);
}

/**
 * Put `handle` on `globalThis.viewer`, where a console session and a test driver both look for it.
 */
export function publish(handle: ViewerHandle): void {
  (globalThis as Record<string, unknown>).viewer = handle;
}
