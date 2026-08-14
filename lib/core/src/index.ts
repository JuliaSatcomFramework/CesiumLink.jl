import * as Cesium from "@cesium/engine";
import { SceneMode, type CesiumWidget } from "@cesium/engine";
import { buildFurniture } from "./clock-ui";
import { FURNITURE_DEFAULTS, type FurnitureDeclaration } from "./furniture";
import { createScene, type SceneOptions } from "./scene";
import {
  createModuleHost,
  type ModuleCapabilities,
  type ModuleEntry,
  type TrackDisposable,
  type ViewerModule,
} from "./module-host";
import { createPointerDispatch } from "./picking";
import { createCameraAuthority } from "./camera";
import { createAssetUrl, type AssetBase, type AssetMounts } from "./assets";
import { blockAt, decodeArrays, isNdArray } from "./codec";
import { createOverlay, type OverlayRegion } from "./overlay";
import { createWindows, Timeline } from "./windows";
import { NO_BYTES } from "./transport";
import type { Declaration, Transport } from "./transport";

export { blockAt, decodeArrays, isNdArray } from "./codec";
export type { Block, Dtype, NdArray, WireArray } from "./codec";
export { loadImagery } from "./scene";
export type { ImagerySpec, SceneOptions } from "./scene";
export type { AssetBase, AssetMounts } from "./assets";
export { sceneFromQuery } from "./query";
export type { QueryScene } from "./query";
export { firstDeclaration, NO_BYTES, PROTOCOL_VERSION, WsTransport } from "./transport";
export type { Declaration, Transport } from "./transport";
export {
  declarationOf, fetchRecording, parseRecording, RECORDING_VERSION, RecordingTransport,
} from "./recording";
export type { RecordingHeader, RecordingOptions } from "./recording";
export type { At, Frame, Placement, WindowInfo } from "./windows";
export { Timeline } from "./windows";
export type { PickEntity, PointerEvent } from "./picking";
export type {
  AnchorPosition, AnchorResolver, CameraAuthority, FollowAnchor, FollowRequest, GlobeExtent,
  GlobePoint, Viewpoint,
} from "./camera";
/** The shape a module's default export must satisfy, for a module author to annotate against. */
export type { ViewerModule } from "./module-host";
export type { FurnitureDeclaration } from "./furniture";

export interface ViewerOptions extends SceneOptions {
  /**
   * The furniture the server declared, which the Core builds instead of its default set. A host
   * that took the declaration off the transport passes it here, so the first paint already shows
   * the set the session asked for.
   */
  furniture?: FurnitureDeclaration;
  /**
   * How a declared module is imported. Defaults to the native dynamic import, which is correct for
   * a host whose page and modules share one origin. A host that reads the module tree from
   * somewhere else supplies its own resolution here.
   */
  importModule?(url: string): Promise<{ default: ViewerModule }>;
  /**
   * Where this host fetches one assets mount from — a base ending in a slash, or `null` for a mount
   * it cannot reach. Omitted by a host the server serves the page for, where a declared path already
   * resolves against the page. See `ctx.assetUrl`.
   */
  assetBase?: AssetBase;
  /**
   * How this host makes the view fill the screen. Supply it only for a page that has no fullscreen
   * API of its own: the full-screen button then calls this instead of the browser's request, which
   * such a page renders dead. A host that leaves it out keeps Cesium's own button, and a page with
   * no fullscreen API shows no button at all.
   */
  expand?(): void;
}

// The module API this Core implements. Unstable — a declaration must match to load (ADR-0009).
const API_VERSION = 1;

/** One addressed command out of a `commands` batch. `"core"` addresses the Core itself. */
interface Command {
  module: string;
  topic: string;
  payload: unknown;
}

export interface ViewerHandle {
  readonly widget: CesiumWidget;
  /**
   * Attach a transport: its `modules` declaration loads the modules, its messages drive them. A
   * host that read the declaration itself — to build the scene on the ellipsoid it names — passes
   * it here, since it has already been taken off the transport.
   */
  attachTransport(t: Transport, declaration?: Declaration | null): void;
  destroy(): void;
}

/**
 * Create the schema-agnostic Core: the Cesium scene, the shared clock/timeline UI, and the module
 * host. Which modules exist is the server's decision, arriving as the `modules` declaration on the
 * attached transport; each is loaded through one uniform path and receives every rendering
 * capability via its context — the Core itself renders nothing scene-specific.
 */
