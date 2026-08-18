// The Core's own on-screen items — furniture (ADR-0015). The band is fixed to the bottom edge: the
// animation clock, the timeline ruler and the keyframe readout. The group is one column of buttons
// that travels whole into a declared overlay region, contributed through `addControl` like any
// module's control, so it stacks beside them rather than under them.
//
// The server states the whole set at once, and one layout pass writes every number that depends on
// which band items are on screen.
//
// The widgets are created once and persist across windows. ClockViewModel and Timeline register
// their own clock.onTick listeners, so the clock face and ruler track playback with no per-tick call
// here; the only interaction Cesium leaves unwired is Timeline scrubbing, which merely dispatches a
// `settime` event — so we set the clock time from it below.

import { JulianDate, type Clock, type Scene } from "@cesium/engine";
import {
  Animation, AnimationViewModel, CesiumInspector, ClockViewModel,
  FullscreenButton, HomeButton, NavigationHelpButton, ProjectionPicker,
  SceneModePicker, Timeline,
} from "@cesium/widgets";
import type { CameraAuthority } from "./camera";
import {
  bandLayout, cameraFollowView, countdownText, FURNITURE_DEFAULTS,
  type FurnitureDeclaration, type FurnitureId, type StopRow,
} from "./furniture";
import type { Overlay, OverlayRegion } from "./overlay";

/** The keyframe the readout names: the instant its values were computed for, and the move onto it. */
interface KeyframeReadout {
  time: JulianDate;
  goTo(): void;
}

export interface Furniture {
  /** Point the Timeline ruler at the clock's active range (call after the range is set). */
  zoomTimeline(start: JulianDate, stop: JulianDate): void;
  /** Put the declared set on screen: build what it turns on, destroy what it drops, lay out again. */
  setFurniture(decl: FurnitureDeclaration): void;
  /** Name the keyframe the scene's values come from, or null when none has been delivered. */
  setKeyframe(at: KeyframeReadout | null): void;
  /** Render the camera-follow item from the camera authority, which is built after the furniture. */
  followCamera(camera: CameraAuthority): void;
  /** Re-layout the Timeline/Animation after a container resize. */
  resize(): void;
  destroy(): void;
}

const CELL = "position:absolute;";

/** The chrome the Core's own band items wear: the keyframe readout and the camera-follow item. */
const PILL = "height:22px;padding:0 8px;font:12px/22px sans-serif;color:#edffff;" +
  "background:rgba(38,38,38,0.75);border:1px solid #444;border-radius:3px;";

/** A button with no chrome of its own, so the pill that holds it still reads as one box. */
const FLAT = "font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;";

/** Where the group sits when a declaration names no region. */
const DEFAULT_REGION: OverlayRegion = "top-right";

/** Top to bottom inside the group. The order is fixed here, not declared. */
const GROUP_ORDER = ["home", "sceneMode", "projection", "navHelp", "fullscreen", "inspector"] as const;
type GroupId = (typeof GROUP_ORDER)[number];

// The group's own rule; a declared style merges over it. It carries `pointer-events:auto` because
// the rule is rewritten whole on every declaration, which would otherwise drop what `addControl`
// set. No `z-index`: the region host already carries one, and inheriting it is the point.
const GROUP_STYLE = "display:flex;flex-direction:column;gap:6px;pointer-events:auto";

/** Cesium's own "enter full screen" icon, so a host's substitute button reads as the same control. */
const ENTER_FULLSCREEN_PATH =
  "M 83.96875 17.5625 L 83.96875 17.59375 L 76.65625 24.875 L 97.09375 24.96875 L 76.09375 " +
  "45.96875 L 81.9375 51.8125 L 102.78125 30.9375 L 102.875 51.15625 L 110.15625 43.875 L " +
  "110.1875 17.59375 L 83.96875 17.5625 z M 44.125 17.59375 L 17.90625 17.625 L 17.9375 43.90625 " +
  "L 25.21875 51.1875 L 25.3125 30.96875 L 46.15625 51.8125 L 52 45.96875 L 31 25 L 51.4375 " +
  "24.90625 L 44.125 17.59375 z M 46.0625 76.03125 L 25.1875 96.875 L 25.09375 76.65625 L " +
  "17.8125 83.9375 L 17.8125 110.21875 L 44 110.25 L 51.3125 102.9375 L 30.90625 102.84375 L " +
  "51.875 81.875 L 46.0625 76.03125 z M 82 76.15625 L 76.15625 82 L 97.15625 103 L 76.71875 " +
  "103.0625 L 84.03125 110.375 L 110.25 110.34375 L 110.21875 84.0625 L 102.9375 76.8125 L " +
  "102.84375 97 L 82 76.15625 z";

