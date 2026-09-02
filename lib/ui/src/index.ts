// Everything on top of the globe: the overlay panel, the widget registry, the tooltip and the
// floating objects. All of it is inert until Julia addresses it — the overlay is one declared list,
// the floats are another, and a tooltip is a hover listener's answer — which is why they are one
// module rather than one per widget family.
//
// The declaration is the whole overlay: re-declaring replaces it, so removing a legend means
// declaring without it, and the list's order is the order the widgets stack in. It is retained by
// the server, so a reconnecting browser comes back to the same overlay and to the values its scene
// was actually filtered with.
//
// Applying a declaration is reconciled, not rebuilt: a row whose spec is unchanged keeps the element
// it already had. That is a guarantee Julia may rely on, because a widget holds live state the
// declaration does not describe — an open `<select>` popup closes the moment its element leaves the
// document, and a scene that re-declares after every window push would slam it shut on a timer.
//
// A widget that names `keyframed` fields also reads the window addressed to this module, and takes
// each named field's value for the keyframe the clock crosses into. The declaration stays the whole
// structure — an entry supplies values for the fields it named and nothing else — and the values
// ride the retained window, so display content follows the clock with no event and no round trip.
// It is display content only: a value the user also owns is a re-declaration, where the precedence
// between an interaction and the timeline is decided rather than raced. A float's keyframed content
// works the same way and shares the id space, since one window's `per_keyframe` entries address
// both.
//
// This is also the one file here that touches Cesium: an anchored float is projected from a world
// position to a screen point, and `floating.ts` is handed the point exactly as the cursor path hands
// one to `place()`. Everything else stays testable without WebGL.

import type { Cartesian3 } from "@cesium/engine";
import type { Disposable, ModuleContext } from "../../core/src/module-host.ts";
import { blockAt, isNdArray } from "../../core/src/codec.ts";
import { REGIONS, type OverlayRegion } from "../../core/src/overlay.ts";
import { applyStyle, build, clearWidgets, el, PANEL, type Track, type Widget,
         type WidgetSpec } from "./widgets.ts";
import { createFloats, type Anchor, type MountFactory } from "./floating.ts";
import { createTooltip } from "./tooltip.ts";

export { defineWidget } from "./widgets.ts";
export type { Mount, MountFactory, MountSite } from "./floating.ts";

// A group's own chrome, under whatever the declaration adds: a column of its children, so laying
// two legends side by side costs the one property `flex-direction` and no new widget kind.
const GROUP = PANEL + ";display:flex;flex-direction:column;gap:6px";

// Fixed order, so two modifier sets compare as lists. The Core reads its own the same way.
const MOD_ORDER = ["alt", "ctrl", "shift"] as const;

/** What an addressed box raises. A box has edges, so it is entered and left once each. */
type PointerType = "click" | "enter" | "leave";

/**
 * One entry of the `ui/subscribe` list. A crossing is sent upward if it matches **any** entry, and
 * a null in any field matches anything. The server derives the list from its registered listeners,
 * so no author writes it by hand.
 */
interface PointerSubscription {
  /** The addressed box; absent (or null) matches every one of them. */
  id?: string | null;
  type?: PointerType | null;
  /** Exact match on the modifier set held. Absent → any state; `[]` → only when none are held. */
  mods?: string[] | null;
}

/** Two modifier sets are the same set, whatever order they are written in. */
const sameMods = (want: string[], held: string[]) =>
  want.length === held.length && want.every((m) => held.includes(m));

/** A mounted row: what it was declared as, what it put on screen, and how to take it back off. */
interface Row {
  /** What makes this the same row across two declarations: its kind, its id and its region. */
  key: string;
  /** The declared spec, verbatim: a row whose spec is unchanged is left exactly where it is. */
  json: string;
  el: HTMLElement | null;
  dispose: (() => void) | null;
  onKeyframe?: (index: number) => void;
  /** The trackers of this row's keyframed fields and, for a group, of its children's. */
  tracks: Track[];
}

