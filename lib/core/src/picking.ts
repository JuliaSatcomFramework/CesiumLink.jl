// Pointer dispatch, owned by the Core. One ScreenSpaceEventHandler serves every module: per pointer
// move or click the Core reads one pixel, resolves every owned hit under it to the module that
// stamped it, offers the event to every local handler, and forwards it upward only when the
// subscription asks for it. Modules never install a ScreenSpaceEventHandler of their own
// (ADR-0003), so picking stays one coherent interaction.
//
// Nothing here knows what an event *means*, and that includes which entity it is about. The event
// carries the whole stack under the cursor, nearest first; choosing among it needs to know what the
// kinds in it are, which is the listener's knowledge and never the Core's. `entity` is offered as
// the nearest, because most listeners want exactly that.
//
// Local handlers exist for reactions that must not round-trip — anchoring a tooltip, tracking the
// cursor, a hover highlight; anything that decides something is a Julia listener, reached through
// the subscription.
//
// Cesium-injected (`C`) like the clock service, so the dispatch seam unit-tests without WebGL.

import type { Cartesian2, Cartographic, Scene } from "@cesium/engine";

/** A resolved pick hit: the module that stamped the primitive, and its kind/index within it. */
export interface PickEntity {
  readonly module: string;
  readonly kind: string;
  readonly idx: number;
}

/** One pointer event, as local handlers and the upward forwarder both see it. */
export interface PointerEvent {
  readonly type: "hover" | "click";
  /** Everything owned under the cursor, nearest first. Empty on a miss. */
  readonly entities: PickEntity[];
  /** The nearest of `entities`, or null. Which of them the event is *about* is the listener's call. */
  readonly entity: PickEntity | null;
  /** The modifier set held, in a fixed order: some subset of "alt", "ctrl", "shift". */
  readonly mods: string[];
  readonly screen: { x: number; y: number };
  /** The globe coordinate under the cursor. Ray-cast on first call and memoised for this event. */
  getCoordinate(): Cartographic | null;
}

/**
 * One entry of the `core/subscribe` list. An event is forwarded upward if it matches **any** entry.
 * The server derives the list from its registered listeners, so no author writes it by hand.
 */
interface SubscriptionEntry {
  /** `hover` or `click`; absent (or null) matches either. */
  type?: "hover" | "click" | null;
  /** Exact match on the modifier set held. Absent → any state; `[]` → only when none are held. */
  mods?: string[] | null;
  /** If any matching entry sets it, the globe raycast is done and the result travels with the event. */
  coordinate?: boolean | null;
  /** `hover` only; the smallest value among matching entries wins. */
  debounceMs?: number | null;
}

/**
 * What a hover costs upward when no matching subscription entry names a shorter interval. Exported
 * only so `picking.test.mjs` can wait out the debounce without restating the number; nothing outside
 * this file reads it, and nothing outside a test should.
 */
export const DEFAULT_HOVER_DEBOUNCE_MS = 5;

/** The pointer payload as it travels upward, under `event {module: "core", topic: "pointer"}`. */
interface PointerPayload {
  type: "hover" | "click";
  entities: PickEntity[];
  mods: string[];
  screen: { x: number; y: number };
  coordinate?: { lon: number; lat: number; height: number };
}

// The stamp a module puts on a pickable primitive's `id`. A class rather than a plain object so the
// Core recognises its own stamp by identity: a primitive carrying any other id — or none — is
// not an entity, so an unowned decoration never appears in a pointer event at all.
class PickId implements PickEntity {
  constructor(
    readonly module: string,
    readonly kind: string,
    readonly idx: number,
  ) {}
}

export interface PointerDispatch {
  /** The opaque stamp `module` sets as a primitive's `id` to make it pickable. */
  pickId(module: string, kind: string, idx: number): object;
  /** Register a local handler; it sees every event, returns nothing, and cannot bail the others. */
  onPointer(cb: (e: PointerEvent) => void): () => void;
  /** Install the `core/subscribe` list. Anything that is not a list of entries subscribes to nothing. */
  subscribe(entries: unknown): void;
  /**
   * Raise a hover at the resting cursor, as if the pointer had moved there. What the scene shows
   * changes under a still cursor, so whoever answers a hover has to be asked again; nothing happens
   * until the pointer has been over the canvas, once it has left, or when nothing resolves under it
   * and nothing did last time either.
   */
  refreshHover(): void;
  destroy(): void;
}

