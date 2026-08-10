// Cesium-free Core module host: version-gates, loads, and tears down the ES modules the server
// declared, and routes each inbound command to the module that registered its topic. It never
// imports cesium at runtime — the rendering capabilities a module needs (viewer, scene, clock, the
// shared Cesium namespace) arrive through the injected context (makeContext), so this module stays
// unit-testable without WebGL.

import type { CesiumWidget, Clock, Scene } from "@cesium/engine";
import type { AnchorResolver } from "./camera";
import type { Block, NdArray } from "./codec";
import type { PointerEvent } from "./picking";
import type { OverlayControls } from "./overlay";
import type { Disposable, Frame, Placement, Timeline, WindowInfo } from "./windows";

export type { Disposable };

/**
 * The single options-bag a module's setup() receives. A module reads only the keys it needs, so
 * adding keys is never a breaking change. Every capability is supplied here — a module never
 * `import`s cesium itself, so it shares the Core's one @cesium/engine instance (mixing two would
 * be the dual-package hazard: primitives built by one couldn't be added to the other's scene).
 *
 * Unstable: the contract is apiVersion-gated, so a version-mismatched module is rejected at load
 * rather than breaking mysteriously at runtime.
 */
export interface ModuleContext {
  readonly id: string;
  /**
   * The exports of another declared module — code only: classes, factories, functions (ADR-0006).
   * Every module the same declaration named is reachable, whatever the order the two were declared
   * in; a module never reaches its own exports, and an undeclared id → undefined.
   *
   * Order does still decide *when* a peer's setup has run. A lookup made during this module's own
   * setup can hand back a peer whose setup has not run yet, so an accessor that reads state the
   * peer builds in setup would answer undefined — the host warns when that happens. Call a peer
   * from a frame, window or command callback and the whole declared set is ready.
   */
  readonly modules: { get(id: string): unknown | undefined };
  /** The one shared Cesium namespace. Modules build primitives/colors from this, not an import. */
  readonly Cesium: typeof import("@cesium/engine");
  readonly viewer: CesiumWidget;
  readonly scene: Scene;
  readonly container: HTMLElement;
  /** The Core's clock. The Core owns the clock and timeline UI; modules drive their own animation. */
  readonly clock: Clock;
  /**
   * Called once per delivered window, with the payload addressed to **this** module — already
   * decoded, so encoded arrays have become typed arrays. A module absent from a window's payload map
   * is not called for that window. A module that registers after a window landed is handed it
   * immediately, so registration order does not decide whether it has a scene.
   */
  onWindow(cb: (w: WindowInfo, payload: unknown) => void): Disposable;
  /**
   * Called every render tick the buffer covers the clock for: `index` is the bracketing **absolute**
   * keyframe, `alpha ∈ [0,1)` the blend toward `index + 1`. This is where interpolation happens — in
   * the module, next to its own arrays, and never throttled. A module maps `index` to its own arrays
   * through the `startFrame` of the window it holds.
   */
  onFrame(cb: (f: Frame) => void): Disposable;
  /**
   * Called once per crossing into an absolute keyframe index, for every module — not only one
   * driving a scene, so an overlay can key per-frame text off it. A module that registers after a
   * window landed is handed that window's crossing one microtask later. Register this and
   * `onWindow` in either order: the store holds the window before the crossing arrives.
   */
  onKeyframe(cb: (index: number) => void): Disposable;
  /**
   * The window carrying absolute keyframe `index`, and the offset within it — which is the index a
   * payload's per-keyframe arrays are actually cut by. Null where no retained window covers that
   * keyframe, which is not an error: windows and crossings arrive independently, and a module with
   * nothing to say for a keyframe leaves what is on screen alone.
   *
   * A module keeps its own slice of a window's payload in a `perWindow` store and reads it at the
   * placement this hands back. Rebuilding this mapping module-side is the same bookkeeping a second
   * time, against a retention bound that then has to be kept in step.
   */
  placement(index: number): Placement | null;
  /**
   * A store for what a window handed this module, keyed on the window itself. Call it once per thing
   * to address by window; each call hands back a store of its own.
   *
   * It is a factory. It registers nothing on the Core and returns no `Disposable`, so the store dies
   * with the module's own reference to it.
   */
  perWindow<T>(): Timeline<T>;
  /** Whether a decoded payload value is an encoded array, which is what `blockAt` slices. */
  isNdArray(v: unknown): v is NdArray;
  /**
   * The block of `a` that keyframe `k` addresses, against a window of `count` keyframes, or null
   * where the array says nothing about `k`. `baseRank` is the rank of the form the caller expects: an
   * array at or below it holds one value for the whole window, and an array one rank above it carries
   * a leading keyframe axis. The module keeps its own domain checks; this is the arithmetic only.
   */
  blockAt(a: NdArray, k: number, baseRank: number, count: number): Block | null;
  /**
   * Where the clock is now, or null before the first tick. This is where the *user* is, so a scrub
   * past the delivered frames reports the index they went to rather than the last one painted — it
   * is the index the Core stamps on this module's events, and answering for anything else asks the
   * server for a window that repaints nothing. It may therefore name a keyframe this module holds no
   * data for, in which case its own lookup misses and it draws nothing, which is what the held clock
   * is already saying.
   */
  readonly frame: Frame | null;
  /**
   * The window the scene currently shows, or null before the first one is delivered. A module naming
   * `window.id` in a request can drop a reply that arrives after the identity changed, since a
   * `replace` may have renumbered the entities the reply's indices addressed (ADR-0008).
   */
  readonly window: WindowInfo | null;
  /**
   * Register the single handler for this module's command `topic`; returns a Disposable that
   * unregisters. One handler per topic: a second registration is refused and warned about, so a
   * module cannot silently shadow its own routing.
   *
   * `seq` is the sequence number of the event the batch answers, or null for a command the server
   * sent on its own. **Deciding what to do with a stale reply is this module's business, not the
   * Core's**: the Core never drops a batch, because a late answer to a click can still be worth
   * applying while a late answer to a hover usually is not, and only the module holding it knows
   * which it has. A module that cares compares `seq` against the last event it saw.
   */
  onCommand(topic: string, handler: (payload: unknown, seq: number | null) => void): Disposable;
  /**
   * The opaque stamp to set as a pickable primitive's `id`. It carries this module's identity, which
   * is how the Core learns who owns a hit; a primitive without one is drilled past rather than
   * picked, so a decoration never masks what it is drawn over.
   */
  pickId(kind: string, idx: number): object;
  /**
   * Offer the Core a way to turn one of this module's target names into a live position, so a
   * viewpoint can ride an entity this module draws. Returns a Disposable that withdraws the offer.
   *
   * The Core never reads a target string: it hands the string back to whichever module a viewpoint
   * named, and takes the getter that comes out. Answer null for a name this module does not know.
   * The getter answers null once the thing is gone, and the camera then lets go.
   *
   * The getter is asked afresh every rendered frame, so answer with where the thing is now. Nothing
   * has to predict: the camera rides the anchor from the moment a stop applies, and it closes on
   * whatever seat that stop asked for inside the frame it is already riding.
   */
  anchors(resolve: AnchorResolver): Disposable;
  /**
   * The URL this host fetches a declared same-origin path from. `assets/<mount>/<file>` is what a
   * payload carries; what comes back is what `fetch` or a Cesium loader can use.
   *
   * A path that names no mount answers `null` and warns once, and the caller draws what it can. It
   * never throws. See the `assets` map in `docs/protocol.md`.
   */
  assetUrl(path: string): string | null;
  /**
   * Register a local pointer handler. Every handler sees every event, returns nothing and cannot
   * bail the others. This is for reactions that must not round-trip — anchoring a tooltip, tracking
   * the cursor, a hover highlight; anything that *decides* something is a listener on the server,
   * reached through the subscription.
   */
  onPointer(handler: (e: PointerEvent) => void): Disposable;
  /** Contribute overlay DOM into a Core-owned region; the Core positions and stacks it (ADR-0004). */
  readonly overlay: OverlayControls;
  /**
   * Report upward as `event {module: <this>, topic, payload}`; the Core stamps the sequence number,
   * the frame and the window. Subject to no subscription — the module already decided to send it.
   * A no-op with no transport.
   */
  notify(topic: string, payload?: unknown): void;
}