/** One declared row, resolved: the spec its widget is built from, and where it belongs. */
interface Declared {
  spec: WidgetSpec;
  region: OverlayRegion;
  key: string;
  json: string;
}

/** A built row, and whatever within it a window may address. */
interface Built {
  widget: Widget;
  tracks: Track[];
  /** Drops the listeners of the addressed boxes inside this one: a group's children carry ids too. */
  unwatch?: () => void;
}

/** What a window carries for the overlay: per addressed id, per field, one value per keyframe. */
interface OverlayWindow {
  per_keyframe?: Record<string, Record<string, unknown> | undefined>;
}

/**
 * The tracker for `spec`, or null when it named no keyframed field — or named one without carrying
 * the id a window addresses it by.
 */
function trackOf(spec: WidgetSpec, show: (index: number) => void): Track | null {
  const named = (Array.isArray(spec.keyframed) ? spec.keyframed : [])
    .filter((f): f is string => typeof f === "string");
  if (!named.length) return null;
  if (spec.id == null) {
    console.warn(`ui: ${JSON.stringify(spec.kind)} declares keyframed fields but no id, ` +
                 "so no window can address it");
    return null;
  }
  return { id: String(spec.id), fields: new Set(named), spec, show };
}

/**
 * One track's value at window-relative keyframe `k` of a window of `count` keyframes, or undefined
 * where the track has none. The base rank of a track is 0: it carries one value per keyframe, and
 * nothing below that. A track of numbers or flags arrives decoded as `{data, shape}`; a track of
 * label strings arrives as a plain list, which is indexed directly.
 */
function valueAt(track: unknown, k: number, count: number): unknown {
  if (Array.isArray(track)) return track[k];
  if (!isNdArray(track)) return undefined;
  const block = blockAt(track, k, 0, count);
  return block ? track.data[block.offset] : undefined;
}

/**
 * The window point a world position projects to, or null where it does not project — behind the
 * camera, or before Cesium is reachable at all. This is the whole of what `ui` asks of the scene.
 */
function project(ctx: ModuleContext, world: Cartesian3): { x: number; y: number } | null {
  const at = ctx.Cesium?.SceneTransforms?.worldToWindowCoordinates(ctx.scene, world);
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null;
}

/**
 * Where an anchor sits on screen now. A `screen` anchor is already there; the other two are world
 * positions and are projected. **An entity anchor resolves through the module that owns the
 * entity** — anchoring is a module capability, not a `primitives` special case, so a module that
 * exports no `positionOf` simply cannot be anchored to and the float hides.
 */
function screenOf(ctx: ModuleContext, a: Anchor): { x: number; y: number } | null {
  if (a.anchor === "screen") return { x: a.x, y: a.y };
  if (a.anchor === "world") {
    const C = ctx.Cesium;
    return C ? project(ctx, C.Cartesian3.fromDegrees(a.lon, a.lat, a.height)) : null;
  }
  const owner = ctx.modules.get(a.module) as
    { positionOf?: (kind: string, idx: number) => Cartesian3 | undefined } | undefined;
  const at = owner?.positionOf?.(a.kind, a.idx);
  return at ? project(ctx, at) : null;
}