export async function createViewer(
  container: HTMLElement,
  opts: ViewerOptions,
): Promise<ViewerHandle> {
  const widget = await createScene(container, opts);
  const scene = widget.scene;

  // One overlay for all modules: the Core owns the positioned regions modules add controls to. It is
  // built before the furniture, which contributes its button group to a region like anything else.
  const overlay = createOverlay(container);

  // The Core's own on-screen items: created once, owned by the Core (single clock/timeline for all
  // modules), and persist across windows (like the scene).
  const furniture = buildFurniture(container, scene, widget.clock, overlay, opts.expand);
  const onResize = () => furniture.resize();
  window.addEventListener("resize", onResize);

  // 2D fills the viewport with the flat map, so resolving MSAA over the whole screen every frame
  // costs ~2.5× what 3D does (the globe there covers far fewer pixels) — measured 23→52 fps on this
  // scene. 2D is antialiased raster imagery where edge MSAA barely shows, so drop it in 2D.
  const defaultMsaa = scene.msaaSamples;
  const tuneForMode = () => {
    scene.msaaSamples = scene.mode === SceneMode.SCENE2D ? 1 : defaultMsaa;
  };
  scene.morphComplete.addEventListener(tuneForMode);

  // Bound lazily: events reach whatever transport is attached, and a viewer with none is silent.
  let transport: Transport | null = null;
  // Monotonic per connection. A command batch answering an event echoes it, so a module holding a
  // reply can tell whether it still describes the pointer position that asked for it.
  let seq = 0;
  // Everything the viewer reports travels as one message shape. The Core stamps the sequence number
  // and where the clock was — the frame and the window on screen — so a listener can answer against
  // the scene the user was actually looking at rather than whichever one has since been delivered.
  const sendEvent = (module: string, topic: string, payload: unknown) => {
    transport?.notify("event", {
      module,
      topic,
      seq: ++seq,
      frame: windows.frame?.index ?? null,
      window: windows.info?.id ?? null,
      payload: refuseArrays(payload, `${module}/${topic}`),
    });
  };

  // Nothing travels upward as bytes. Zero arrays go up today — pointer events, `core/need`,
  // control input and `core/ellipsoid` are all scalars — and ADR-0007 makes the server
  // authoritative, so bulk data flowing upward inverts the model rather than using it. The
  // protocol is specified symmetric, so building the upward half later writes an encoder rather
  // than amending a contract.
  const refuseArrays = (value: unknown, where: string): unknown => {
    if (ArrayBuffer.isView(value) || isNdArray(value)) {
      throw new Error(
        `core: ${where} put a typed array in an event payload, and nothing travels upward as ` +
          `bytes. Send Array.from(a) instead.`,
      );
    }
    if (Array.isArray(value)) return value.map((v) => refuseArrays(v, where));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = refuseArrays(v, where);
    return out;
  };

  // The server's queue for this connection filled up and dropped frames. Ask for the retained scene
  // again — the same frames a client connecting now is replayed — because the server holds the last
  // message per (module, topic) and a dropped one is therefore recoverable in full. The window comes
  // back with it, so the scene on screen is the scene the server is on.
  const askReplay = (payload: unknown) => {
    const n = (payload as { n?: number } | null)?.n ?? 0;
    console.warn(`core: the server dropped ${n} frame(s) for this client; asking for a replay`);
    sendEvent("core", "replay", {});
  };

  // One pointer dispatch for all modules: the Core owns the ScreenSpaceEventHandler, resolves a hit
  // to the module that stamped it, and forwards upward only what the subscription asked for.
  const pointer = createPointerDispatch(scene, Cesium, (p) => sendEvent("core", "pointer", p));

  // The one clock, the one delivered buffer, and the coverage bookkeeping behind them: windows are
  // Core-level, so every module reads the same time from the same place.
  const windows = createWindows({
    clock: widget.clock,
    C: Cesium,
    // The Core decides when the buffer needs topping up — nearing the edge the clock is heading for,
    // or scrubbed past coverage — and asks the server for the window that starts there, at the size
    // it names. A server that never answers leaves the clock held at the last covered frame.
    onNeed: (startFrame, count) => sendEvent("core", "need", { startFrame, count }),
    // A declared range is what the ruler shows, so point the ruler at it. Whether the ruler is on
    // screen at all is the server's declaration to make, not this range's.
    onRange: (start, stop) => furniture.zoomTimeline(start, stop),
  });
  // The keyframe readout names the keyframe last crossed into rather than wherever the clock has
  // since run to, so it and the scene report the same frame.
  windows.onKeyframe((index) => {
    const time = windows.keyframeTime(index);
    if (time) furniture.setKeyframe({ time, goTo: () => windows.goToKeyframe(index) });
  });
  // The camera: who holds it, and the declared track that moves it. It reads the clock for the
  // declared range an `at` index counts in and for where the clock stands, so it is built after the
  // windows that answer both.
  const camera = createCameraAuthority(scene, Cesium, {
    window: () => windows.info,
    keyframe: () => windows.frame?.index ?? null,
    // The same move the keyframe readout makes, which is what puts the tour at a keyed stop.
    goToKeyframe: (index) => windows.goToKeyframe(index),
  });
  // The camera-follow item renders from the authority and offers the way back, so the furniture is
  // told about the camera as soon as there is one.
  furniture.followCamera(camera);
  // An `at` entry is scheduled against the scene clock, and this is that clock's crossing. Scrubbing
  // backwards re-evaluates it, so the camera goes back with the scene (ADR-0018).
  windows.onKeyframe((index) => camera.keyframeCrossed(index));
  // A crossing changes what the scene says about the entity under a resting cursor, so the hover is
  // raised again from where the cursor is. Whatever answers a hover answers this one too, and stays
  // the only author of what the box shows.
  windows.onKeyframe(() => pointer.refreshHover());

  /** The four regions, as a runtime list — the wire carries a name and may carry an unknown one. */
  const REGIONS: OverlayRegion[] = ["top-left", "top-center", "top-right", "bottom-right"];

  // Whether the ruler is on screen, which is the half of the stranded-frames check the furniture
  // declaration states. It starts at the default, which is what a session that declares nothing shows.
  let timelineShown = FURNITURE_DEFAULTS.timeline;
  // True while the last check found frames stranded, so each entry into that state warns once. The
  // two halves arrive independently — a range on a `window` message, the furniture on a command —
  // and this file is the only one that holds both.
  let stranded = false;
  const checkStranded = () => {
    const total = windows.info?.totalFrames ?? 0;
    const bad = !timelineShown && total > 1;
    if (bad && !stranded) {
      console.warn(
        `furniture: timeline hidden on a ${total}-keyframe range; frames 2..${total} are unreachable`,
      );
    }
    stranded = bad;
  };

  // The whole furniture set, every time. The viewer obeys a declaration that takes the ruler down
  // and warns about what it strands; it does not refuse it.
  const declareFurniture = (payload: unknown) => {
    const decl = (payload ?? {}) as FurnitureDeclaration;
    let region = decl.region;
    if (region !== undefined && !REGIONS.includes(region)) {
      console.warn(`core: unknown furniture region ${JSON.stringify(region)}; using top-right`);
      region = "top-right";
    }
    furniture.setFurniture({ ...decl, items: decl.items ?? {}, region });
    timelineShown = decl.items?.timeline ?? FURNITURE_DEFAULTS.timeline;
    checkStranded();
  };

  // Whole set as well: a region absent from the payload returns to its Core default.
  const declareRegions = (payload: unknown) => {
    const bags: Partial<Record<OverlayRegion, Record<string, string>>> = {};
    for (const [region, bag] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
      if (!REGIONS.includes(region as OverlayRegion)) {
        console.warn(`core: unknown region ${JSON.stringify(region)}; ignored`);
        continue;
      }
      bags[region as OverlayRegion] = (bag ?? {}) as Record<string, string>;
    }
    overlay.declareRegionStyles(bags);
  };

  // The set the server declared, applied before the browser paints: nothing between the furniture
  // being built and this call awaits, so the default set never reaches the screen. The same set
  // arrives again as a retained `core/furniture` command, which restates what is already on screen.
  if (opts.furniture) declareFurniture(opts.furniture);

  // `track` records every registration this module makes on a Core-owned resource, so unloading it
  // drains them whether or not the module returned a teardown of its own.
  // The mounts the session declares, read live: the declaration arrives after the viewer is built,
  // and every module holds the one `assetUrl` made here.
  let mounts: AssetMounts = {};
  const assetUrl = createAssetUrl(() => mounts, opts.assetBase);

  const makeContext = (id: string, track: TrackDisposable): ModuleCapabilities => ({
    Cesium,
    viewer: widget,
    scene,
    container,
    clock: widget.clock,
    onWindow: (cb) => track(windows.onWindow(id, cb)),
    onFrame: (cb) => track(windows.onFrame(cb)),
    onKeyframe: (cb) => track(windows.onKeyframe(cb)),
    placement: (index) => windows.placement(index),
    // A factory: the store registers nothing here, so it needs no `track` and dies with the
    // module's own reference to it.
    perWindow: <T>() => new Timeline<T>(),
    // The rank rule, re-exported. It reads no Core state, so a module that builds from this tree may
    // import the same two functions from the codec instead.
    isNdArray,
    blockAt,
    get frame() {
      return windows.frame;
    },
    get window() {
      return windows.info;
    },
    pickId: (kind, idx) => pointer.pickId(id, kind, idx),
    // Keyed by the calling module's id, closed over the way `pickId` closes over it, so no module
    // can offer a resolver under another module's name.
    anchors: (resolve) => track(camera.registerAnchors(id, resolve)),
    assetUrl,
    onPointer: (handler) => track(pointer.onPointer(handler)),
    // Only addControl is exposed — a module cannot reach the Core's overlay.destroy().
    overlay: { addControl: (region, el) => track(overlay.addControl(region, el)) },
    notify: (topic, payload) => sendEvent(id, topic, payload),
  });

  const host = createModuleHost({
    apiVersion: API_VERSION,
    makeContext,
    importModule: opts.importModule,
  });

  // A declaration adds to the module set and never replaces it. A scene registers its modules just
  // after its server starts, which can be after this page connected, and the server declares the
  // set again for each one — so a second declaration is the normal way a module that was late
  // reaches a page that was early.
  //
  // Only ids this host does not already hold are loaded. A module already running holds scene state
  // that importing it again would orphan (ADR-0009), so a declaration can add a module and can
  // never reload or drop one.
  const declared = new Set<string>();
  const loadModules = (d: Declaration | null) => {
    // Before the modules, not after: a module may resolve an asset path in its own `setup`. Merged
    // for the same reason the module set is: a mount a running module already resolved against must
    // not disappear under it.
    mounts = { ...mounts, ...((d?.assets ?? {}) as AssetMounts) };
    const fresh = ((d?.modules ?? []) as ModuleEntry[]).filter((m) => !declared.has(m.id));
    for (const m of fresh) declared.add(m.id);
    if (fresh.length === 0) return;
    // Loading is async and the retained commands follow this message immediately; the host
    // retains what arrives before a module's setup and replays it, so nothing is lost.
    void host.loadAll(fresh);
  };

  return {
    widget,
    attachTransport(t, declaration) {
      transport = t;
      t.on("modules", (params) => loadModules(params as Declaration | null));
      // The radii the globe was actually built on. The server declared them, so this says nothing
      // it does not already know — which is the point: a disagreement means the declaration did not
      // reach the widget, and only the two numbers side by side can show that.
      const radii = scene.ellipsoid.radii;
      sendEvent("core", "ellipsoid", { a: radii.x, b: radii.z });
      if (declaration) loadModules(declaration);
      // The only carrier of time-varying scene data: one message per run of keyframes, carrying
      // every module's payload for those frames, so the scene and anything drawn over it cannot
      // disagree about which window they describe.
      t.on("window", (params, bytes) => {
        windows.deliver(params, bytes);
        // A window is where a declared range arrives, and the range is the other half of the check.
        checkStranded();
        // It is also where a re-grid becomes visible, and a re-grid moves every keyframe a track
        // names.
        camera.windowDelivered();
      });
      // Everything that is not a window: a batch of addressed commands, applied in order. The
      // pseudo-module id "core" addresses the Core itself, with five topics: the pointer-event
      // subscription the server derives from its registered listeners, the two declarations of what
      // the Core puts on screen, the camera track, and the count of frames the server dropped for
      // this client.
      t.on("commands", (params, bytes) => {
        const region = bytes ?? NO_BYTES;
        const batch = (params ?? {}) as { seq?: number | null; commands?: Command[] };
        // Present only when the batch answers an event, and then it echoes that event's number.
        // The Core applies every batch: whether a late answer is still worth having depends on what
        // it says, which only the module receiving it knows.
        const seq = batch.seq ?? null;
        for (const c of batch.commands ?? []) {
          // Decoded on the way in, so a handler is given typed arrays rather than the objects that
          // carried them — the same treatment a window's payloads get, and the whole of what the
          // Core reads inside a payload.
          const payload = decodeArrays(c.payload, region);
          if (c.module === "core") {
            if (c.topic === "subscribe") pointer.subscribe(payload);
            else if (c.topic === "furniture") declareFurniture(payload);
            else if (c.topic === "regions") declareRegions(payload);
            else if (c.topic === "camera") camera.declare(payload);
            else if (c.topic === "dropped") askReplay(payload);
            else console.warn(`core: unknown command topic ${c.topic}; ignored`);
            continue;
          }
          host.dispatch(c.module, c.topic, payload, seq);
        }
      });
    },
    destroy() {
      host.unloadAll();
      windows.dispose();
      pointer.destroy();
      camera.destroy();
      overlay.destroy();
      scene.morphComplete.removeEventListener(tuneForMode);
      window.removeEventListener("resize", onResize);
      furniture.destroy();
      widget.destroy();
    },
  };
}
