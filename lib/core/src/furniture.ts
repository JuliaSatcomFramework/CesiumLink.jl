// Furniture is an item the Core puts on screen itself, before any module loads: the animation
// clock, the timeline ruler, the keyframe readout and the corner buttons. The server states the
// whole set in one declaration (ADR-0015). A control is the contrast — it names its own region,
// carries a value, reports input, and needs a module to exist.
//
// This file holds the half of furniture that touches neither the DOM nor Cesium, so it runs under
// `node --test` with no browser: the item vocabulary, the band geometry, and the guard that keeps
// a declared region style clear of placement (ADR-0004).

import type { OverlayRegion } from "./overlay";

/** The thirteen items the server can ask for. The wire spells an id in camelCase. */
export type FurnitureId =
  | "timeline" | "animation" | "keyframe" | "cameraFollow"
  | "sceneMode" | "fullscreen" | "home"
  | "projection" | "basemap" | "annotations" | "navHelp" | "inspector" | "canvasCapture";

/**
 * What is on screen when a declaration names nothing. This table is the one place a default lives;
 * the Julia kwargs mirror it rather than restating it.
 */
export const FURNITURE_DEFAULTS: Record<FurnitureId, boolean> = {
  timeline: true,
  animation: true,
  keyframe: true,
  // On by default, because the item hides itself while there is nothing to say. A session that never
  // sends a viewpoint never renders it, so no author has to think about it.
  cameraFollow: true,
  sceneMode: true,
  fullscreen: true,
  home: true,
  projection: false,
  // On by default, and it hides itself below two basemaps, which is `cameraFollow`'s rule. Naming
  // one basemap is therefore the whole opt-out: it takes the network, the picker and the button
  // away in one line, and no author has to think about it (ADR-0034).
  basemap: true,
  // On by default, because two of the three annotation layers are drawn by default and this cell is
  // the only way to take one off from the page. It is also the only way to put the region borders
  // on. A session that declares every layer off still shows the cell, with its boxes unticked.
  annotations: true,
  navHelp: false,
  inspector: false,
  // Off by default, so no scene grows a button it did not ask for. A capture also reaches the
  // clipboard, and a session that never asked for one wants no button that writes there.
  canvasCapture: false,
};

/**
 * What the server states about the furniture. A declaration is a whole statement, not a patch.
 *
 * It travels two ways: in the session declaration, which the Core builds its first set from, and in
 * the `core/furniture` command, which restates the set at any time.
 */
export interface FurnitureDeclaration {
  /** An item the declaration does not name takes its default. */
  items: Partial<Record<FurnitureId, boolean>>;
  /** Where the group sits. Defaults to `top-right`. */
  region?: OverlayRegion;
  /** CSS merged over the group's own rule, in the spelling the browser reads. */
  style?: Record<string, string>;
}

/** The geometry of the bottom band, in pixels from the container's bottom-left corner. */
export interface BandLayout {
  /** Left edge of the timeline ruler. */
  rulerLeft: number;
  /** Left edge of the keyframe readout, which shares the ruler's left edge. */
  readoutLeft: number;
  /** Bottom edge of the keyframe readout: directly above the ruler, or in its place. */
  readoutBottom: number;
  /** Left edge of the camera-follow item, which shares the ruler's left edge. */
  followLeft: number;
  /** Bottom edge of the camera-follow item: directly above the keyframe readout, or in its place. */
  followBottom: number;
  /** Bottom inset the overlay's `bottom-right` region clears the band with. */
  bottomInset: number;
}

const PAD = 6;
// A band-free bottom-right region sits at the same inset as the top regions' `top:8px;right:8px`.
const EDGE = 8;
const CLOCK_W = 170;
const GAP = 10;
const RULER_H = 28;
const READOUT_H = 22;

/**
 * The band geometry that depends on which band furniture is on screen. With everything on it
 * reproduces the layout the viewer has always drawn: a ruler at 186, an inset of 34.
 *
 * The band stacks upward from the bottom edge and stays left-anchored: ruler, then readout, then the
 * camera-follow item. Each item drops into the place of the one below it where that one is off, and
 * nothing here is right-anchored, so the overlay's `bottom-right` region clears the whole band with
 * the one inset the ruler states.
 *
 * The camera-follow item grows upward from its own bottom edge when the viewer expands it, so its
 * height stays out of this table.
 */
export function bandLayout(
  items: { timeline: boolean; animation: boolean; keyframe: boolean },
): BandLayout {
  const rulerLeft = items.animation ? PAD + CLOCK_W + GAP : PAD;
  const readoutBottom = items.timeline ? RULER_H : 0;
  const followBottom = readoutBottom + (items.keyframe ? READOUT_H : 0);
  return {
    rulerLeft,
    readoutLeft: rulerLeft,
    readoutBottom,
    followLeft: rulerLeft,
    followBottom,
    bottomInset: items.timeline ? RULER_H + PAD : EDGE,
  };
}

/**
 * Whether the basemap picker has anything to pick within.
 *
 * The item hides itself below two entries, which is `cameraFollow`'s rule: it stays off screen
 * while there is nothing to say, so no author has to think about it. Naming one basemap is
 * therefore the whole opt-out — it takes the network, the picker and the button away in one line
 * (ADR-0034). The declaration governs display only, and it cannot turn on a picker over a set the
 * server never declared.
 */
export const basemapPickable = (entries: number): boolean => entries >= 2;

/**
 * What the camera-follow item says: nothing, that it rides a moving thing, that the server is
 * driving, or that the viewer is.
 */
export type CameraFollowState = "hidden" | "riding" | "server" | "viewer";

/** What the item reads off the camera authority. `following` is absent where nothing can ride. */
type CameraState = { serverHolds: boolean; viewpoint: unknown; following?: { target: string } | null };

