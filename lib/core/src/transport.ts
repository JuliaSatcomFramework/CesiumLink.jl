// Transport: one notification per frame, in either direction, and the array bytes behind it.
//   notify -> {method, params}, bytes   (no id, fire-and-forget)
//   on     <- {method, params}, bytes   one handler per method
// The core depends only on this interface; hosts pick a concrete transport.
//
// A frame is answered by a later frame, not by a reply: an event carries a `seq` and the command
// batch answering it echoes that `seq`. Correlation therefore needs no id on the transport.
//
// The attachment is the frame's region: the bytes every encoded array in `params` points into. A
// transport splits a frame and passes both parts up; it never reads a payload. Substituting the
// bytes into the payload here would put that logic in every transport instead of in one codec.

import type { FurnitureDeclaration } from "./furniture";
import type { ImagerySpec } from "./scene";

export interface Transport {
  /** Resolves once the connection is open. */
  readonly ready: Promise<void>;
  notify(method: string, params?: unknown, bytes?: Uint8Array): void;
  /** Register a handler for an incoming notification `method`. */
  on(method: string, handler: (params: unknown, bytes?: Uint8Array) => void): void;
  close(): void;
}

/** The bytes a message with no arrays carries. */
export const NO_BYTES = new Uint8Array(0);

/**
 * The wire contract this viewer speaks, announced in `ready`. A server that speaks another version
 * closes the socket with a reason: every frame is binary, so a viewer built against a different
 * framing parses none of them and reports nothing at all (the wire protocol reference).
 */
export const PROTOCOL_VERSION = 2;

/** What the server declares once per connection, in its `modules` message. */
export interface Declaration {
  /** The ES modules to load, in load order. */
  modules: unknown[];
  /** The shape the scene's coordinates are on, in metres. Absent means WGS84. */
  ellipsoid?: { a: number; b: number };
  /**
   * The basemap set, fixed for the session. Absent and `false` are different declarations: absent
   * means the bundled Earth texture, `false` means no base layer at all and a globe of one flat
   * colour. An object names one tile source, and a list names the set the reader picks within,
   * whose entry 0 is what the globe wears at startup.
   */
  imagery?: false | ImagerySpec | ImagerySpec[];
  /**
   * Every directory the server serves, as mount name to the same-origin base it answers. A payload
   * names an asset by that path, and `ctx.assetUrl` resolves it for this host. Absent means the
   * server serves no directory of its own.
   */
  assets?: Record<string, string>;
  /** True lights the globe from the sun at the clock's time. Absent lights it evenly. */
  lighting?: boolean;
  /** True draws the star field, the sun and the moon around the globe. Absent leaves black. */
  stars?: boolean;
  /**
   * `false` takes the place names off the globe. Absent draws them, so this field carries only the
   * departure from the default — the opposite way round to `lighting` and `stars`.
   */
  namedPlaces?: boolean;
  /** `false` takes the country borders off the globe. Absent draws them. */
  countryBorders?: boolean;
  /**
   * `true` puts the region borders on the globe. Absent draws none — the other way round to the two
   * fields above, because this layer is off by default and the wire states the departure from it.
   */
  regionBorders?: boolean;
  /**
   * The Core's own on-screen items. Absent means the Core builds its default set, which is what a
   * session that declares no furniture shows.
   */
  furniture?: FurnitureDeclaration;
}

/**
 * The session declaration, or `null` if none arrives within `timeoutMs`. A host that builds its
 * scene from what the server declares needs the answer before it can start, and a server that never
 * answers must still leave it able to carry on.
 */
export function firstDeclaration(t: Transport, timeoutMs: number): Promise<Declaration | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    t.on("modules", (params) => {
      clearTimeout(timer);
      resolve((params ?? { modules: [] }) as Declaration);
    });
  });
}

/** WebSocket transport. Browser host: `ws://host:port`. */
export class WsTransport implements Transport {
  /**
   * Called once the socket closes, whatever closed it. Nothing else tells a host that the server
   * is gone: the scene keeps drawing the last state it holds, and stays interactive, so a viewer
   * with no listener here shows stale data as though it were live. Not on `Transport` — a
   * transport reading a recording has no socket to lose.
   */
  onClose: (() => void) | null = null;
  readonly ready: Promise<void>;
  private ws: WebSocket;
  private handlers = new Map<string, (params: unknown, bytes?: Uint8Array) => void>();
  // Notifications that arrived before a handler for their method existed, in arrival order. The
  // scene state the server replays follows its declaration immediately, while a host that builds
  // from that declaration has nothing to receive it with yet; held here, none of it is lost. The
  // region travels with its message: a window queued without one loses every array it carries.
  private queued: { method: string; params: unknown; bytes: Uint8Array }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data as ArrayBuffer));
    this.ws.addEventListener("close", () => this.onClose?.());
  }

  private onMessage(data: ArrayBuffer): void {
    let msg: { method?: string; params?: unknown };
    let region: Uint8Array;
    try {
      const frame = splitFrame(data);
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
    this.ws.send(packFrame(JSON.stringify({ method, params }), bytes ?? NO_BYTES));
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
    this.ws.close();
  }
}

// One frame is `[u32 headerLen][header][pad to 8][region]`, little-endian (docs/protocol.md). The
// pad puts the region on a multiple of 8, so a Float64Array view over any array in it is legal.

/** The header text and the region of one packed frame. The region is a view, not a copy. */
export function splitFrame(frame: ArrayBuffer): { header: string; region: Uint8Array } {
  if (frame.byteLength < 4) throw new Error(`transport: a frame is at least 4 bytes`);
  const n = new DataView(frame).getUint32(0, true);
  if (4 + n > frame.byteLength) {
    throw new Error(`transport: a header of ${n} bytes runs past a frame of ${frame.byteLength}`);
  }
  const header = new TextDecoder().decode(new Uint8Array(frame, 4, n));
  const start = Math.min((4 + n + 7) & ~7, frame.byteLength);
  return { header, region: new Uint8Array(frame, start) };
}

/** `header` and `region` laid out as one frame. */
export function packFrame(header: string, region: Uint8Array): ArrayBuffer {
  const h = new TextEncoder().encode(header);
  const start = (4 + h.byteLength + 7) & ~7;
  const out = new Uint8Array(start + region.byteLength);
  new DataView(out.buffer).setUint32(0, h.byteLength, true);
  out.set(h, 4);
  out.set(region, start);
  return out.buffer;
}
