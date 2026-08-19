// Transport for the KaimonSlate host. The notebook page already holds one WebSocket open to the
// Slate server, and this host uses it. There is no second port, and no socket of its own.
//
// The frames do not change: `[u32 headerLen][header][pad 8][region]`, packed and split by the two
// functions that the socket transport also uses. Slate carries raw bytes in both directions and
// reads neither payload, so a frame crosses whole.
//
//   down  Julia `slate_emit(channel, SlateBinary(bytes))` → `slateOnStream(channel, m => …)`,
//         where `m.d` is a `Uint8Array`.
//   up    `slateCall(channel, args, undefined, [bytes])` → the buffers arrive as binary frames
//         before the JSON call, and the Julia handler reads `args.__slate_buffers[1]`.
//
// Keep the region aligned. `splitFrame` reads from offset 0 and takes a `Float64Array` view over the
// region, so the region must start on a multiple of 8. Slate gives the handler a new buffer that
// starts at 0, so the padding of the frame stays where the codec put it. `payload.slice()` below
// keeps that true for a view at any offset.
//
// `slateCall` is a round trip with a timeout of 35 s, and `notify` does not wait for an answer.
// Events come from the user and are rare, so the cost is one unused promise for each event. The
// downlink carries the high rate, and it is a push.

import { NO_BYTES, packFrame, splitFrame, type Transport } from "../core/src/transport.ts";

/** The functions that Slate puts on the page. They are declared here, because nothing else gives a
 * type to the page. */
interface SlateWindow {
  slateOnStream(channel: string, handler: (m: { d?: Uint8Array }) => void): () => void;
  slateOffStream(channel: string): void;
  slateCall(channel: string, args: unknown, onProgress?: unknown, buffers?: ArrayBufferView[]):
    Promise<unknown>;
}

const slate = (): SlateWindow => globalThis as unknown as SlateWindow;

export class SlateTransport implements Transport {
  /** Never called. The notebook socket lives longer than the cell, and Slate reconnects it. */
  onClose: (() => void) | null = null;
  /** The Slate socket is open before a cell renders, so there is nothing to wait for. */
  readonly ready = Promise.resolve();
  private handlers = new Map<string, (params: unknown, bytes?: Uint8Array) => void>();
  // A copy of the queue in WsTransport, and not a shared one. Two implementations of an interface
  // with four methods do not need a base class, and the queue is the part of a transport that
  // changes most. Its purpose: the server sends the scene state immediately after its declaration,
  // but a host that builds the viewer from that declaration cannot receive the state yet.
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
    // A rejected promise that nobody awaits becomes an unhandled rejection. A call that fails has
    // nothing to try again, because the next event sends the next frame. Report the error and drop
    // it.
    slate().slateCall(`${this.channel}/up`, {}, undefined, [new Uint8Array(frame)])
      .catch((e: unknown) => console.warn(`transport: ${method} did not reach the server`, e));
  }

  on(method: string, handler: (params: unknown, bytes?: Uint8Array) => void): void {
    this.handlers.set(method, handler);
    // The host registers the handlers as a batch, so the queue drains after the batch and not
    // during it. A drain for each method sends the held messages in the wrong order.
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
