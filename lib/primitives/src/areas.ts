// Ground footprints, either computed about a centre or given vertex by vertex. Two primitives per
// family — one filled, one outlined — whose per-entity colour and visibility are geometry-instance
// attributes, so the whole family is one draw command each and a recolour or a filter is a write
// into a batch table.
//
// A family is also an edge endpoint: it keeps the point each footprint stands on, so a link from a
// ground cell to a satellite is one edge family over an area and a node. Those points
// stand still — the geometry they belong to is tessellated once — so the family never `moving`.
//
// The geometry is tessellated once and never again while it stands: it rides only a replacing
// window, because an append preserves the index space by definition and re-sending footprint centres
// per streamed keyframe would be the largest avoidable cost on the wire. A family of thousands of
// hexagons rebuilt per keyframe passes every visual check and destroys the frame budget.

import type {
  Cartesian3, Color, GeometryInstance, PolygonHierarchy, Primitive, Scene,
} from "@cesium/engine";
import type { NdArray } from "../../core/src/codec.ts";
import type { WindowInfo } from "../../core/src/windows.ts";
import { at, knob, type Knob, type Slice } from "./knobs.ts";
import { BLACK, colorOf, WHITE, type CesiumRuntime } from "./paint.ts";
import type { Placement, Timeline } from "../../core/src/windows.ts";

/** An area family as Julia sends it. The geometry keys ride only a replacing window. */
export interface AreaSpec {
  kind: string;
  /** Degrees, `2 x N` (lon, lat) — the footprint centres. */
  center?: NdArray;
  /**
   * The footprints vertex by vertex, in place of `center`: one entry per region, each entry the
   * rings of that region — the outer ring first, every ring after it a hole. A ring is `2 x V`
   * degrees of (lon, lat) and is open, so the last vertex joins the first.
   */
  boundary?: NdArray[][];
  /**
   * `4 x N` of (lon min, lon max, lat min, lat max), one column per region's outer ring. It travels
   * with `boundary` and is derived where the rings are checked, so it is never recomputed here.
   */
  extent?: NdArray;
  /** Footprint radius in metres: one for the family, or one per entity. */
  radius?: unknown;
  /** Corners of the regular polygon: 6 is a hexagon, 64 reads as a circle. */
  sides?: number;
  /**
   * Metres above the ellipsoid, to lift the fill clear of the imagery it would z-fight with: one for
   * the family, or one per entity.
   */
  heightM?: unknown;
  /**
   * Whether the footprints follow the curve of the ellipsoid. Absent decides it per region from the
   * angle that region spans; `true` and `false` force it for the whole family.
   */
  drape?: boolean;
  /**
   * Degrees of arc between the vertices Cesium lays inside a draped footprint, for the whole family.
   * Absent takes the module's default. Cost grows with the square of the cell count.
   */
  meshDeg?: number;
  color?: unknown;
  /** Outline colour; absent draws no outline. */
  outline?: unknown;
  show?: unknown;
}

interface AreaWindow {
  color: Knob | null;
  outline: Knob | null;
  show: Knob | null;
}

const DEFAULT_SIDES = 6;
export const DEFAULT_RADIUS = 1000;

/**
 * Degrees of angular span above which a footprint follows the ellipsoid instead of chording it.
 *
 * A polygon whose vertices are used exactly is a flat plane cutting through the globe, and it sags
 * `R(1 − cos(θ/2))` at its centre for an angular span `θ`. The radius cancels: the sag is `θ/8` of
 * the span, so the angle alone says how wrong the polygon looks. At this threshold that is 0.11% —
 * 61 m across 56 km — which stays under one pixel even when the polygon fills a 1000 px viewport.
 */
export const DRAPE_SPAN_DEG = 0.5;