/** The capabilities the host caller supplies per module; the host adds `id`, `modules`, `onCommand`. */
export type ModuleCapabilities = Omit<ModuleContext, "id" | "modules" | "onCommand">;

/**
 * Records a disposable against the module being built, and hands it back. Every capability that
 * registers something on a Core-owned resource — a pick handler, an overlay control, a playback —
 * must pass its remover through this, so unload drains it whether or not the module bothered to.
 */
export type TrackDisposable = <T extends Disposable>(dispose: T) => T;

export interface ViewerModule {
  /** Runs once when the module loads. May return a cleanup, called on unload. */
  setup(ctx: ModuleContext): void | Disposable;
}

/** One entry of the server's `modules` declaration: what to load, from where, against which API. */
export interface ModuleEntry {
  id: string;
  /** Same-origin URL of the ES module itself, as the server generated it from the registered path. */
  url: string;
  /** Gated against the host's own before the import; a mismatch is skipped, never run. */
  apiVersion: number;
}

interface ModuleHostDeps {
  /** apiVersion this host implements; a declaration must match to load. */
  apiVersion: number;
  /** Build one module's capabilities; `track` records anything the module registers on the Core. */
  makeContext(id: string, track: TrackDisposable): ModuleCapabilities;
  /** Imports a declared module. Defaults to native dynamic import(). */
  importModule?(url: string): Promise<{ default: ViewerModule }>;
  /** Loud, non-fatal warning sink. Defaults to console.warn. */
  onWarn?(message: string): void;
}

