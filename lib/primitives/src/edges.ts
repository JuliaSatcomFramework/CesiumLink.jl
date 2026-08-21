// Lines between two endpoint families, by index. One polyline collection per family, and one
// material per distinct appearance within it — never one per line. Cesium buckets a collection's polylines by
// material type and then emits one draw command per run of consecutive lines whose material type and
// uniform values match, so lines are added grouped by appearance: a family of hundreds of edges in
// four appearances is four draw commands, and the material objects behind them are four.
//
// Width and visibility are batch-table attributes rather than part of the material, so mixing widths
// inside one appearance costs nothing and a keyframe that changes only those two is written onto the
// standing lines. Colour and connectivity are not: a polyline's colour lives in its material, which
// is what its batch is keyed on, so a keyframe that changes either rebuilds the collection.
//
// Endpoints are the endpoint families' live position objects, so an edge tracks its satellite
// between keyframes without holding a copy of anything. An endpoint family is a node family or an
// area family: a node contributes its position, an area its footprint centre.

import type { Cartesian3, Color, Material, PolylineCollection, Scene } from "@cesium/engine";
import { sayOnce } from "../../core/src/once.ts";
import { sourceOf } from "../../core/src/source.ts";
import type { WindowInfo } from "../../core/src/windows.ts";
import { at, knob, type Knob } from "./knobs.ts";
import { channel, WHITE, type CesiumRuntime } from "./paint.ts";
import { registry } from "./registry.ts";
import type { At, Placement, Timeline } from "../../core/src/windows.ts";

// A stock name holds no `.` and no `/`: either would read as a module name or an asset path.
/** The stock line materials, in the order their codes travel on the wire. */
const STYLES = ["solid", "dashed", "glow"] as const;

/**
 * What a registered edge material answers with: the Cesium `Material` one appearance is drawn with.
 * `color` is that appearance's colour and `dashLength` the family's dash period, so a factory can
 * honour either without reading the payload.
 *
 * Answer a fresh material every call. The family owns what it is handed and frees it when the
 * appearance goes out of use, so one material shared across two calls is freed twice.
 */
export type EdgeMaterialFactory =
  (C: CesiumRuntime, look: { color: Color; dashLength: number }) => Material;

const custom = registry<EdgeMaterialFactory>("edge material");

/**
 * Register an edge material another module builds, under an owner-namespaced name (`orbits.pulse`)
 * that a scene then names as its `style`. Call it from your module's `setup`.
 *
 * The factory runs once per distinct appearance and every line of that appearance shares the one
 * material, so a family stays one draw command per appearance.
 */
export const defineEdgeMaterial = custom.define;

/**
 * Drop every registered material. Called when `primitives` unloads: the modules that registered them
 * are unloaded alongside it, and their factories close over a context that no longer exists.
 *
 * The names already warned about go with them, so a name still unanswered after a reload gets its
 * line again rather than staying silent behind the set the last session filled.
 */
export function clearEdgeMaterials(): void {
  custom.clear();
  say = reporter();
}

// One line per unresolvable name. A family rebuilds on every replacing window, so a style nobody
// answers for is unanswered on every one of them.
const reporter = () => sayOnce((message: string) => console.warn(message));
let say = reporter();

/**
 * The material name a style code stands for: the family's own table entry where it has one, and the
 * stock name of that code otherwise. A code past both draws solid, which keeps a bad code visible
 * rather than leaving the family undrawn.
 */
function styleName(code: number, styles?: (string | null)[]): string {
  return styles?.[code] ?? STYLES[code] ?? "solid";
}

/**
 * What an edge reads of the family at either of its ends. A node family contributes its position
 * and an area family its footprint centre, so a link from a ground cell to a satellite is one edge
 * family over one of each and needs no invisible stand-in.
 *
 * Exported only so `endpoints.test.ts` can supply a stand-in family; every production implementation
 * lives in this package and is reached through `EdgeFamily`'s own constructor argument.
 */
export interface EndpointFamily {
  /** The live position object of each entity — the very object the family moves, not a copy. */
  readonly positions: Cartesian3[];
  /** True while this family's positions change between keyframes. */
  readonly moving: boolean;
}