/**
 * Degrees of arc between the vertices Cesium lays inside a draped footprint, when the caller names
 * no `meshDeg` of its own.
 *
 * How finely a footprint drapes is a different question from whether it drapes, so this must not be
 * derived from the threshold above. The sag of a mesh cell follows the size of the CELL alone and
 * not the size of the polygon, so one cell size serves a hexagon and a continent alike.
 *
 * A footprint smaller than one cell is drawn as a single cell, so between the drape threshold and
 * this size it becomes one flat plate again. That is not the coupling coming back: the error is the
 * sag of one cell either way, and a footprint smaller than a cell sags LESS than the budget every
 * other cell of every other footprint is already drawn to.
 *
 * Cost grows with the square of the cell count, so this is the number that decides whether a
 * continent-sized region is affordable: halving the cell quadruples the triangles. At this cell a
 * continent sags 4.8 km, which is 0.4 px on a globe drawn 1000 px across.
 *
 * 4 is where the return stopped when this was measured: coarser settings gave back no frame time
 * that could be told from this one, and carried several times the error for it. That reading was
 * one machine and one family, so treat it as the reason for the number rather than as a law.
 *
 * Two traps sit either side of measuring it again. A 2D map is the harder case, not a globe: a
 * globe hides half of itself and culls the rest against the horizon, while a 2D map draws every
 * footprint at once, so a number tuned on a globe alone comes out too fine. And a close camera says
 * nothing either — the edges of a footprint come from the caller's vertices rather than from the
 * mesh, so zooming in shows no difference at any cell and always reports that coarser is free.
 *
 * All of that rests on `Globe.depthTestAgainstTerrain` being false, which is its default: a sagging
 * polygon then draws over the globe instead of sinking into it. Turn it on, or give the globe real
 * terrain, and the sag shows at once. That caller is the one `meshDeg` exists for.
 */
const MESH_CELL_DEG = 4;

/** The finest cell a caller may ask for, in radians. Julia refuses the same value in degrees. */
const MIN_MESH_RAD = (0.01 * Math.PI) / 180;

/** Mean Earth radius in metres, to read a footprint radius as the angle it subtends. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * The most tessellation work a family may do on the main thread, in vertices.
 *
 * Counted rather than the number of regions: the cost of a build is the vertices Cesium walks, and
 * five country boundaries carry more of them than fifty footprint hexagons. A draped region adds
 * the cells its extent covers at the mesh granularity, because Cesium subdivides that region across
 * the ellipsoid instead of using its vertices as given.
 *
 * The budget is fifty default hexagons, which is the shape the 100 ms figure was measured on. Below
 * it the build runs inline, where it is over before a worker could start; above it the family goes
 * to the worker pool, which takes seconds to start over a slow link but holds neither the camera
 * nor the controls on the rebuilds a window triggers.
 *
 * ponytail: one flat budget, measured on footprint circles at 17 and 200. Re-measure before tuning.
 */
const SYNC_VERTEX_BUDGET = 300;

/** The angle a footprint of `radius` metres spans, in degrees: its diameter over the globe. */
export const spanDegrees = (radius: number): number =>
  (2 * radius * 180) / (EARTH_RADIUS_M * Math.PI);

/** One area family: the standing geometry, and what each window said about its colours and mask. */
export class AreaFamily {
  private fill: Primitive | null = null;
  private outline: Primitive | null = null;
  private ids: object[] = [];
  // The mask this family last applied, for an anchored primitive to hide with. Kept rather than read
  // back: a geometry-instance attribute exists only once its Primitive has rendered, so before that
  // there is nothing to ask, and the build-time value is the only answer.
  private shown: boolean[] = [];
  /** The point each footprint stands on, for an edge family hanging off this one. */
  readonly positions: Cartesian3[] = [];
  private readonly timeline: Timeline<AreaWindow>;
  private n = 0;
  private built = "";
  private readonly showScratch = new Uint8Array(1);
  private readonly scratch: Color;

  readonly kind: string;
  private readonly C: CesiumRuntime;
  private readonly scene: Scene;
  private readonly pickId: (kind: string, idx: number) => object;

