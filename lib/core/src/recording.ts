// A transport that plays a recorded session instead of talking to a server.
//
// A recording holds every frame a server broadcast, in order, each stamped with how long into the
// session it was sent (src/recorder.jl). Everything the Core needs to draw that
// session is therefore already in the file, so a page with no server can drive a real viewer
// through it — which is what puts a live scene in a documentation page.
//
// What a recording cannot do is answer something nobody asked during it. A control reports the
// user's input and waits for the server to declare the result (ADR-0007), and no server is here, so
// an operated control snaps back to its declared value. A hover reaches nobody in the same way.
// Everything the Core owns by itself — the camera, the clock, playback, scrubbing, the ruler and
// the furniture — works as it does live.

import type { Transport } from "./transport.ts";
import { NO_BYTES } from "./transport.ts";
import type { Declaration } from "./transport.ts";
import type { ImagerySpec } from "./scene.ts";
import type { FurnitureDeclaration } from "./furniture.ts";

/**
 * The first line of a recording: the modules the recorded session declared, and the scene it
 * declared them into (ADR-0024).
 *
 * The scene fields are the declaration's own, and every one of them is optional — a recording made
 * before they existed reads as a session that declared none of them, which is what it was. What is
 * *not* here is where files are: the module URLs and the `assets` map were same-origin paths into a
 * server that has stopped, so the replaying page supplies those.
 */
export interface RecordingHeader {
  recording: number;
  modules: { id: string; path: string; apiVersion: number }[];
  ellipsoid?: { a: number; b: number };
  /** Recorded only when the tiles travel: absolute URLs, or `false` for no base layer. */
  imagery?: false | ImagerySpec | ImagerySpec[];
  lighting?: boolean;
  stars?: boolean;
  /** Recorded only when off, since the names and the country borders are drawn by default. */
  namedPlaces?: boolean;
  countryBorders?: boolean;
  /**
   * The Core's own on-screen items. This is also the retained `core/furniture` command, written at
   * offset zero — the same duplication the live declaration carries, and for the same reason: the
   * viewer builds the declared set before it paints, and the command that follows is a no-op.
   */
  furniture?: FurnitureDeclaration;
}

/** One recorded frame: when it was sent, the message, and the region behind it. */
interface RecordedLine {
  t: number;
  msg: { method?: string; params?: unknown };
  blobs?: string;
}

export interface RecordingOptions {
  /**
   * Where the built modules are served from. A recording names each module by the file path it was
   * registered under, so the URL is rebuilt the way the server built it: `<base>/<id>/<filename>`.
   */
  modulesBase?: string;
  /** Maps a module id straight to a URL, for anything `modulesBase` cannot reach. */
  moduleUrls?: Record<string, string>;
  /** Scales the recorded pacing. `2` plays twice as fast; `Infinity` delivers everything at once. */
  speed?: number;
  /** The shape the globe is built on, overriding whatever the recording states. */
  ellipsoid?: { a: number; b: number };
  /**
   * What the globe is textured with, overriding the recording. This is how a basemap the recorded
   * server mounted is named again: those tiles did not travel with the file, so the header states
   * no imagery and only the page knows where they were copied to (ADR-0024).
   */
  imagery?: false | ImagerySpec | ImagerySpec[];
  onWarn?(message: string): void;
}

/** The version this player reads. A version 1 recording carries its arrays as base64 inside the
 * message rather than in a region, and is refused rather than silently drawn wrong. */
export const RECORDING_VERSION = 2;

/**
 * Parse a recording. `text` is the whole JSON Lines file.
 *
 * A malformed line is dropped with a warning rather than failing the session: a recording is
 * flushed per frame, so the last line of one taken from a killed process is often a partial write.
 */
export function parseRecording(
  text: string,
  onWarn: (message: string) => void = console.warn,
): { header: RecordingHeader; lines: RecordedLine[] } {
  const raw = text.split("\n").filter((l) => l.trim() !== "");
  if (raw.length === 0) throw new Error("recording: the file is empty");
  const header = JSON.parse(raw[0]) as RecordingHeader;
  if (header.recording !== RECORDING_VERSION) {
    throw new Error(
      `recording: this player reads version ${RECORDING_VERSION}, and the file states ` +
        `${header.recording}. A version 1 recording carries its arrays inside the message; ` +
        `replay it through Julia, which transcodes one.`,
    );
  }
  const lines: RecordedLine[] = [];
  for (let i = 1; i < raw.length; i++) {
    try {
      lines.push(JSON.parse(raw[i]) as RecordedLine);
    } catch {
      onWarn(`recording: dropping line ${i + 1}, which does not parse`);
    }
  }
  return { header, lines };
}

/**
 * The `modules` declaration the recorded session would have sent, rebuilt from its header.
 *
 * Each URL is made absolute against the page. `import()` refuses a bare specifier, so a relative
 * `modulesBase` would otherwise load nothing and report only a resolver error per module.
 *
 * The scene comes off the header and `opts` wins over it, which is the opposite of the live rule in
 * ADR-0019 and for the reason that rule exists: a server owns a session it is present for, while a
 * header describes one that has ended. Whoever passes an option here — usually `player.html` reading
 * its own address — is repairing the replay, so they are the later word.
 */
