// Transport for the KaimonSlate host. The notebook page already holds one WebSocket open to the
// Slate server, and this host rides it: no second port, and no socket of its own.
//
// The frames themselves are unchanged: `[u32 headerLen][header][pad 8][region]`, packed and split by
// the same two functions the socket transport uses. Slate carries raw bytes in both directions and
// reads neither payload, so a frame crosses whole.
//
//   down  Julia `slate_emit(channel, SlateBinary(bytes))` → `slateOnStream(channel, m => …)`,
//         where `m.d` is a `Uint8Array`.
//   up    `slateCall(channel, args, undefined, [bytes])` → the buffers arrive as binary frames
//         ahead of the JSON call, and the Julia handler reads `args["__slate_buffers"][1]`.
//
// One alignment hazard, and Slate is already on the right side of it. `splitFrame` reads from offset
// 0 and takes a `Float64Array` view over the region, which needs the region on a multiple of 8.
// Slate hands the handler a fresh buffer that starts at 0, so the frame's internal padding still
// lands where the codec put it. `payload.slice()` below keeps that true for a view of any origin.
//
// `slateCall` is a round trip with a 35 s timeout while `notify` is fire-and-forget. Events are
// user-driven and rare, so the cost is one wasted promise per event. The high-rate direction is the
// downlink, and that one is a push.

import { NO_BYTES, packFrame, splitFrame, type Transport } from "../core/src/transport.ts";

/** What Slate puts on the page. Declared here because the page is not typed by anything else. */
interface SlateWindow {
  slateOnStream(channel: string, handler: (m: { d?: Uint8Array }) => void): () => void;
  slateOffStream(channel: string): void;
  slateCall(channel: string, args: unknown, onProgress?: unknown, buffers?: ArrayBufferView[]):
    Promise<unknown>;
}

const slate = (): SlateWindow => globalThis as unknown as SlateWindow;

export class SlateTransport implements Transport {
  /** Never called: the notebook socket outlives the cell, and Slate reconnects it itself. */
  onClose: (() => void) | null = null;
  /** Slate's socket is open before any cell renders, so there is nothing to wait for. */
  readonly ready = Promise.resolve();
  private handlers = new Map<string, (params: unknown, bytes?: Uint8Array) => void>();
  // Copied from WsTransport rather than shared: two implementations of a four-method interface do
  // not pay for a base class, and the queue is the part of a transport most likely to diverge.
  // What it is for: the scene state the server replays follows its declaration immediately, while a
  // host that builds from that declaration has nothing to receive it with yet.
  private queued: { method: string; params: unknown; bytes: Uint8Array }[] = [];

  private readonly channel: string;

  constructor(channel: string) {
    this.channel = channel;
    slate().slateOnStream(channel, (m) => {
      if (m?.d) this.onFrame(m.d);
    });
  }

  private onFrame(payload: Uint8Array): void {
    let msg: { method?: string; params?: unknown };
    let region: Uint8Array;
    try {
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
    // A rejection nobody awaits is an unhandled rejection. A call that fails has nothing to retry
    // against — the next event sends the next frame — so it is reported and dropped.
    slate().slateCall(`${this.channel}/up`, {}, undefined, [new Uint8Array(frame)])
      .catch((e: unknown) => console.warn(`transport: ${method} did not reach the server`, e));
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
    slate().slateOffStream(this.channel);
  }
}