export default {
  setup(ctx: ModuleContext): Disposable {
    // Which crossings a listener upstream asked for. The check happens here, so a crossing nobody
    // registered for never leaves the browser.
    let subscription: PointerSubscription[] = [];
    // Where the pointer is, held per addressed id rather than per element. A box that a
    // re-declaration rebuilds is the same box under the same pointer, so the element that replaces
    // it inherits the state and the pair of crossings the swap would otherwise raise never happens.
    const inside = new Map<string, { mods: string[]; screen: { x: number; y: number } }>();
    // How many live elements carry each id. Every replacement watches the new element before it
    // drops the old one, so this never reaches zero across a swap and only a real removal answers.
    const watchers = new Map<string, number>();

    /**
     * Raise the pointer events of one addressed box. `mouseenter` and `mouseleave` do not bubble,
     * so a box raises one crossing whatever its children are, and a child carrying an id of its own
     * raises its own beside it.
     *
     * The disposer drops the three listeners and, when it drops the last element carrying the id,
     * raises the `leave` the browser will not: an element taken out of the document fires no
     * `mouseleave`, so a box removed under the pointer would otherwise strand whoever saw its
     * `enter`. That synthetic one carries what the `enter` carried, since the box is gone and no
     * event says where the pointer is now.
     */
    const watch = (el: HTMLElement, id: string): (() => void) => {
      watchers.set(id, (watchers.get(id) ?? 0) + 1);
      const raise = (type: PointerType, at: { mods: string[]; screen: { x: number; y: number } }) => {
        const wanted = subscription.some(
          (s) => (s.id == null || s.id === id) && (s.type == null || s.type === type) &&
                 (s.mods == null || sameMods(s.mods, at.mods)),
        );
        if (wanted) ctx.notify("pointer", { type, id, mods: at.mods, screen: at.screen });
      };
      // The modifiers held at the crossing, and where it happened in container coordinates — the
      // space a `screen` anchor places a float in.
      const read = (e: MouseEvent) => {
        const box = ctx.container.getBoundingClientRect();
        return { mods: MOD_ORDER.filter((k) => e[`${k}Key` as const]),
                 screen: { x: e.clientX - box.left, y: e.clientY - box.top } };
      };
      // A toggle or a select is a label wrapping its control, and a click on the label text is
      // relayed to the control as a second click that bubbles back here. The relay carries no
      // button count, so it is dropped and one gesture raises one crossing.
      const click = (e: MouseEvent) => {
        if (e.detail === 0 && e.target !== el) return;
        raise("click", read(e));
      };
      // The browser fires `mouseenter` on the element that replaced one under a resting pointer.
      // The pointer never left the box, so that second enter says nothing.
      const enter = (e: MouseEvent) => {
        if (inside.has(id)) return;
        const at = read(e);
        inside.set(id, at);
        raise("enter", at);
      };
      const leave = (e: MouseEvent) => {
        if (!inside.delete(id)) return;
        raise("leave", read(e));
      };
      el.addEventListener("click", click);
      el.addEventListener("mouseenter", enter);
      el.addEventListener("mouseleave", leave);
      return () => {
        el.removeEventListener("click", click);
        el.removeEventListener("mouseenter", enter);
        el.removeEventListener("mouseleave", leave);
        const left = (watchers.get(id) ?? 1) - 1;
        if (left > 0) {
          watchers.set(id, left);
          return;   // another element still carries this id: the box was replaced, not removed
        }
        watchers.delete(id);
        const at = inside.get(id);
        if (!at) return;
        inside.delete(id);
        raise("leave", at);
      };
    };

    const tooltip = createTooltip(ctx.container);
    const floats = createFloats({
      container: ctx.container,
      screenOf: (a) => screenOf(ctx, a),
      // A module named by a float but never declared has nothing to hand over, and the float says
      // so and renders nothing. One declared either side of `ui` is reached the same way.
      mountOf: (id) => {
        const mount = (ctx.modules.get(id) as { mount?: unknown } | undefined)?.mount;
        return typeof mount === "function" ? (mount as MountFactory) : null;
      },
      notify: (topic, payload) => ctx.notify(topic, payload),
      watch,
    });
    // The rows on screen, in declared order: what each was built from, so the next declaration can
    // tell which of them changed, plus its remover and whatever reacts to a crossing. A row nobody
    // registered a kind for is kept as a placeholder with no element, so the sequence still lines up
    // with the declared list.
    let live: Row[] = [];
    // This module's slice of each window it was addressed in. The Core says which window holds an
    // absolute keyframe and where in it it sits; this says what the window carried.
    const held = ctx.perWindow<OverlayWindow>();

    const clear = () => {
      for (const row of live) row.dispose?.();
      live = [];
    };

    // Give every addressed widget the value its keyframed fields take at absolute keyframe `index`
    // and rebuild the ones that changed. A keyframe no window covered, a field an entry is silent
    // about, and an entry naming a widget no declaration mounted all leave the overlay as it is:
    // windows and declarations arrive independently, so neither is an error.
    const apply = (index: number) => {
      const at = ctx.placement(index);
      const win = held.at(at)?.w;
      if (!at || !win) return;
      for (const [id, fields] of Object.entries(win.per_keyframe ?? {})) {
        // Looked up per id rather than once for the whole crossing: showing a value rebuilds a
        // widget, and rebuilding a group replaces the trackers of everything inside it.
        const track = [...live.flatMap((row) => row.tracks), ...floats.tracks()]
          .find((t) => t.id === id);
        if (!track) continue;
        let changed = false;
        for (const [field, values] of Object.entries(fields ?? {})) {
          if (!track.fields.has(field)) continue;
          const value = valueAt(values, at.k, at.window.count);
          if (value == null || Object.is(value, track.spec[field])) continue;
          track.spec[field] = value;
          changed = true;
        }
        if (changed) track.show(index);
      }
    };

    // A widget declared after the window that describes it opens on the keyframe the clock is on,
    // rather than wearing its declared value until the next crossing. Before the first tick there
    // is no keyframe to open on, and the crossing the first window fires covers it.
    const applyNow = () => {
      const index = ctx.frame?.index ?? null;
      if (index !== null) apply(index);
    };

    // One widget, chromed or not, with its declared `style` merged over whatever it ends up wearing.
    // `chrome` is false exactly for a group's children: they sit inside the group's box.
    const widgetOf = (spec: WidgetSpec, chrome: boolean): Widget | null => {
      let widget;
      try {
        // Reporting is the widget's only way upward, and it carries the row's own id — a child of a
        // group reports under its own id, exactly as a top-level row does.
        widget = build(spec, (value) => ctx.notify("control", { id: spec.id, value }));
      } catch (err) {
        console.warn(`ui: widget ${JSON.stringify(spec.kind)} failed to build: ${err}`);
        return null;
      }
      if (!widget) return null;   // no such kind: that row is skipped, the rest of the panel renders
      if (chrome) widget.el.style.cssText = PANEL + ";" + widget.el.style.cssText;
      applyStyle(widget.el, spec.style);
      return widget;
    };

    // A group is one box holding several controls, so related controls read as one thing. It is
    // handled here rather than as a registered kind because this loop already owns the region and
    // each child's report closure — and because nesting stops at one level: a group inside a group
    // reaches `build` as an unregistered kind and is skipped with a warning.
    const groupOf = (spec: WidgetSpec): Built | null => {
      const children = (Array.isArray(spec.controls) ? spec.controls : []) as WidgetSpec[];
      const built: Widget[] = [];
      const tracks: Track[] = [];
      // One entry per built child, in the same order: its disposer, or null where the child carries
      // no id and is watched by nobody.
      const watched: ((() => void) | null)[] = [];
      for (const child of children) {
        // A copy each, for the same reason a row's spec is copied: a track writes the keyframe's
        // values into the spec its widget is rebuilt from.
        const own = { ...child };
        const widget = widgetOf(own, false);
        if (!widget) continue;
        const at = built.length;
        built.push(widget);
        const id = own.id == null ? null : String(own.id);
        watched.push(id === null ? null : watch(widget.el, id));
        // A tracked child is swapped inside the box on its own, so a crossing leaves its siblings —
        // and whatever live state they hold — untouched.
        const track = trackOf(own, (index) => {
          const next = widgetOf(own, false);
          if (!next) return;   // a kind that stopped building: keep what is on screen
          built[at].el.replaceWith(next.el);
          built[at] = next;
          // A swapped child is a new element, so its listeners go with the old one. The new element
          // is watched first: the id stays carried throughout, so a pointer resting on the child
          // sees a swap rather than a removal and an arrival.
          if (id !== null) {
            const drop = watched[at]!;
            watched[at] = watch(next.el, id);
            drop();
          }
          next.onKeyframe?.(index);
        });
        if (track) tracks.push(track);
      }
      if (!built.length) return null;   // an empty group is a row, not an empty box on the globe
      const box = el("div", GROUP);
      box.append(...built.map((w) => w.el));
      applyStyle(box, spec.style);
      return {
        widget: { el: box, onKeyframe: (i) => { for (const w of built) w.onKeyframe?.(i); } },
        tracks,
        unwatch: () => { for (const drop of watched) drop?.(); },
      };
    };

    // One declared row, built: a group as its whole box, anything else as its own widget.
    const buildRow = (spec: WidgetSpec): Built | null => {
      if (spec.kind === "group") return groupOf(spec);
      const widget = widgetOf(spec, true);
      return widget === null ? null : { widget, tracks: [] };
    };

    // Mount the built row in its declared region, either appended after what is already there or in
    // place of the element `anchor`. A replacement goes through `addControl` first and is moved into
    // place after, so the Core still owns mounting and the remover still closes over the element it
    // removes.
    const mount = (built: Built, r: Declared, index: number | null,
                   anchor: HTMLElement | null): Pick<Row, "el" | "dispose" | "onKeyframe"> => {
      const widget = built.widget;
      // A title keyed by keyframe shows the frame the clock is already on rather than waiting for
      // the next crossing, which on a paused clock never comes.
      if (index !== null) widget.onKeyframe?.(index);
      const remove = ctx.overlay.addControl(r.region, widget.el);
      anchor?.replaceWith(widget.el);
      // A row carrying an id is an addressed box and raises its own pointer events; one carrying
      // none costs no listener. For a group this watches the box, and `groupOf` its children.
      const unwatch = r.spec.id == null ? null : watch(widget.el, String(r.spec.id));
      return {
        el: widget.el,
        dispose: () => {
          unwatch?.();
          built.unwatch?.();
          remove();
        },
        onKeyframe: widget.onKeyframe,
      };
    };

    // One built row, mounted. The row object is what a track mutates in place when it rebuilds the
    // widget, so a tracker holds one reference for as long as its declaration is on screen.
    const rowOf = (r: Declared, built: Built, index: number | null,
                   anchor: HTMLElement | null): Row => {
      const row: Row = { ...mount(built, r, index, anchor),
                         key: r.key, json: r.json, tracks: [] };
      row.tracks = tracksOf(row, r, built);
      return row;
    };

    // Put a widget freshly built from the row's spec — the declared one, carrying whatever values
    // the tracks have written into it — in place of the one on screen.
    const rebuild = (row: Row, r: Declared, index: number) => {
      const built = buildRow(r.spec);
      if (!built) return;   // a kind that stopped building: keep what is on screen
      const dispose = row.dispose;
      Object.assign(row, mount(built, r, index, row.el));
      row.tracks = tracksOf(row, r, built);
      dispose?.();
    };

    const tracksOf = (row: Row, r: Declared, built: Built): Track[] => {
      const own = trackOf(r.spec, (index) => rebuild(row, r, index));
      return own === null ? built.tracks : [own, ...built.tracks];
    };

    const declare = (payload: unknown) => {
      const index = ctx.frame?.index ?? null;
      // One box per declared row: the Core stacks them within their region in insertion order, and
      // no module positions its own overlay. A group's region places the whole box; the region of a
      // control inside one says nothing.
      const rows: Declared[] = ((Array.isArray(payload) ? payload : []) as WidgetSpec[])
        .map((spec) => {
          const region = REGIONS.includes(spec.region as OverlayRegion)
            ? (spec.region as OverlayRegion)
            : "top-left";
          // The widget is built from a copy: a track writes each keyframe's values into the spec it
          // rebuilds from, and the declaration those came in on is retained by the Core.
          return { spec: { ...spec }, region,
                   key: JSON.stringify([spec.kind, spec.id ?? null, region]),
                   json: JSON.stringify(spec) };
        });

      // Reconcile when the rows line up position for position, and rebuild wholesale otherwise. No
      // attempt is made to follow an insertion or a reorder: the declared list is stable in
      // practice, and a row put back in the wrong place is worse than a rebuilt panel.
      const aligned = rows.length === live.length && rows.every((r, i) => r.key === live[i].key);
      if (aligned) {
        // Every changed row is built before anything is mounted, so a build that fails cannot leave
        // the overlay half-swapped. A row whose kind is registered by nobody builds to null in both
        // declarations, and one that does not agree sends the whole list down the rebuild path.
        const swaps = rows.map((r, i) =>
          r.json === live[i].json ? null : { i, built: buildRow(r.spec) });
        if (swaps.every((s) => s === null || (s.built !== null) === (live[s.i].el !== null))) {
          const next = live.slice();
          for (const swap of swaps) {
            if (!swap) continue;   // untouched: this row keeps the element it already had
            const old = live[swap.i];
            const r = rows[swap.i];
            next[swap.i] = swap.built === null
              ? { key: r.key, json: r.json, el: null, dispose: null, tracks: [] }
              : rowOf(r, swap.built, index, old.el);
            old.dispose?.();
          }
          live = next;
          applyNow();
          return;
        }
      }

      // The new rows go up before the old ones come down. The Core appends within a region and the
      // old elements leave after, so the order is the declared one, and a box that keeps its id
      // across the two lists is carried throughout rather than removed and put back.
      const old = live;
      live = rows.map((r) => {
        const built = buildRow(r.spec);
        // No such kind: the row is skipped and the rest of the panel renders, but it stays in the
        // sequence so a later declaration still reconciles against it.
        return built === null
          ? { key: r.key, json: r.json, el: null, dispose: null, tracks: [] }
          : rowOf(r, built, index, null);
      });
      for (const row of old) row.dispose?.();
      applyNow();
    };

    // A float, the overlay panel or a widget sits over the canvas and takes the pointer off it, so
    // no hover is raised there and no listener answers with a clear: the box would stand behind the
    // float until the cursor came back. The crossing hides it here, with nothing asked of the
    // server, and the next hover over the globe paints it again.
    //
    // It has to stay hidden too. The hover raised just before the crossing is still in flight, and
    // its answer lands after it — carrying the last coordinate the cursor had on the globe, which is
    // why the box came back reading the edge it left by. Content is dropped for as long as the
    // pointer is off the canvas, so no answer in flight can paint the box again.
    let onCanvas = true;
    const enter = () => {
      onCanvas = true;
    };
    const leave = () => {
      onCanvas = false;
      tooltip.apply({ html: null });
    };
    ctx.scene.canvas.addEventListener("mouseenter", enter);
    ctx.scene.canvas.addEventListener("mouseleave", leave);

    const disposables = [
      ctx.onCommand("declare", declare),
      ctx.onCommand("floating", (payload) => {
        floats.declare(payload);
        applyNow();
      }),
      ctx.onCommand("tooltip", (payload) => tooltip.apply(onCanvas ? payload : { html: null })),
      // Anything that is not a list subscribes to nothing, as the Core's own subscription does.
      ctx.onCommand("subscribe", (payload) => {
        subscription = Array.isArray(payload) ? (payload as PointerSubscription[]) : [];
      }),
      ctx.onWindow((w, payload) => held.install((payload ?? {}) as OverlayWindow, w)),
      ctx.onKeyframe((index) => {
        for (const row of live) row.onKeyframe?.(index);
        apply(index);
      }),
      // An anchored float is re-projected every tick, so it rides the entity it names as the
      // positions interpolate and as the camera moves, with nothing asked of the server.
      ctx.onFrame(() => floats.reposition()),
      // Local dispatch: the box follows the cursor at frame rate, with nothing asked of the server.
      ctx.onPointer((e) => tooltip.track(e.screen)),
      () => {
        ctx.scene.canvas.removeEventListener("mouseenter", enter);
        ctx.scene.canvas.removeEventListener("mouseleave", leave);
      },
    ];

    return () => {
      for (const dispose of disposables) dispose();
      clear();
      clearWidgets();
      floats.destroy();
      tooltip.destroy();
    };
  },
};