export interface ModuleHost {
  /**
   * Load `entries` in three passes: import them all concurrently, then run every `setup` in
   * declaration order, then replay retained commands for all of them. Splitting import from setup
   * is what lets a consumer reach a provider declared after it; deferring the replay is what lets a
   * command applied at load — a `ui` declaration naming a widget kind, or a float mounting another
   * module — see contributions from modules declared later. Declaration order therefore decides
   * only draw order and overlay stacking.
   */
  loadAll(entries: ModuleEntry[]): Promise<void>;
  /**
   * Tear one module down: drain its disposables and drop its topic handlers. This is the teardown
   * seam `unloadAll` is built from, and the only way to express unloading one of two loaded modules.
   * A module set is per-connection (ADR-0009), so no product code calls it.
   */
  unload(id: string): void;
  unloadAll(): void;
  /** Whether `id` is loaded. Host-facing, like `unload`: it is how teardown is checked. */
  has(id: string): boolean;
  /**
   * Route one command to the module+topic handler, carrying the `seq` of the event its batch
   * answers. Unknown module/topic or a throwing handler → warned, never thrown.
   */
  dispatch(module: string, topic: string, payload: unknown, seq?: number | null): void;
}

type TopicHandler = (payload: unknown, seq: number | null) => void;

/** One module past the version gate and imported, waiting for its setup. */
interface Imported {
  entry: ModuleEntry;
  mod: { default: ViewerModule };
}