/** An edge family as Julia sends it. */
export interface EdgeSpec {
  kind: string;
  /** Endpoint family the first index of each pair addresses. */
  from: string;
  /** Endpoint family the second index of each pair addresses. */
  to: string;
  /** 0-based `(from, to)` index pairs: `2 x M`, or one such array per keyframe. */
  pairs: unknown;
  color?: unknown;
  /** Material code, indexing `styles`: family-wide, per edge, or per edge per keyframe. */
  style?: unknown;
  /**
   * One entry per material code: a name, an asset path or a `data:` URI for a code beyond the stock
   * ones, and nothing for a stock code. Codes `0`, `1` and `2` stay `solid`, `dashed` and `glow`, so
   * the first three entries stand empty and a family that names no custom material sends no table.
   */
  styles?: (string | null)[];
  /** Line width in pixels. */
  width?: unknown;
  show?: unknown;
  /** Pixels of one dash period, for the dashed style. */
  dashLength?: number;
}

interface EdgeWindow {
  spec: EdgeSpec;
  pairs: Knob;
  color: Knob | null;
  style: Knob | null;
  width: Knob | null;
  show: Knob | null;
  /** True when a crossing can change which lines exist, or what material they take. */
  rebuilds: boolean;
  /** True when a crossing can change an attribute of lines that stand. */
  restyles: boolean;
}

/** One distinct line appearance: the material it is drawn with, and the colour its uniforms carry. */
interface Look {
  /** What the style code resolved to: a stock name, a registered name, an asset path or a URI. */
  style: string;
  rgba: [number, number, number, number];
}

const DEFAULT_WIDTH = 1;
const DEFAULT_DASH = 16;

/** One edge family: its polylines, the materials they share, and what each window said about them. */
export class EdgeFamily {
  private lines: PolylineCollection | null = null;
  private readonly timeline: Timeline<EdgeWindow>;
  private readonly materials = new Map<string, Material>();
  /** Endpoint pairs by edge index — the node families' own position objects, not copies. */
  private ends: Cartesian3[][] = [];
  /** Edge index drawn by each polyline, in the order they were added. */
  private order: number[] = [];
  /** What the standing polylines describe, or null when none stand. */
  private drawn: At<EdgeWindow> | null = null;
  private moving = false;
  /**
   * True from a rebuild until the next frame reads the endpoints back. A line is added against the
   * endpoint families' position objects, which hold the coordinates of the tick before, so every
   * rebuild owes one read whether or not either end moves.
   */
  private stale = false;

  readonly kind: string;
  private readonly C: CesiumRuntime;
  private readonly scene: Scene;
  private readonly endpoints: (kind: string) => EndpointFamily | undefined;
  private readonly pickId: (kind: string, idx: number) => object;
  private readonly assetUrl: (path: string) => string | null;