// Fixed order, so two modifier sets compare as strings.
const MOD_ORDER = ["alt", "ctrl", "shift"] as const;

/** How deep one pixel is read. A stack this long already says more than any listener asks of it. */
const DRILL_LIMIT = 10;

/** The DOM events the modifier state is read off, in both spellings Cesium may be taking input from. */
const MOD_EVENTS = ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup"];

/**
 * Create the Core's pointer dispatch over a scene. `forward` is called with the payload of every
 * event the subscription asks for; the Core stamps the sequence number, frame and window on it.
 */
export function createPointerDispatch(
  scene: Scene,
  C: typeof import("@cesium/engine"),
  forward: (payload: PointerPayload) => void,
): PointerDispatch {
  const local: ((e: PointerEvent) => void)[] = [];
  let subscription: SubscriptionEntry[] = [];

  // The modifier set an event carries is read off the DOM event rather than taken from the input
  // action it arrived through. Capture phase on the canvas runs before Cesium's own listener on it,
  // so what is recorded here is the state of the very event the input action below is about to be
  // given.
  //
  // The two gestures want different readings, and this is the whole reason there are two variables.
  // A hover has no beginning and no end, so what is held right now is what it is about. A click is
  // a gesture with a start, and Cesium raises LEFT_CLICK only once the button is already up — so
  // whatever the live reading says by then, it is not what the user pressed. Pressing alt over a
  // resting cursor and clicking without moving, or letting go of alt a few milliseconds before the
  // button, both delivered the click bare. A gesture carries the modifiers it began with, so a
  // click reads the set latched at the down.
  //
  // The latch survives the move Cesium's click tolerance permits between down and up because
  // `readMods` assigns a fresh array rather than mutating one, so nothing later writes through it.
  //
  // Both spellings of every event are listened for, because which ones the canvas actually receives
  // is not something this code can assume. Cesium takes its input from pointer events where the
  // browser has them, and `preventDefault`s the down it consumes whenever anything has registered
  // LEFT_DOWN — the camera controller always has — which suppresses the compatibility mouse events
  // that would otherwise follow. Measured in headless Chrome, a click on the canvas delivers
  // `pointermove`, `mousemove`, `pointerdown`, `pointerup` and no `mousedown` or `mouseup` at all:
  // listening for `mousedown` alone never saw a gesture start, and the set a click carried was the
  // one left behind by the last move. Hearing every spelling is harmless — a second delivery of one
  // gesture is the same reading again — and it is the only form that does not depend on which
  // compatibility events a given browser chooses to synthesise.
  let mods: string[] = [];
  let downMods: string[] = [];
  const readMods = (e: Event) => {
    const m = e as MouseEvent;
    mods = MOD_ORDER.filter((k) => m[`${k}Key` as const]);
    if (e.type === "pointerdown" || e.type === "mousedown") downMods = mods;
  };
  const canvas = scene.canvas;
  for (const t of MOD_EVENTS) {
    canvas.addEventListener(t, readMods, true);
  }

  // Where the pointer was last seen, and whether it is still there. A hover raised without a mouse
  // event behind it needs both: the pixel to pick at, and the fact that there is a cursor over it.
  //
  // The position a hover arrives with cannot be kept by reference: ScreenSpaceEventHandler holds one
  // module-level move event and clones each new position into its single `endPosition`, so that
  // object is shared by every handler on the page — Cesium's own camera controller included — and
  // whoever moves next overwrites it. Cloned into a scratch of this dispatch's own, reused so a
  // resting cursor costs no allocation.
  const cursorAt = new C.Cartesian2();
  let cursor: Cartesian2 | null = null;
  let inside = false;
  // Whether the last hover resolved to nothing, from any hover — a clock-driven refresh is compared
  // against whatever was under the cursor last, however that was raised.
  let lastHoverEmpty = true;
  const leave = () => {
    inside = false;
  };
  canvas.addEventListener("mouseleave", leave, true);

  // Everything owned under one pixel, nearest first. The Core reports the whole stack because it has
  // no way to tell which of them the pointer was aimed at — a highlight drawn over the shape it
  // belongs to is topmost and is not what the user meant, and only a listener that knows what these
  // kinds *are* can say so. Hits carrying no stamp belong to nobody and are dropped.
  const pickAt = (pos: Cartesian2): PickEntity[] => {
    const stack: PickEntity[] = [];
    const seen = new Set<string>();
    for (const h of scene.drillPick(pos, DRILL_LIMIT) as { id?: unknown }[]) {
      // Two ways a primitive names its entity, tried in this order. Its `id` is the stamp, which is
      // what a module setting up its own primitives does. Or its `id` carries the stamp on `pickId`,
      // which is what a module drawing through the entity API has to do: Cesium's visualizers set an
      // entity's primitives' `id` to the `Entity` itself, so the stamp cannot be the `id` there.
      //
      // `instanceof` stays first, so a primitive carrying no stamp is decoration and never masks a
      // pickable underneath it — and a stamp reached the second way is a stamp this Core minted, so
      // borrowing an identity still needs the owning module to have offered it.
      const on = h?.id;
      const id = on instanceof PickId ? on : (on as { pickId?: unknown } | null)?.pickId;
      if (!(id instanceof PickId)) continue;
      // One entity may be drawn by several primitives sharing its stamp — an area's fill and its
      // outline — and the stack is a list of entities, not of primitives.
      const key = `${id.module}|${id.kind}|${id.idx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(id);
    }
    return stack;
  };

  const buildEvent = (type: "hover" | "click", pos: Cartesian2): PointerEvent => {
    const held = type === "click" ? downMods : mods;
    const entities = pickAt(pos);
    let coord: Cartographic | null | undefined; // undefined = not yet computed (memo sentinel)
    return {
      type,
      entities,
      entity: entities[0] ?? null,
      mods: held,
      screen: { x: pos.x, y: pos.y },
      getCoordinate() {
        if (coord === undefined) {
          const ray = scene.camera.getPickRay(pos);
          const c = ray ? scene.globe.pick(ray, scene) : undefined;
          coord = c ? C.Cartographic.fromCartesian(c) : null;
        }
        return coord;
      },
    };
  };

  const sameMods = (want: string[], held: string[]) =>
    want.length === held.length && want.every((m) => held.includes(m));

  const matching = (e: PointerEvent) =>
    subscription.filter(
      (s) =>
        (s.type == null || s.type === e.type) && (s.mods == null || sameMods(s.mods, e.mods)),
    );

  const payloadOf = (e: PointerEvent, coordinate: boolean): PointerPayload => {
    const p: PointerPayload = {
      type: e.type,
      entities: e.entities,
      mods: e.mods,
      screen: e.screen,
    };
    const c = coordinate ? e.getCoordinate() : null;
    if (c) {
      p.coordinate = {
        lon: C.Math.toDegrees(c.longitude),
        lat: C.Math.toDegrees(c.latitude),
        height: c.height,
      };
    }
    return p;
  };

  // A hover is forwarded on the trailing edge of its debounce interval, so a sweep across the globe
  // costs one round trip rather than one per rendered move. The event object is held rather than its
  // payload, so a coordinate nobody has asked for yet is still not ray-cast.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held: { e: PointerEvent; coordinate: boolean } | null = null;
  const flush = () => {
    timer = null;
    const h = held;
    held = null;
    if (h) forward(payloadOf(h.e, h.coordinate));
  };

  const handle = (type: "hover" | "click", pos: Cartesian2, fromClock = false) => {
    if (type === "hover") {
      cursor = C.Cartesian2.clone(pos, cursorAt);
      inside = true;
    }
    const e = buildEvent(type, pos);
    if (type === "hover") {
      const empty = e.entities.length === 0;
      const wasEmpty = lastHoverEmpty;
      lastHoverEmpty = empty;
      // A crossing over a resting cursor is raised because what the scene says may have changed, so
      // an entity that stayed the same still has to be re-answered and one that became nothing has
      // to go or the box never hides. Nothing that was already nothing is the one case with nothing
      // to say: the cursor has not moved either, so the screen position and the globe coordinate are
      // the ones already sent. A cursor parked over empty globe would otherwise cost a round trip
      // every keyframe for as long as it rests there. A real move over empty globe is not the same
      // and keeps its event — the position under it is new, and a listener may have subscribed with
      // `coordinate` for exactly that.
      if (fromClock && empty && wasEmpty) return;
    }
    // Local first, and unconditionally: a handler tracking the cursor must see the move whether or
    // not anything upstream cares about it.
    for (const cb of [...local]) {
      try {
        cb(e);
      } catch (err) {
        console.warn(`pointer: local handler threw: ${err}`);
      }
    }
    const entries = matching(e);
    if (entries.length === 0) return; // nobody upstream is waiting for this one
    const coordinate = entries.some((s) => s.coordinate === true);
    if (type === "click") {
      forward(payloadOf(e, coordinate));
      return;
    }
    const debounceMs = Math.min(...entries.map((s) => s.debounceMs ?? DEFAULT_HOVER_DEBOUNCE_MS));
    held = { e, coordinate };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, debounceMs));
  };

  // ScreenSpaceEventHandler keys its actions on the *whole* set held — `getInputEventKey` joins
  // every modifier in the array it is given — and fires none of the unmodified actions while any
  // modifier is down. An action is therefore registered for every subset of the three, eight
  // including the bare one. Registering only the singletons leaves a two-modifier gesture looking up
  // a key no action was stored under, and Cesium then silently does nothing: an alt+shift click
  // reaches the canvas and never reaches the Core at all.
  //
  // Which modifiers were actually held still comes from the DOM reading above, never from the subset
  // the gesture arrived through — for a click the two routinely disagree, since Cesium picks the key
  // from the mouseup while the click reports what was held at mousedown. Covering every subset is
  // what makes that harmless: the gesture arrives whichever key it comes through, and the key is
  // discarded.
  const handler = new C.ScreenSpaceEventHandler(canvas);
  const slots = [C.KeyboardEventModifier.ALT, C.KeyboardEventModifier.CTRL,
                 C.KeyboardEventModifier.SHIFT];
  for (let bits = 0; bits < 1 << slots.length; bits++) {
    const held = slots.filter((_, i) => bits & (1 << i));
    const mod = held.length ? held : undefined;
    handler.setInputAction(
      (m: { endPosition: Cartesian2 }) => handle("hover", m.endPosition),
      C.ScreenSpaceEventType.MOUSE_MOVE,
      mod,
    );
    handler.setInputAction(
      (m: { position: Cartesian2 }) => handle("click", m.position),
      C.ScreenSpaceEventType.LEFT_CLICK,
      mod,
    );
  }

  return {
    pickId: (module, kind, idx) => new PickId(module, kind, idx),
    onPointer(cb) {
      local.push(cb);
      return () => {
        const i = local.indexOf(cb);
        if (i >= 0) local.splice(i, 1);
      };
    },
    refreshHover() {
      // Through `handle`, not around it: the re-dispatch picks again — what is under that pixel may
      // have changed — and travels the same local-handler, subscription and debounce path as a hover
      // the user raised, so nothing downstream has to know which kind it got. Whether it is worth
      // raising is decided in there too, after the pick: deciding out here would have to pick first
      // to know, and the pick is the expensive half.
      if (inside && cursor) handle("hover", cursor, true);
    },
    subscribe(entries) {
      subscription = Array.isArray(entries) ? (entries as SubscriptionEntry[]) : [];
      if (subscription.length === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
        held = null;
      }
    },
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      held = null;
      handler.destroy();
      for (const t of MOD_EVENTS) {
        canvas.removeEventListener(t, readMods, true);
      }
      canvas.removeEventListener("mouseleave", leave, true);
    },
  };
}
