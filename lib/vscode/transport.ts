// Transport for the VSCode host. The extension owns the WebSocket and the page reaches it through
// the webview channel, so the same frames cross one more hop than in the browser host.
//
// The frames themselves are unchanged: `[u32 headerLen][header][pad 8][region]`, packed and split by
// the same two functions the socket transport uses. The channel carries them as bytes — it uses
// structured clone, so a Uint8Array arrives as a Uint8Array and the binary wire survives whole. Do
// not add a text fallback: there is nothing to fall back from.
//
// A message costs about 60 ms over Remote-SSH, because the webview runs on the client and the
// extension host runs on the remote. That is a per-message floor, not a bandwidth limit: a
// window-sized payload adds about 4 ms to it. It is why nothing here batches or chunks.

import { NO_BYTES, packFrame, splitFrame, type Transport } from "../core/src/transport.ts";
import { vsApi } from "./api.ts";

/** What the extension sends down. */
type Down =
  | { type: "open" }
  | { type: "frame"; payload: Uint8Array }
  | { type: "closed"; reason?: string };

export class VsCodeTransport implements Transport {
  /** Called once the extension reports its socket closed. See `WsTransport.onClose`. */
  onClose: (() => void) | null = null;
  readonly ready: Promise<void>;
  private api = vsApi();
  private handlers = new Map<string, (params: unknown, bytes?: Uint8Array) => void>();
  // Copied from WsTransport rather than shared: two implementations of a four-method interface do
  // not pay for a base class, and the queue is the part of a transport most likely to diverge.
  // What it is for: the scene state the server replays follows its declaration immediately, while a
  // host that builds from that declaration has nothing to receive it with yet.
  private queued: { method: string; params: unknown; bytes: Uint8Array }[] = [];

  constructor(timeoutMs = 10000) {
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the extension opened no socket within ${timeoutMs} ms`)),
        timeoutMs,
      );
      window.addEventListener("message", (ev: MessageEvent<Down>) => {
        const m = ev.data;
        if (!m || typeof m.type !== "string") return;
        if (m.type === "open") {
          clearTimeout(timer);
          resolve();
        } else if (m.type === "frame") {
          this.onFrame(m.payload);
        } else if (m.type === "closed") {
          clearTimeout(timer);
          reject(new Error(m.reason ?? "the extension closed its socket"));
          this.onClose?.();
        }
      });
      // The page speaks first, and only now — a webview drops anything posted to it before it
      // listens, and this bundle carries the whole of Cesium, so the extension reaches `open` on a
      // localhost socket long before the parse finishes. Without this the two sides wait for each
      // other: the page waits for a socket it was never told about, and the server waits for the
      // `ready` the page therefore never sends. A WebSocket has no such hazard, because the server
      // replays behind `ready` rather than announcing itself.
      this.api.postMessage({ type: "hello" });
    });
    // A rejection nobody awaits is an unhandled rejection, and `ready` is awaited only until the
    // page is up. After that a close arrives through `onClose`.
    this.ready.catch(() => {});
  }

  private onFrame(payload: Uint8Array): void {
    let msg: { method?: string; params?: unknown };
    let region: Uint8Array;
    try {
      // The view may sit inside a larger buffer, and `splitFrame` reads from offset 0.
      const frame = splitFrame(payload.slice().buffer);
      msg = JSON.parse(frame.header);
      region = frame.region;
    } catch (e) {
      console.warn("transport: ignoring an unreadable frame", e);
      return;
    }
    if (msg.method) this.deliver(msg.method, msg.params, region);
  }

  private deliver(method: string, params: unknown, bytes: Uint8Array): void {
    const handler = this.handlers.get(method);
    handler ? handler(params, bytes) : this.queued.push({ method, params, bytes });
  }

  notify(method: string, params?: unknown, bytes?: Uint8Array): void {
    const frame = packFrame(JSON.stringify({ method, params }), bytes ?? NO_BYTES);
    this.api.postMessage({ type: "frame", payload: new Uint8Array(frame) });
  }

  on(method: string, handler: (params: unknown, bytes?: Uint8Array) => void): void {
    this.handlers.set(method, handler);
    // Handlers are registered as a batch, so the queue is drained after the batch rather than
    // during it: one message per method at a time would replay them out of arrival order.
    queueMicrotask(() => {
      const held = this.queued;
      this.queued = [];
      for (const m of held) this.deliver(m.method, m.params, m.bytes);
    });
  }

  close(): void {
    this.api.postMessage({ type: "close" });
  }
}