  constructor(
    kind: string,
    C: CesiumRuntime,
    scene: Scene,
    endpoints: (kind: string) => EndpointFamily | undefined,
    pickId: (kind: string, idx: number) => object,
    assetUrl: (path: string) => string | null,
    timeline: Timeline<EdgeWindow>,
  ) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.endpoints = endpoints;
    this.pickId = pickId;
    this.assetUrl = assetUrl;
    this.timeline = timeline;
  }

  onWindow(spec: EdgeSpec, win: WindowInfo): void {
    const count = win.count;
    const what = (name: string) => `${this.kind}.${name}`;
    const w: EdgeWindow = {
      spec,
      pairs: knob(spec.pairs, { itemLen: 2, count, what: what("pairs") })!,
      color: knob(spec.color, { itemLen: 4, count, what: what("color") }),
      style: knob(spec.style, { itemLen: 1, count, what: what("style") }),
      width: knob(spec.width, { itemLen: 1, count, what: what("width") }),
      show: knob(spec.show, { itemLen: 1, count, what: what("show") }),
      rebuilds: false,
      restyles: false,
    };
    w.rebuilds = !!(w.pairs.keyframed || w.color?.keyframed || w.style?.keyframed);
    w.restyles = !!(w.width?.keyframed || w.show?.keyframed);
    if (!this.lines) {
      this.lines = this.scene.primitives.add(new this.C.PolylineCollection()) as PolylineCollection;
    }
    if (win.mode === "replace") this.drawn = null;
    this.timeline.install(w, win);
  }

  /** Bring the lines up to date with the keyframe `where` names, rebuilding only where it must. */
  onKeyframe(where: Placement | null): void {
    const place = this.timeline.at(where);
    const pl = this.lines;
    if (!place || !pl) return;
    const { w, k } = place;
    const pairs = w.pairs.frame(k);
    if (!pairs) return;
    // A family-wide `pairs` would say every edge shares one pair, which is not a connectivity.
    if (!Number.isFinite(pairs.length)) throw new Error(`primitives: ${this.kind}.pairs is per edge`);

    const from = this.endpoints(w.spec.from);
    const to = this.endpoints(w.spec.to);
    if (!from || !to) {
      // The families this one joins are gone, so its indices address nothing. Drop the lines rather
      // than leave them standing on endpoints nobody owns any more.
      this.clearLines();
      this.order = [];
      this.drawn = null;
      return;
    }
    this.moving = from.moving || to.moving;

    const width = w.width?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    if (this.drawn && !w.rebuilds) {
      if (w.restyles) {
        for (let p = 0; p < this.order.length; p++) {
          const e = this.order[p];
          const line = pl.get(p);
          if (width) line.width = at(width, e);
          if (show) line.show = at(show, e) !== 0;
        }
      }
      this.drawn = place;
      return;
    }

    const color = w.color?.frame(k) ?? null;
    const style = w.style?.frame(k) ?? null;
    const dash = w.spec.dashLength ?? DEFAULT_DASH;

    // Group by appearance before adding: draw commands are runs of consecutive matching lines, so
    // interleaving appearances would emit one command per line instead of one per appearance.
    const byLook = new Map<string, { look: Look; edges: number[] }>();
    const m = pairs.length;
    for (let e = 0; e < m; e++) {
      const look: Look = {
        style: styleName(style ? at(style, e) : 0, w.spec.styles),
        rgba: [channel(color, e, 0, WHITE), channel(color, e, 1, WHITE),
               channel(color, e, 2, WHITE), channel(color, e, 3, WHITE)],
      };
      // Keyed on the resolved name rather than the code: a replacing window may hand the same code
      // a different material, and the cache outlives the window.
      const key = `${look.style}|${look.rgba}|${dash}`;
      const group = byLook.get(key);
      if (group) group.edges.push(e);
      else byLook.set(key, { look, edges: [e] });
    }

    this.clearLines();
    this.ends = new Array(m);
    this.order = new Array(m);
    let p = 0;
    for (const [key, { look, edges }] of byLook) {
      const material = this.material(key, look, dash);
      for (const e of edges) {
        const u = at(pairs, e, 0);
        const v = at(pairs, e, 1);
        const ends = [from.positions[u], to.positions[v]];
        if (!ends[0] || !ends[1]) continue;   // an index the endpoint family does not have
        this.ends[e] = ends;
        this.order[p++] = e;
        pl.add({
          positions: ends,
          width: width ? at(width, e) : DEFAULT_WIDTH,
          show: show ? at(show, e) !== 0 : true,
          material,
          id: this.pickId(this.kind, e),
        });
      }
    }
    this.order.length = p;
    this.evictMaterials(byLook);
    this.drawn = place;
    this.stale = true;
  }

  /** Follow the interpolated endpoints, so an edge tracks its moving end between keyframes. */
  onFrame(): void {
    const pl = this.lines;
    // Two standing endpoint families give an edge nothing to follow after the first read: their
    // position objects are never written again. One moving end is enough to owe a read every tick.
    // The first read after a rebuild is owed either way — see `stale`.
    if (!pl || (!this.moving && !this.stale)) return;
    this.stale = false;
    for (let p = 0; p < this.order.length; p++) {
      const ends = this.ends[this.order[p]];
      // The endpoints are the very objects the node families interpolate, so the values are already
      // current; re-assigning is what tells the polyline its geometry changed.
      if (ends) pl.get(p).positions = ends;
    }
  }

  /** Live endpoints of edge `idx`, for a module drawing something coincident with it. */
  endpointsOf(idx: number): [Cartesian3, Cartesian3] | undefined {
    const ends = this.ends[idx];
    return ends ? [ends[0], ends[1]] : undefined;
  }

  /** The endpoint families this family joins, and the pairs standing at the drawn keyframe. */
  connectivity(): { from: string; to: string; pairs: Uint32Array } | undefined {
    const place = this.drawn ?? undefined;
    if (!place) return undefined;
    const slice = place.w.pairs.frame(place.k);
    if (!slice || !Number.isFinite(slice.length)) return undefined;
    const { data, offset, length } = slice;
    const pairs = data instanceof Uint32Array
      ? data.subarray(offset, offset + length * 2)
      : Uint32Array.from({ length: length * 2 }, (_, i) => data[offset + i]);
    return { from: place.w.spec.from, to: place.w.spec.to, pairs };
  }

  /** The one material every line of one appearance shares, built on first use and kept for reuse. */
  private material(key: string, look: Look, dashLength: number): Material {
    const held = this.materials.get(key);
    if (held) return held;
    const [r, g, b, a] = look.rgba;
    const material = this.build(look.style, this.C.Color.fromBytes(r, g, b, a), dashLength);
    this.materials.set(key, material);
    return material;
  }

  /**
   * What one appearance is drawn with, in the four forms a style name takes: a `data:` URI or a file
   * the server serves, textured along the line; a material a peer module registered; or one of the
   * stock three. A name nothing answers for falls back to the solid line, which keeps a typo visible
   * rather than leaving the family undrawn.
   *
   * An image material repeats along the line, so the author picks its aspect ratio. Cesium loads it
   * asynchronously and the line draws plain for the frames that takes, and it puts the raw URI in
   * the material id until the texture arrives — which is why anything large belongs on an assets
   * mount rather than in a `data:` URI.
   *
   * Cesium buckets a collection by material type and uniform values, so a custom material buckets
   * the way the stock three do: one more appearance is one more draw command, and no more.
   */
  private build(style: string, color: Color, dashLength: number): Material {
    const source = sourceOf(style);
    switch (source.kind) {
      case "data":
        return this.C.Material.fromType("Image", { image: source.uri, color });
      case "asset": {
        // `assetUrl` writes its own line for a path this host cannot reach, so this only draws.
        const url = this.assetUrl(source.path);
        return url ? this.C.Material.fromType("Image", { image: url, color })
                   : this.stock("solid", color, dashLength);
      }
      case "module": {
        const factory = custom.get(source.name);
        if (factory) return factory(this.C, { color, dashLength });
        say(style, `primitives: no edge material named ${JSON.stringify(style)} is registered; ` +
                   "the solid line is drawn");
        return this.stock("solid", color, dashLength);
      }
      case "stock":
        // Silent: the stock table is this module's own, and a name outside it is a typo solid shows.
        return this.stock(source.name, color, dashLength);
    }
  }

  /** One of the stock three, by name. Anything else is the solid line. */
  private stock(name: string, color: Color, dashLength: number): Material {
    return name === "dashed"
      ? this.C.Material.fromType("PolylineDash", { color, dashLength })
      : name === "glow"
        ? this.C.Material.fromType("PolylineGlow", { color, glowPower: 0.28, taperPower: 1.0 })
        : this.C.Material.fromType("Color", { color });
  }

  // Materials outlive a rebuild, so a family cycling through the same few appearances every keyframe
  // builds each of them once. Only the ones still in use, though: with a colour per edge off a
  // colormap the cache would otherwise gain an object per distinct colour for the family's life.
  private evictMaterials(inUse: Map<string, unknown>): void {
    for (const [key, material] of this.materials) {
      if (inUse.has(key)) continue;
      this.materials.delete(key);
      try { material.destroy(); } catch { /* already gone */ }
    }
  }

  private clearLines(): void {
    const pl = this.lines;
    if (!pl) return;
    // A Polyline frees its own material when it is destroyed, so a material shared across lines has
    // to be detached from every one of them first — otherwise the second removal double-frees it and
    // throws, stranding whatever had not been removed yet. `_material` is private because the public
    // setter refuses undefined: there is no supported way to tell a Polyline it no longer owns one.
    for (let i = 0; i < pl.length; i++) {
      (pl.get(i) as unknown as { _material?: Material })._material = undefined;
    }
    pl.removeAll();
  }

  destroy(): void {
    this.clearLines();
    if (this.lines) {
      try { this.scene.primitives.remove(this.lines); } catch { /* already gone */ }
    }
    this.evictMaterials(new Map());
    this.lines = null;
    this.ends = [];
    this.order = [];
    this.drawn = null;
    this.timeline.clear();
  }
}