/**
 * What the camera-follow item shows, from the declaration and the camera authority (ADR-0017).
 *
 * The item stays hidden until a viewpoint applies, so a session that sends none never renders it.
 * A camera that rides something is the exception: it shows with no track declared and no viewpoint
 * ever applied, because click-to-follow is exactly that session, and a rider who cannot see that
 * they ride has no way off but the home button.
 *
 * **Riding wins over both hold states.** The frame says what the camera moves relative to and the
 * hold says whether an arriving viewpoint applies. They are independent, so a camera on a moving
 * thing is on it whoever holds the hold — and what a reader needs first is what they are riding.
 *
 * The declaration governs display only: a session that declares the item off still ignores
 * viewpoints once the user takes the camera, it only stops advertising the way back.
 */
export function cameraFollowState(on: boolean, camera: CameraState): CameraFollowState {
  if (!on) return "hidden";
  if (camera.following) return "riding";
  if (camera.viewpoint === null) return "hidden";
  return camera.serverHolds ? "server" : "viewer";
}

/** One stop as the list shows it. */
export interface StopRow {
  /** The stated label, or the schedule that makes the stop apply. */
  text: string;
  /** True for the stop applied now, which the list marks and keeps in view. */
  applied: boolean;
}

/** A stop as the list reads it: the label, and the two fields that schedule it. */
type Stop = { label?: string; at?: number; after?: number };

/**
 * What one row reads. A row with no label falls back to its schedule, which is also what makes a
 * labelled tour worth authoring. A keyframe index is the one the wire carries, and every index on
 * this wire is 0-based.
 */
const rowText = (v: Stop): string => {
  if (v.label) return v.label;
  if (v.at !== undefined) return `at keyframe ${v.at}`;
  if (v.after !== undefined) return `after ${v.after} s`;
  return "on arrival";
};

/**
 * What the stop list shows: one row per declared stop, in order, with the applied one marked.
 *
 * It reads the same track and applied index the scheduling keeps, so the list is not a second source
 * of truth. It shows nothing for a session that declares `cameraFollow` off, which gets neither the
 * status line nor the list, and nothing before the first viewpoint applies. A camera riding
 * something with no track declared has no tour to list, and an empty list under a riding line is
 * the honest answer. The row index is the index into the track, which is what a click on the row
 * hands back to the camera authority.
 */
export function stopRows(
  on: boolean,
  camera: CameraState & { stops: readonly Stop[]; appliedIndex: number },
): StopRow[] {
  if (cameraFollowState(on, camera) === "hidden") return [];
  return camera.stops.map((v, i) => ({ text: rowText(v), applied: i === camera.appliedIndex }));
}

/**
 * What one row says about the time left before it applies: the whole seconds until its armed timer
 * fires, or nothing at all.
 *
 * A row shows a countdown only while a wall-paced timer stands behind it. A keyframed row shows none
 * (ADR-0018): a keyframe-paced countdown is a function of the clock multiplier and of whether the
 * clock runs, and the ruler already says both. A stop already applied has no armed timer either, so
 * it falls out here as well.
 *
 * `deadlineMs` and `nowMs` are both on the wall clock, which is the clock an `after` offset counts
 * on. The seconds round up, so a row reads "in 1 s" for the whole second before it applies rather
 * than sitting on "in 0 s".
 */
export function countdownText(deadlineMs: number | null, nowMs: number): string {
  if (deadlineMs === null) return "";
  return `in ${Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))} s`;
}

/** Everything the camera-follow item puts on screen. */
export interface CameraFollowView {
  /** Nothing to say, riding, the server is driving, or the viewer is. `hidden` renders no box. */
  state: CameraFollowState;
  /** The head line: the caret, the icon for who holds the camera, the wording, and the stop count. */
  head: string;
  /** The rows under the head line, which is empty while the item is closed. */
  rows: StopRow[];
  /**
   * What the camera rides, or null. The control that gets off shows on exactly this, and the string
   * is the author's own: it is what a viewpoint named and what a click reported.
   */
  riding: string | null;
  /**
   * Whether Rejoin has anything to offer — the viewer holds the camera, and a viewpoint is waiting
   * for it. Riding does not change this: the frame and the hold are independent, so a rider who has
   * taken the camera is offered both controls and a rider the server drives is offered one.
   */
  canRejoin: boolean;
}

/**
 * What the camera-follow item shows, from the declaration, the camera authority, and whether the
 * viewer opened the item.
 *
 * One item, not two boxes: the head line is the status line, and the stops sit under it. The item is
 * closed when the page opens, so the reader sees one line until a click asks for the rest. `expanded`
 * is the item's own state — nothing declares it and nothing on the wire says it.
 *
 * Every value on screen comes from here, so what the reader sees is checkable without a DOM.
 */
export function cameraFollowView(
  on: boolean,
  camera: CameraState & { stops: readonly Stop[]; appliedIndex: number },
  expanded: boolean,
): CameraFollowView {
  const state = cameraFollowState(on, camera);
  const all = stopRows(on, camera);
  const count = all.length === 0 ? "" : ` · ${all.length} stop${all.length === 1 ? "" : "s"}`;
  const riding = state === "riding" ? camera.following!.target : null;
  const icon = riding ? "◎" : state === "server" ? "◉" : "○";
  const says = riding
    ? `Camera: riding ${riding}`
    : state === "server" ? "Camera: following the scene" : "Camera: yours";
  return {
    state,
    head: `${expanded ? "▾" : "▸"} ${icon} ${says}${count}`,
    rows: expanded ? all : [],
    riding,
    canRejoin: state !== "hidden" && !camera.serverHolds && camera.viewpoint !== null,
  };
}