  constructor(
    kind: string,
    C: CesiumRuntime,
    scene: Scene,
    pickId: (kind: string, idx: number) => object,
    timeline: Timeline<AreaWindow>,
  ) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.pickId = pickId;
    this.scratch = new C.Color();
    this.timeline = timeline;
  }

  onWindow(spec: AreaSpec, win: WindowInfo): void {
    const count = win.count;
    // Nothing to colour or mask until something has been tessellated. Said here rather than left to
    // the per-entity arrays below, which would otherwise report their own length against a family of
    // no entities and send the reader looking for the wrong mistake.
    if (!spec.center && !spec.boundary && !this.built) {
      throw new Error(`primitives: ${win.mode} window gives area family "${this.kind}" no ` +
                      "footprint centres and no boundary, and none are standing — they ride a " +
                      "replacing window");
    }
    if (spec.center) this.n = spec.center.shape[0] ?? 0;
    else if (spec.boundary) this.n = spec.boundary.length;
    const n = this.n;
    const what = (name: string) => `${this.kind}.${name}`;
    const w: AreaWindow = {
      color: knob(spec.color, { itemLen: 4, n, count, what: what("color") }),
      outline: knob(spec.outline, { itemLen: 4, n, count, what: what("outline") }),
      show: knob(spec.show, { itemLen: 1, n, count, what: what("show") }),
    };
    if (spec.center || spec.boundary) {
      // Rebuild only when what the geometry is made of changed: a window repeating the same
      // footprints leaves the tessellation standing, whatever it says about colour.
      // Whether a footprint follows the globe and how finely it does are both how the geometry is
      // made, so a window that changes either and repeats the same footprints must still
      // re-tessellate them.
      const mesh = `${spec.drape ?? "span"}|${spec.meshDeg ?? "default"}`;
      const height = digest(scalarData(spec.heightM));
      const signature = spec.boundary
        ? `${n}|${height}|${mesh}|${ringsDigest(spec.boundary)}`
        : `${n}|${spec.sides ?? DEFAULT_SIDES}|${height}|${mesh}|` +
          `${digest(spec.center!.data)}|${digest(scalarData(spec.radius))}`;
      if (signature !== this.built) {
        this.build(spec, w, n, count);
        this.built = signature;
      }
    }
    this.timeline.install(w, win);
  }

  private build(spec: AreaSpec, w: AreaWindow, n: number, count: number): void {
    const { C, scene } = this;
    this.destroyPrimitives();
    const lonlat = spec.center?.data ?? null;
    const sides = Math.max(3, Math.round(spec.sides ?? DEFAULT_SIDES));
    // Clamped rather than trusted, as `sides` above is. Cesium's own bounds check on `granularity`
    // lives inside a debug-only block, so a release build takes a zero and subdivides for ever, and
    // a whole turn of the globe reaches `chordLength` as a cell of no length at all. Julia refuses
    // both with a better message; a module speaking the wire directly does not go through Julia.
    const meshRadians = Math.min(Math.PI, Math.max(MIN_MESH_RAD,
      ((spec.meshDeg ?? MESH_CELL_DEG) * Math.PI) / 180));
    const meshDegrees = (meshRadians * 180) / Math.PI;
    const heights = knob(spec.heightM, { itemLen: 1, n, count, what: `${this.kind}.height_m` })?.frame(0) ?? null;
    const radius = knob(spec.radius, { itemLen: 1, n, count, what: `${this.kind}.radius` })?.frame(0) ?? null;
    // The colours and mask the instances are born with come from this window's first keyframe,
    // because a Primitive's attributes cannot be written before its first render — instances built
    // without them would show the wrong thing until a crossing arrived.
    const color = w.color?.frame(0) ?? null;
    const outlineColor = w.outline?.frame(0) ?? null;
    const show = w.show?.frame(0) ?? null;

    const fills: GeometryInstance[] = new Array(n);
    const outlines: GeometryInstance[] = outlineColor ? new Array(n) : [];
    this.ids = new Array(n);
    this.shown = new Array(n);
    // What this family costs to tessellate, against `SYNC_VERTEX_BUDGET`.
    let vertexCost = 0;
    for (let i = 0; i < n; i++) {
      const region = spec.boundary?.[i];
      const height = heights ? at(heights, i) : 0;
      let hierarchy: PolygonHierarchy;
      let span: number;
      if (region) {
        hierarchy = this.rings(region, height);
        for (const ring of region) vertexCost += ring.data.length / 2;
        // An edge hangs off the middle of the region's extent. A given boundary has no centre of
        // its own, and averaging its vertices would pull the point towards the finely drawn side.
        const e = spec.extent!.data;
        this.positions.push(C.Cartesian3.fromDegrees(
          (e[i * 4] + e[i * 4 + 1]) / 2, (e[i * 4 + 2] + e[i * 4 + 3]) / 2, height));
        // Degrees of longitude cover less ground away from the equator, so reading them as an angle
        // over-tessellates a high-latitude region rather than under-tessellating one.
        span = Math.max(e[i * 4 + 1] - e[i * 4], e[i * 4 + 3] - e[i * 4 + 2]);
      } else {
        const center = C.Cartesian3.fromDegrees(lonlat![i * 2], lonlat![i * 2 + 1], height);
        this.positions.push(center);
        const r = radius ? at(radius, i) : DEFAULT_RADIUS;
        hierarchy = this.footprint(center, r, sides);
        vertexCost += sides;
        span = spanDegrees(r);
      }
      // Below the threshold the vertices are used exactly, which is both cheaper and the only way to
      // keep a footprint's corners where they were computed. Above it Cesium subdivides the polygon
      // across the ellipsoid, and then it reads one height for the whole surface rather than the
      // heights of the vertices.
      const draped = spec.drape ?? span > DRAPE_SPAN_DEG;
      const shape = draped ? { height, granularity: meshRadians } : { perPositionHeight: true };
      // A draped region is subdivided across the ellipsoid rather than drawn from its own vertices,
      // so its cost is the cells its extent covers at the mesh granularity.
      if (draped) vertexCost += (span / meshDegrees) ** 2;
      const id = (this.ids[i] = this.pickId(this.kind, i));
      // Every instance carries a `show` attribute whether or not this window masks anything: an
      // attribute absent at build time cannot be written later, and a mask is how the server hides
      // an entity.
      this.shown[i] = show ? at(show, i) !== 0 : true;
      const shown = new C.ShowGeometryInstanceAttribute(this.shown[i]);
      fills[i] = new C.GeometryInstance({
        // Keep this vertex format. The default format stops every region in the scene when one
        // polygon is 180° or wider: Cesium then computes its texture coordinates through a path
        // that throws `normalized result is not a number`. The appearance below is `flat`, so it
        // reads the position only and drops the normal and the texture coordinate anyway.
        geometry: new C.PolygonGeometry({
          polygonHierarchy: hierarchy, ...shape,
          vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(this.color(color, i, WHITE)),
          show: shown,
        },
        id,
      });
      if (outlineColor) {
        outlines[i] = new C.GeometryInstance({
          geometry: new C.PolygonOutlineGeometry({ polygonHierarchy: hierarchy, ...shape }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(this.color(outlineColor, i, BLACK)),
            show: shown,
          },
          id,
        });
      }
    }
    // A cheap family tessellates inline, where the build is over before a worker could start. An
    // expensive one goes off the main thread, because building it inline holds the camera and
    // controls on every rebuild a window triggers, not only the first. The cost is that those
    // regions are absent for the frames the build takes.
    const asynchronous = vertexCost > SYNC_VERTEX_BUDGET;
    this.fill = scene.primitives.add(new C.Primitive({
      geometryInstances: fills,
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
      asynchronous,
    })) as Primitive;
    if (outlineColor) {
      this.outline = scene.primitives.add(new C.Primitive({
        geometryInstances: outlines,
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous,
      })) as Primitive;
    }
  }

  /**
   * The hierarchy a region's rings describe: the outer ring, and one hole for every ring after it.
   * The tessellated geometry genuinely has the hole, so the outline traces it and a pointer over it
   * misses this region.
   */
  private rings(region: NdArray[], height: number): PolygonHierarchy {
    const { C } = this;
    const holes = region.slice(1).map((h) => new C.PolygonHierarchy(this.vertices(h, height)));
    return new C.PolygonHierarchy(this.vertices(region[0], height), holes);
  }

  /** One ring's vertices, lifted to `height`. The ring is open: its last vertex joins its first. */
  private vertices(ring: NdArray, height: number): Cartesian3[] {
    const { data } = ring;
    const out: Cartesian3[] = new Array(data.length / 2);
    for (let j = 0; j < out.length; j++) {
      out[j] = this.C.Cartesian3.fromDegrees(data[j * 2], data[j * 2 + 1], height);
    }
    return out;
  }

  /** Corners of a regular `sides`-gon of `radius` metres about `center`, in its ENU frame. */
  private footprint(center: Cartesian3, radius: number, sides: number): PolygonHierarchy {
    const { C } = this;
    const enu = C.Transforms.eastNorthUpToFixedFrame(center);
    const corners = Array.from({ length: sides }, (_, i) => {
      const a = (2 * Math.PI * i) / sides;
      return C.Matrix4.multiplyByPoint(
        enu, new C.Cartesian3(radius * Math.cos(a), radius * Math.sin(a), 0), new C.Cartesian3());
    });
    return new C.PolygonHierarchy(corners);
  }

  /** Colour and mask at the keyframe `where` names: attribute writes on geometry that stands. */
  onKeyframe(where: Placement | null): void {
    const place = this.timeline.at(where);
    if (!place) return;
    const { w, k } = place;
    // Attributes exist only once a Primitive has rendered; before that the build-time values stand,
    // and they are this window's.
    const fill = this.fill?.ready ? this.fill : null;
    const outline = this.outline?.ready ? this.outline : null;
    if (!fill && !outline) return;
    const color = w.color?.frame(k) ?? null;
    const outlineColor = w.outline?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    const C = this.C;
    for (let i = 0; i < this.n; i++) {
      this.shown[i] = show ? at(show, i) !== 0 : true;
      // Both setters copy into their primitive's batch table, so one scratch serves every entity and
      // both primitives — an allocation per entity per keyframe would not.
      const shown = C.ShowGeometryInstanceAttribute.toValue(this.shown[i], this.showScratch);
      const f = fill?.getGeometryInstanceAttributes(this.ids[i]);
      if (f) {
        if (color) f.color = C.ColorGeometryInstanceAttribute.toValue(this.color(color, i, WHITE), f.color);
        f.show = shown;
      }
      // The outline is a separate primitive with its own batch table, so a hidden entity has to be
      // hidden twice or its outline survives the fill.
      const o = outline?.getGeometryInstanceAttributes(this.ids[i]);
      if (o) {
        if (outlineColor) {
          o.color = C.ColorGeometryInstanceAttribute.toValue(this.color(outlineColor, i, BLACK), o.color);
        }
        o.show = shown;
      }
    }
  }

  private color(s: Slice | null, i: number, fallback: readonly number[]): Color {
    return colorOf(this.C, s, i, fallback, this.scratch);
  }

  /** Footprints are tessellated once and never move, so nothing hanging off one has to follow it. */
  get moving(): boolean {
    return false;
  }

  /** The pick stamp of entity `idx`, for a module drawing something anchored to it. */
  pickIdAt(idx: number): object | undefined {
    return this.ids[idx];
  }

  /** Whether entity `idx` is drawn, so an anchored primitive hides with it. */
  shownAt(idx: number): boolean | undefined {
    return this.shown[idx];
  }

  private destroyPrimitives(): void {
    for (const prim of [this.fill, this.outline]) {
      if (prim) {
        try { this.scene.primitives.remove(prim); } catch { /* already gone */ }
      }
    }
    this.fill = null;
    this.outline = null;
    this.ids = [];
    this.shown = [];
    this.positions.length = 0;
  }

  destroy(): void {
    this.destroyPrimitives();
    this.timeline.clear();
    this.built = "";
    this.n = 0;
  }
}

const scalarData = (knobValue: unknown): ArrayLike<number> =>
  (typeof knobValue === "number" ? [knobValue] : ((knobValue as NdArray | null)?.data ?? []));

/** A cheap digest of what a tessellation was built from, so a repeated window leaves it standing. */
function digest(a: ArrayLike<number>): string {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  return `${a.length}:${a[0] ?? 0}:${a[a.length - 1] ?? 0}:${sum}`;
}

/** The same in the shape a boundary comes in: how many vertices each ring holds, and their sum. */
function ringsDigest(boundary: NdArray[][]): string {
  let counts = "";
  let sum = 0;
  for (const region of boundary) {
    for (const ring of region) {
      counts += `${ring.data.length / 2},`;
      for (let i = 0; i < ring.data.length; i++) sum += ring.data[i];
    }
    counts += ";";
  }
  return `${counts}:${sum}`;
}