export function createModuleHost(deps: ModuleHostDeps): ModuleHost {
  const importModule =
    deps.importModule ?? ((url: string) => import(url) as Promise<{ default: ViewerModule }>);
  const warn = deps.onWarn ?? ((m: string) => console.warn(m));
  // Per module: the disposables to run on unload — setup()'s returned cleanup plus every topic
  // handler the module registered through its context.
  const loaded = new Map<string, Disposable[]>();
  // Envelope routing table: module id → its topic → the one registered handler.
  const routing = new Map<string, Map<string, TopicHandler>>();
  // Every imported module's exports, in declaration order, backing ctx.modules.get. Populated for
  // the whole declared set before any setup runs, which is what makes ctx.modules order-free.
  const exports = new Map<string, unknown>();
  // Ids whose setup has returned, and whether a setup pass is running at all. Together they catch
  // the one thing declaration order still governs: a peer reached before its own setup ran hands
  // back exports whose stateful accessors answer undefined.
  const ready = new Set<string>();
  let settingUp = false;
  // Ids declared but not through loading yet. A command for one of these has nowhere to go yet and
  // is retained silently; a command for anything else is a stray and says so.
  const pending = new Set<string>();
  // Retained state: module id → its topic → the latest delivered command, in recency order (a topic
  // re-delivered moves to the end). A loading module is replayed this state once every module's
  // setup has run, in that order, so the most recently sent topic is applied last. This is what
  // makes the server's reconnect replay safe: `modules` arrives first and the imports that answer it
  // are async, so the retained commands behind it land before any handler exists. The `seq` is
  // retained with the payload, so a handler seeing a replay judges its staleness against the event
  // it answered rather than against whenever the module finished loading. Kept across unload so a
  // reload restores.
  const retained = new Map<string, Map<string, { payload: unknown; seq: number | null }>>();

  // Phase 1: gate and import, running no module's setup. Concurrent, since nothing here depends on
  // anything else here — the browser resolves each module's own static imports itself. A hanging
  // import therefore stalls every module's setup, not only the ones declared after it; the modules
  // are served same-origin by the same server that sent the declaration, so that is the same risk
  // the last-declared module already carried.
  async function importOne(entry: ModuleEntry): Promise<Imported | null> {
    if (loaded.has(entry.id)) {
      // Refuse a silent reload: overwriting the entry would orphan the first instance's
      // disposables, leaving listeners that unload can never drain.
      warn(`module ${entry.id}: already loaded; skipped`);
      return null;
    }
    if (entry.apiVersion !== deps.apiVersion) {
      // Gate BEFORE importing: a version-mismatched module must never have its code run.
      warn(`module ${entry.id}: apiVersion ${entry.apiVersion} != host ${deps.apiVersion}; skipped`);
      return null;
    }
    try {
      return { entry, mod: await importModule(entry.url) };
    } catch (err) {
      // One module's failure must not abort the others, nor take down the viewer.
      warn(`module ${entry.id}: load failed: ${err}`);
      return null;
    }
  }

  // Phase 2: run one module's setup. Every imported module's exports are already in `exports`, so
  // which of them this one can reach does not depend on where either was declared.
  function setupOne({ entry, mod }: Imported): void {
    const disposables: Disposable[] = [];
    const topics = new Map<string, TopicHandler>();
    routing.set(entry.id, topics);
    const onCommand: ModuleContext["onCommand"] = (topic, handler) => {
      if (topics.has(topic)) {
        // One handler per topic (CONTEXT.md): keep the first, so a module can't silently shadow
        // its own topic routing. The second registration is inert.
        warn(`module ${entry.id}: topic ${topic} already has a handler; ignored`);
        return () => {};
      }
      topics.set(topic, handler);
      const dispose = () => {
        if (topics.get(topic) === handler) topics.delete(topic);
      };
      disposables.push(dispose);
      return dispose;
    };
    // What this module may reach through ctx.modules: every other module the same declaration
    // named, whatever the order. The exports are all there because every import finished before any
    // setup began; what they *do* becomes live as that module's own setup runs, so reaching one
    // mid-setup is warned about rather than silently answering undefined. The exports come back
    // either way — the warning changes no behaviour.
    const peer = (id: string): unknown => {
      if (id === entry.id) return undefined;
      if (settingUp && exports.has(id) && !ready.has(id)) {
        warn(
          `module ${entry.id}: reached ${id} during setup, before ${id}'s own setup ran; ` +
            `its state is not built yet — read it from a frame, window or command callback instead`,
        );
      }
      return exports.get(id);
    };
    // Attach id/modules/onCommand onto the capabilities object rather than spreading it: makeContext
    // may expose live accessors (ctx.frame reads where the clock is now), and a spread invokes each
    // getter once and freezes the value at load time — before any window has been delivered.
    const track: TrackDisposable = (dispose) => {
      disposables.push(dispose);
      return dispose;
    };
    const ctx = Object.assign(deps.makeContext(entry.id, track), {
      id: entry.id,
      modules: { get: peer },
      onCommand,
    }) as ModuleContext;
    const cleanup = mod.default.setup(ctx);
    if (typeof cleanup === "function") disposables.push(cleanup);
    loaded.set(entry.id, disposables);
    ready.add(entry.id);
  }

  // Phase 3: replay retained state to the registered handlers, in recency order so the most
  // recently sent topic is applied last — whether it arrived while this import was in flight or
  // before an earlier instance was unloaded. Deferred until every module's setup has run, so a
  // command applied at load sees what the whole declared set contributed, not only the modules
  // declared ahead of its own.
  function replayOne(id: string): void {
    const byTopic = retained.get(id);
    const topics = routing.get(id);
    if (!byTopic || !topics) return;
    for (const [topic, { payload, seq }] of byTopic) {
      const handler = topics.get(topic);
      if (!handler) continue;
      try {
        handler(payload, seq);
      } catch (err) {
        warn(`module ${id}: topic ${topic} retained replay threw: ${err}`);
      }
    }
  }

  async function loadAll(entries: ModuleEntry[]): Promise<void> {
    for (const entry of entries) pending.add(entry.id);
    const imported = (await Promise.all(entries.map(importOne))).filter(
      (one): one is Imported => one !== null,
    );
    for (const one of imported) exports.set(one.entry.id, one.mod);
    // Setup stays in declaration order: it is what decides draw order and overlay stacking, which
    // is the one thing the author should still be choosing.
    settingUp = true;
    for (const one of imported) {
      try {
        setupOne(one);
      } catch (err) {
        // A module whose setup throws leaves nothing behind: no routing to receive commands, and no
        // exports for a peer to reach into.
        routing.delete(one.entry.id);
        exports.delete(one.entry.id);
        warn(`module ${one.entry.id}: load failed: ${err}`);
      }
    }
    settingUp = false;
    for (const entry of entries) pending.delete(entry.id);
    for (const one of imported) replayOne(one.entry.id);
  }

  function unload(id: string): void {
    const disposables = loaded.get(id);
    routing.delete(id);
    exports.delete(id);
    ready.delete(id);
    if (!disposables) return;
    for (const dispose of disposables) dispose();
    loaded.delete(id);
  }

  function dispatch(module: string, topic: string, payload: unknown, seq: number | null = null): void {
    const handler = routing.get(module)?.get(topic);
    if (!handler && !pending.has(module)) {
      // A command for a module that is neither loaded nor loading is version skew or a stray, and
      // is dropped without retaining it — the retention table is keyed by ids off the wire, so
      // anything else lets a remote peer grow it without bound. Never fatal (CONTEXT.md / 9, 29).
      warn(`command for unknown module/topic ${module}/${topic}; ignored`);
      return;
    }
    // Retain before delivering: a command whose module is still importing has nowhere to go yet,
    // and load() replays what it finds here. Retained per topic, moved to most-recent (delete+set),
    // so replay applies topics in send order.
    let byTopic = retained.get(module);
    if (!byTopic) retained.set(module, (byTopic = new Map()));
    byTopic.delete(topic);
    byTopic.set(topic, { payload, seq });
    if (!handler) return;   // declared, still importing: setup's handlers get it from the replay
    try {
      handler(payload, seq);
    } catch (err) {
      // A throwing handler kills only its own message, not the frame loop or other modules.
      warn(`module ${module}: topic ${topic} handler threw: ${err}`);
    }
  }

  return {
    loadAll,
    unload,
    unloadAll: () => {
      for (const id of [...loaded.keys()]) unload(id);
    },
    has: (id) => loaded.has(id),
    dispatch,
  };
}