/**
 * The full-screen cell for a host that goes full screen its own way. It wears Cesium's button
 * chrome and icon, and it holds no state: the host owns whether the view is expanded, and a
 * webview is not told when the reader leaves that state by another route.
 */
function expandButton(el: HTMLElement, expand: () => void): { destroy(): void } {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cesium-button cesium-fullscreenButton";
  button.title = "Full screen";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "cesium-svgPath-svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ENTER_FULLSCREEN_PATH);
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener("click", expand);
  el.appendChild(button);
  return { destroy: () => button.remove() };
}

export function buildFurniture(
  container: HTMLElement,
  scene: Scene,
  clock: Clock,
  overlay: Overlay,
  expand?: () => void,
): Furniture {
  // Bottom-left: analog clock + shuttle ring + play/pause.
  const animEl = document.createElement("div");
  animEl.style.cssText = CELL + "bottom:6px;left:6px;width:170px;height:112px";
  // Bottom, full width past the animation widget: the scrubbable date ruler. `layout()` writes its
  // left edge, which depends on whether the clock is on screen before it.
  //
  // Clipped, because the Timeline is taller than the band it is given. Cesium stacks a track area
  // under the date bar and sizes it to the whole container, so the widget always overhangs — off
  // the bottom of the page, which the document then grows a scrollbar for. This viewer adds no
  // tracks, so the overhang is empty and clipping it costs nothing.
  const timeEl = document.createElement("div");
  timeEl.style.cssText = CELL + "bottom:0;right:0;height:28px;overflow:hidden";
  // Docked directly above the ruler and sharing its left edge: the keyframe the scene's discrete
  // values come from, which is the last one crossed and not the instant on the clock face. With the
  // ruler off it drops into the ruler's place, so `layout()` writes both numbers.
  const readoutEl = document.createElement("button");
  readoutEl.type = "button";
  readoutEl.title = "The keyframe the scene's values were computed for. Click to move the clock onto it.";
  readoutEl.style.cssText = CELL + PILL;
  // Docked above the readout: one item that says who is moving the camera, offers the way back, and
  // opens into the stops of the declared track (ADR-0017). One box, not two: the head line is the
  // status line, and a click on it shows the list under it.
  //
  // The item holds one piece of state of its own — whether it is open. Nothing declares it and
  // nothing on the wire says it. Everything else it shows comes from the authority's readable
  // values. It is DOM, so it adds nothing to the scene.
  //
  // It grows upward from its own bottom edge as it opens, so `layout()` writes only that edge.
  const followEl = document.createElement("div");
  followEl.style.cssText = CELL + PILL +
    "height:auto;padding:0;max-width:320px;display:flex;flex-direction:column";
  const headEl = document.createElement("div");
  headEl.style.cssText = "display:flex;align-items:center;gap:8px;height:22px;padding:0 8px";
  // Click to open, click to close. Not hover: hover is hostile to browsing a list and has no touch
  // story. A button rather than a styled div, so the keyboard reaches it for free.
  const toggleEl = document.createElement("button");
  toggleEl.type = "button";
  toggleEl.style.cssText = FLAT +
    "flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  const BTN = "font:12px/18px sans-serif;color:#edffff;background:rgba(56,56,56,0.9);" +
    "border:1px solid #666;border-radius:3px;padding:0 6px;cursor:pointer";
  const rejoinEl = document.createElement("button");
  rejoinEl.type = "button";
  rejoinEl.textContent = "Rejoin";
  rejoinEl.title = "Give the camera back to the scene and fly to the viewpoint that applies now.";
  rejoinEl.style.cssText = BTN;
  // The labelled way off a ride. The home button also gets off, because a flight clears the frame,
  // but that is a side effect of flying away and nothing on screen says so.
  const getOffEl = document.createElement("button");
  getOffEl.type = "button";
  getOffEl.textContent = "Get off";
  getOffEl.title =
    "Stop riding, and look down on the ground below it from the height you started at.";
  getOffEl.style.cssText = BTN;
  headEl.append(toggleEl, rejoinEl, getOffEl);
  // The stops, in order, with the applied one marked and each one a click target. A wall-paced tour
  // has no clock to read its schedule off, so the list is what says what the tour is, whether it is
  // over, and how long the stop on screen still has.
  //
  // Capped and scrollable, because a track of fifty viewpoints is one retained command by design and
  // fifty rows is not a panel.
  const listEl = document.createElement("div");
  listEl.style.cssText = "display:none;flex-direction:column;padding:0 8px 4px;" +
    "max-height:110px;overflow-y:auto";
  followEl.append(headEl, listEl);
  for (const el of [animEl, timeEl, readoutEl, followEl]) container.appendChild(el);

  const clockViewModel = new ClockViewModel(clock);
  const animationViewModel = new AnimationViewModel(clockViewModel);
  const animation = new Animation(animEl, animationViewModel);
  const timeline = new Timeline(timeEl, clock);

  // The group is mounted once, at build time, so it is the region's first child: `top-right` is a
  // reversed row, so first means rightmost, and a module's colorbar grows leftward from the buttons.
  const groupEl = document.createElement("div");
  groupEl.style.cssText = GROUP_STYLE;
  let region: OverlayRegion = DEFAULT_REGION;
  let unmountGroup = overlay.addControl(region, groupEl);

  // A group item is built when a declaration turns it on and destroyed when one drops it, so a
  // session that never asks for the inspector never pays for its view models.
  const build: Record<GroupId, (el: HTMLElement) => { destroy(): void }> = {
    home: (el) => new HomeButton(el, scene),
    sceneMode: (el) => new SceneModePicker(el, scene),
    projection: (el) => new ProjectionPicker(el, scene),
    navHelp: (el) => new NavigationHelpButton({ container: el }),
    fullscreen: (el) =>
      expand ? expandButton(el, expand) : new FullscreenButton(el, container),
    inspector: (el) => new CesiumInspector(el, scene),
  };
  const mounted = new Map<
    GroupId,
    { el: HTMLElement; widget: { destroy(): void }; unrank: () => void }
  >();

  /**
   * Whether this page can show `id` at all. The server declares the furniture and does not know
   * what its client is, so the capability decides and the declaration cannot override it.
   *
   * A page with no fullscreen API — a VSCode webview, a sandboxed frame — renders `FullscreenButton`
   * dead: the widget binds its enable flag to `document.fullscreenEnabled`, and the setter ANDs with
   * the real capability, so the button cannot be forced on and a click on it does nothing. Such a
   * host supplies `expand` instead, and then the cell is a substitute button that calls it.
   */
  const available = (id: GroupId): boolean =>
    id !== "fullscreen" || expand !== undefined || document.fullscreenEnabled;

  /**
   * Rank `el` above the cells below it exactly while something of its own hangs below it.
   *
   * A drop-down grows downward out of its cell, and every Cesium button is `position:relative` with
   * `z-index:0`, so the cell under it paints over the drop-down unless the open cell outranks it.
   * The rank cannot simply stay on, because Cesium leaves a closed drop-down in flow —
   * `visibility:hidden`, not `display:none` — and the picker's wrapper is a positioned layer whose
   * hit region follows that overflow. A permanently raised cell therefore takes the pointer off the
   * button underneath it while nothing is even on show.
   *
   * So the question the rank answers is the one that can be measured: does anything of mine reach
   * the cell below? A widget states that by re-styling its parts, which is what the observer
   * watches. It also fades them, and a picker that closes puts the visibility change at the far end
   * of that fade — so the answer is asked again when the fade ends, or the cell stays raised on a
   * drop-down that is no longer there. The rank is the cell's, never the group's: the group
   * inherits the region host's stacking, and that is what keeps the whole set clear of a module's
   * controls.
   */
  const rankWhileOpen = (el: HTMLElement, rank: number): (() => void) => {
    const reachesTheCellBelow = () => {
      const below = el.nextElementSibling;
      if (!below) return false;
      const limit = below.getBoundingClientRect().top;
      return [...el.querySelectorAll("*")].some((part) => {
        const style = getComputedStyle(part);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return part.getBoundingClientRect().bottom > limit;
      });
    };
    // A flex item honours z-index as though it were positioned, so the cell needs nothing else;
    // clearing it returns the cell to document order, where the cell below wins.
    const apply = () => {
      el.style.zIndex = reachesTheCellBelow() ? String(GROUP_ORDER.length - rank) : "";
    };
    const watch = new MutationObserver(apply);
    watch.observe(el, { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    el.addEventListener("transitionend", apply);
    apply();
    return () => {
      watch.disconnect();
      el.removeEventListener("transitionend", apply);
    };
  };

  const mount = (id: GroupId) => {
    const rank = GROUP_ORDER.indexOf(id);
    const el = document.createElement("div");
    // Each button keeps a fixed cell with overflow visible. SceneModePicker and NavigationHelpButton
    // grow their drop-downs out of the cell, so an unsized cell would reflow the whole column every
    // time one opens, and FullscreenButton sizes itself to 100% of its container. The inspector is a
    // panel that carries its own width.
    if (id !== "inspector") el.style.cssText = "width:32px;height:32px";
    // The order is fixed, so a new cell goes before the first later item already on screen.
    const after = GROUP_ORDER.slice(rank + 1)
      .map((later) => mounted.get(later)?.el)
      .find(Boolean);
    groupEl.insertBefore(el, after ?? null);
    const widget = build[id](el);
    // The cell owns where the button sits, and the group's gap owns the space between two of them.
    // So clear the offset the widget brought: `.cesium-button` carries `margin:2px 3px`, each picker
    // overrides it differently, and FullscreenButton zeroes it — three widgets, three corners, and
    // an icon column out of step with the even cells behind it. Only the leading edges go; a
    // trailing margin still spaces the parts a picker stacks below its own button.
    if (id !== "inspector") {
      for (let part = el.firstElementChild; part; part = part.firstElementChild) {
        (part as HTMLElement).style.marginTop = "0";
        (part as HTMLElement).style.marginLeft = "0";
        if (part.tagName === "BUTTON") break;
      }
    }
    mounted.set(id, { el, widget, unrank: rankWhileOpen(el, rank) });
  };

  const unmount = (id: GroupId) => {
    const cell = mounted.get(id);
    if (!cell) return;
    cell.unrank();
    cell.widget.destroy();
    cell.el.remove();
    mounted.delete(id);
  };

  // What is on screen now. It starts at the defaults, which is what a session that declares nothing
  // sees: everything but the projection picker, the navigation help and the inspector.
  const items: Record<FurnitureId, boolean> = { ...FURNITURE_DEFAULTS };
  // The last declared range. A furniture declaration arrives independently of any range, so the
  // ruler needs the range held here to re-lay itself out whenever its box changes.
  let range: { start: JulianDate; stop: JulianDate } | null = null;

  // Every number that depends on which band items are on screen, written in one place.
  const layout = () => {
    const band = bandLayout(items);
    timeEl.style.left = `${band.rulerLeft}px`;
    readoutEl.style.left = `${band.readoutLeft}px`;
    readoutEl.style.bottom = `${band.readoutBottom}px`;
    followEl.style.left = `${band.followLeft}px`;
    followEl.style.bottom = `${band.followBottom}px`;
    overlay.setBottomInset(band.bottomInset);
  };

  // The camera authority, once the Core has built it. Null until then, and while it is null the
  // follow item has nothing to say.
  let camera: CameraAuthority | null = null;
  let unwatchCamera: (() => void) | null = null;

  // Whether the list is open. Collapsed by default, and the item's own: nothing declares it.
  let expanded = false;
  // The rows on screen now, as the view stated them. A rebuild sends the capped box back to the top,
  // so it must not run for a change the list does not show: the hold moving is one of those, and it
  // would otherwise pull a reader's scroll back on every drag.
  let shown = "";
  /** The countdown element of each row, by index into the track. A rebuild replaces the whole map. */
  const countdowns = new Map<number, HTMLElement>();

  /**
   * Write the time left on every row that has an armed timer behind it.
   *
   * It reads the deadlines the arming wrote, so the panel predicts the flight the timer actually
   * makes rather than a second copy of the schedule. This viewer does not set `requestRenderMode`,
   * so the render loop runs continuously and the tick keeps firing on a motionless globe. Turning
   * that mode on would stop the countdown on exactly the timeless scene it exists for.
   */
  const tickCountdowns = () => {
    if (!expanded || !camera) return;
    const now = Date.now();
    for (const [i, el] of countdowns) {
      // The tick is per frame and the number changes once a second, so only changed text is written.
      const text = countdownText(camera.deadlineAt(i), now);
      if (el.textContent !== text) el.textContent = text;
    }
  };
  // Registered once for the item's life, rather than added and dropped as the panel opens.
  const removeTick = clock.onTick.addEventListener(tickCountdowns);

  /** One element per row `stopRows` states. The list holds no copy of the track; it is rebuilt. */
  const showStops = (rows: StopRow[]) => {
    const state = JSON.stringify(rows);
    if (state === shown) return;
    shown = state;
    countdowns.clear();
    listEl.style.display = rows.length === 0 ? "none" : "flex";
    listEl.replaceChildren(
      ...rows.map((r, i) => {
        const el = document.createElement("button");
        el.type = "button";
        el.title = "Put the tour at this stop.";
        el.style.cssText = FLAT + "display:flex;gap:8px;text-align:left;font:12px/18px sans-serif;" +
          (r.applied ? "color:#ffffff;font-weight:600" : "color:#9fb6b6");
        const label = document.createElement("span");
        label.textContent = `${r.applied ? "▸" : "·"} ${r.text}`;
        // One line each: a label longer than the capped box ends in an ellipsis, which keeps the
        // panel a panel and never a second overlay across the globe.
        label.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        const due = document.createElement("span");
        due.style.cssText = "flex:none;color:#9fb6b6;font-weight:400";
        countdowns.set(i, due);
        el.append(label, due);
        // Clicking takes the hold, exactly as Rejoin does, so a click still moves the tour while the
        // viewer holds the camera (ADR-0017).
        el.addEventListener("click", () => camera?.goToStop(i));
        return el;
      }),
    );
    // The rebuild puts the list back at the top, so the applied stop has to be brought back into
    // view. `nearest` scrolls the capped box and nothing outside it.
    listEl.children[rows.findIndex((r) => r.applied)]?.scrollIntoView({ block: "nearest" });
    tickCountdowns();
  };

  const showFollow = () => {
    const view = camera
      ? cameraFollowView(items.cameraFollow, camera, expanded)
      : { state: "hidden" as const, head: "", rows: [], riding: null, canRejoin: false };
    followEl.style.display = view.state === "hidden" ? "none" : "flex";
    toggleEl.textContent = view.head;
    toggleEl.title = expanded
      ? "Who is holding the camera. Click to hide the stops of the tour."
      : "Who is holding the camera. Click to show the stops of the tour.";
    toggleEl.setAttribute("aria-expanded", String(expanded));
    rejoinEl.style.display = view.canRejoin ? "" : "none";
    getOffEl.style.display = view.riding ? "" : "none";
    showStops(view.rows);
  };

  const showBand = () => {
    animEl.style.display = items.animation ? "" : "none";
    timeEl.style.display = items.timeline ? "" : "none";
    readoutEl.style.display = items.keyframe ? "" : "none";
    showFollow();
  };

  for (const id of GROUP_ORDER) if (items[id] && available(id)) mount(id);
  showBand();
  layout();

  // Timeline only dispatches `settime` on drag; pause and jump the clock ourselves so the
  // interpolation onTick reads the scrubbed instant. Its event methods proxy to the widget's
  // div but are absent from Cesium's .d.ts, so reach them through a typed cast.
  const scrubbable = timeline as unknown as {
    addEventListener(t: string, l: (e: Event) => void, capture: boolean): void;
    removeEventListener(t: string, l: (e: Event) => void, capture: boolean): void;
  };
  const onScrub = (e: Event) => {
    clock.currentTime = (e as unknown as { timeJulian: JulianDate }).timeJulian;
    clock.shouldAnimate = false;
  };
  scrubbable.addEventListener("settime", onScrub, false);

  // The keyframe named on screen; null until one is delivered. It holds the last delivered keyframe
  // while the buffer is short of the clock, which is still what the scene is built from.
  let readout: KeyframeReadout | null = null;
  const setKeyframe = (at: KeyframeReadout | null) => {
    readout = at;
    readoutEl.textContent = at
      ? `Keyframe: ${JulianDate.toIso8601(at.time, 0).replace("T", " ")}`
      : "Keyframe: —";
    readoutEl.disabled = at === null;
    readoutEl.style.cursor = at ? "pointer" : "default";
  };
  setKeyframe(null);
  const onReadoutClick = () => readout?.goTo();
  readoutEl.addEventListener("click", onReadoutClick);

  // The button is chrome, so pressing it never detaches — only canvas input does (ADR-0017).
  const onRejoinClick = () => camera?.rejoin();
  rejoinEl.addEventListener("click", onRejoinClick);

  // Also chrome: getting off clears the frame and never touches the hold, so a user who took the
  // camera to steer around a satellite still holds it once they step off.
  const onGetOffClick = () => camera?.follow(null);
  getOffEl.addEventListener("click", onGetOffClick);

  const onToggleClick = () => {
    expanded = !expanded;
    showFollow();
  };
  toggleEl.addEventListener("click", onToggleClick);

  return {
    zoomTimeline(start, stop) {
      range = { start, stop };
      timeline.zoomTo(start, stop);
    },
    setFurniture(decl) {
      const next: Record<FurnitureId, boolean> = { ...FURNITURE_DEFAULTS, ...decl.items };
      const nextRegion = decl.region ?? DEFAULT_REGION;
      // Re-adding appends, which would drop the group behind whatever a module has since contributed
      // to the same region. Only a region that actually changes moves the group.
      if (nextRegion !== region) {
        unmountGroup();
        region = nextRegion;
        unmountGroup = overlay.addControl(region, groupEl);
      }
      groupEl.style.cssText = GROUP_STYLE;
      for (const [property, value] of Object.entries(decl.style ?? {})) {
        groupEl.style.setProperty(property, value);
      }
      // What is on screen is the truth to compare against, not what the last declaration asked for:
      // an item the page cannot show is off however often a declaration turns it on.
      for (const id of GROUP_ORDER) {
        const wanted = next[id] && available(id);
        if (wanted === mounted.has(id)) continue;
        if (wanted) mount(id);
        else unmount(id);
      }
      const revealsClock = next.animation && !items.animation;
      // The ruler's left edge follows the clock, so either item changing moves its box.
      const rulerMoved = next.timeline !== items.timeline || next.animation !== items.animation;
      Object.assign(items, next);
      showBand();
      layout();
      // Both widgets scale their contents to the element they measure, and a hidden element measures
      // 0. Nothing else re-measures the Animation widget, so without this it draws its clock face at
      // the intrinsic 200×132 inside a 170×112 box. The ruler needs its range re-applied instead:
      // `zoomTo` re-lays the dates out, which `resize()` alone does not.
      if (revealsClock) animation.resize();
      if (items.timeline && rulerMoved && range) timeline.zoomTo(range.start, range.stop);
    },
    setKeyframe,
    followCamera(next) {
      unwatchCamera?.();
      camera = next;
      unwatchCamera = next.onChange(showFollow);
      showFollow();
    },
    resize() {
      // A hidden element measures 0, so re-laying out to it would only have to be undone on the
      // next reveal, which re-lays it out anyway.
      if (items.animation) animation.resize();
      if (items.timeline) timeline.resize();
    },
    destroy() {
      scrubbable.removeEventListener("settime", onScrub, false);
      readoutEl.removeEventListener("click", onReadoutClick);
      rejoinEl.removeEventListener("click", onRejoinClick);
      getOffEl.removeEventListener("click", onGetOffClick);
      toggleEl.removeEventListener("click", onToggleClick);
      removeTick();
      unwatchCamera?.();
      for (const id of GROUP_ORDER) unmount(id);
      // The overlay is destroyed first, so the group element may already be detached. Removing a
      // detached element does nothing, which is what this needs.
      unmountGroup();
      animation.destroy();
      timeline.destroy();
      clockViewModel.destroy();
      for (const el of [animEl, timeEl, readoutEl, followEl]) el.remove();
    },
  };
}