export function declarationOf(header: RecordingHeader, opts: RecordingOptions = {}): Declaration {
  const base = (opts.modulesBase ?? "modules").replace(/\/$/, "");
  const modules = header.modules.map((m) => ({
    id: m.id,
    url: absolute(opts.moduleUrls?.[m.id] ?? `${base}/${m.id}/${m.path.split(/[\\/]/).pop()}`),
    apiVersion: m.apiVersion,
  }));
  const declaration: Declaration = { modules };
  if (header.ellipsoid) declaration.ellipsoid = header.ellipsoid;
  if (header.imagery !== undefined) declaration.imagery = header.imagery;
  if (header.lighting) declaration.lighting = true;
  if (header.stars) declaration.stars = true;
  if (header.namedPlaces === false) declaration.namedPlaces = false;
  if (header.countryBorders === false) declaration.countryBorders = false;
  if (header.furniture) declaration.furniture = header.furniture;
  if (opts.ellipsoid) declaration.ellipsoid = opts.ellipsoid;
  if (opts.imagery !== undefined) declaration.imagery = opts.imagery;
  return declaration;
}

const absolute = (url: string): string => {
  const page = typeof document === "undefined" ? undefined : document.baseURI;
  try {
    return new URL(url, page).href;
  } catch {
    return url;
  }
};

const decodeBlobs = (b64: string | undefined): Uint8Array => {
  if (!b64) return NO_BYTES;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** What a recorded `window` frame covers, so a later request for those keyframes can be answered. */
interface WindowSpan {
  startFrame: number;
  count: number;
  line: RecordedLine;
}

/**
 * Plays a parsed recording into the Core.
 *
 * Frames stamped at zero go out as soon as a handler exists for them. `record!` writes whatever the
 * server was retaining at offset zero, so a recording opens with its scene already standing rather
 * than building it over the first seconds.
 */
export class RecordingTransport implements Transport {
  readonly ready = Promise.resolve();
  readonly header: RecordingHeader;
  readonly declaration: Declaration;

  private handlers = new Map<string, (params: unknown, bytes?: Uint8Array) => void>();
  private queued: { method: string; params: unknown; bytes: Uint8Array }[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private windows: WindowSpan[] = [];
  private warn: (message: string) => void;
  private closed = false;
  // Declared rather than written as a constructor parameter property: Node strips types without
  // compiling, and that syntax is one of the few it refuses.
  private opts: RecordingOptions;

  constructor(
    recording: { header: RecordingHeader; lines: RecordedLine[] },
    opts: RecordingOptions = {},
  ) {
    this.opts = opts;
    this.header = recording.header;
    this.warn = opts.onWarn ?? console.warn;
    this.declaration = declarationOf(recording.header, opts);
    this.index(recording.lines);
    this.schedule(recording.lines);
  }

  /** Record what each `window` frame covers. A later `core/need` is answered out of this. */
  private index(lines: RecordedLine[]): void {
    for (const line of lines) {
      if (line.msg?.method !== "window") continue;
      const p = line.msg.params as { startFrame?: number; count?: number } | undefined;
      if (typeof p?.startFrame !== "number" || typeof p?.count !== "number") continue;
      this.windows.push({ startFrame: p.startFrame, count: p.count, line });
    }
  }

  private schedule(lines: RecordedLine[]): void {
    const speed = this.opts.speed ?? 1;
    for (const line of lines) {
      const at = speed === Infinity ? 0 : (line.t ?? 0) * 1000 / speed;
      if (at <= 0) {
        this.emit(line);
      } else {
        this.timers.push(setTimeout(() => this.emit(line), at));
      }
    }
  }

  private emit(line: RecordedLine): void {
    if (this.closed) return;
    const method = line.msg?.method;
    if (!method) return;
    this.deliver(method, line.msg.params, decodeBlobs(line.blobs));
  }

  private deliver(method: string, params: unknown, bytes: Uint8Array): void {
    const handler = this.handlers.get(method);
    handler ? handler(params, bytes) : this.queued.push({ method, params, bytes });
  }

  /**
   * The Core reports upward here. Only one message can be answered without a server: a request for
   * keyframes outside the buffer, which the recording already holds. Everything else needs a
   * decision nobody recorded, so it is dropped.
   */
  notify(method: string, params?: unknown): void {
    if (method !== "event") return;
    const e = params as { module?: string; topic?: string; payload?: unknown } | undefined;
    if (e?.module !== "core" || e?.topic !== "need") return;
    const need = e.payload as { startFrame?: number; count?: number } | undefined;
    if (typeof need?.startFrame !== "number" || typeof need?.count !== "number") return;
    this.serveNeed(need.startFrame, need.count);
  }

  /** Re-deliver every recorded window that overlaps the requested run of keyframes. */
  private serveNeed(startFrame: number, count: number): void {
    const end = startFrame + count;
    const hits = this.windows.filter((w) => w.startFrame < end && w.startFrame + w.count > startFrame);
    if (hits.length === 0) {
      this.warn(`recording: nothing recorded covers frames ${startFrame}..${end - 1}`);
      return;
    }
    for (const w of hits) this.emit(w.line);
  }

  on(method: string, handler: (params: unknown, bytes?: Uint8Array) => void): void {
    this.handlers.set(method, handler);
    // Drained after the whole batch of registrations, so held frames replay in arrival order.
    queueMicrotask(() => {
      const held = this.queued;
      this.queued = [];
      for (const m of held) this.deliver(m.method, m.params, m.bytes);
    });
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/** Fetch and parse a recording, ready to hand to {@link RecordingTransport}. */
export async function fetchRecording(
  url: string,
  onWarn?: (message: string) => void,
): Promise<{ header: RecordingHeader; lines: RecordedLine[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recording: ${url} answered ${res.status}`);
  return parseRecording(await res.text(), onWarn);
}
