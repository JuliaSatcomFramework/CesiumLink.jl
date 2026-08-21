// Points or sprites: one billboard collection per family, so the whole family is one draw command
// whatever its colours — a billboard's colour, size and visibility are vertex attributes of the
// collection's batch, not separate primitives.
//
// Positions blend every tick; colour, size and visibility switch at the crossing. That split is the
// one assumption the vendored renderer makes about meaning, and it is what makes motion smooth.

import type {
  BillboardCollection, Cartesian3, Color, LabelCollection, NearFarScalar, Scene,
} from "@cesium/engine";
import type { NdArray } from "../../core/src/codec.ts";
import type { WindowInfo } from "../../core/src/windows.ts";
import { at, knob, type Knob, type Slice } from "./knobs.ts";
import { colorOf, WHITE, type CesiumRuntime } from "./paint.ts";
import type { Placement, Timeline } from "../../core/src/windows.ts";
import { markerSprite } from "./sprites.ts";

/** A node family as Julia sends it. */
export interface NodeSpec {
  kind: string;
  /** ECEF metres: `3 x N` static for the window, or `3 x N x count` interpolated across it. */
  position: NdArray;
  color?: unknown;
  size?: unknown;
  show?: unknown;
  /** What to draw each entity with: a stock glyph name, an `assets/<mount>/<file>` path, a
   *  `data:` URI, or the owner-namespaced name of a sprite a peer module registered. */
  marker?: string;
  /** One label per entity, drawn beside the marker. */
  label?: string[];
  /** `[near_m, near_scale, far_m, far_scale]`: markers stay legible close up and shrink far out. */
  scaleByDistance?: number[];
}

interface NodeWindow {
  n: number;
  position: Knob;
  color: Knob | null;
  size: Knob | null;
  show: Knob | null;
}

const DEFAULT_SIZE = 10;

/** One node family: the billboards, their live positions, and what each window said about them. */
export class NodeFamily {
  readonly positions: Cartesian3[] = [];
  private billboards: BillboardCollection | null = null;
  private labels: LabelCollection | null = null;
  private readonly timeline: Timeline<NodeWindow>;
  private n = 0;
  private built = "";
  private scale: NearFarScalar | undefined;
  private readonly scratch: Color;

  readonly kind: string;
  private readonly C: CesiumRuntime;
  private readonly scene: Scene;
  private readonly pickId: (kind: string, idx: number) => object;
  private readonly assetUrl: (path: string) => string | null;

  constructor(
    kind: string,
    C: CesiumRuntime,
    scene: Scene,
    pickId: (kind: string, idx: number) => object,
    assetUrl: (path: string) => string | null,
    timeline: Timeline<NodeWindow>,
  ) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.pickId = pickId;
    this.assetUrl = assetUrl;
    this.scratch = new C.Color();
    this.timeline = timeline;
  }

  /** Take one window's arrays, rebuilding the collection only when the family's shape changed. */
  onWindow(spec: NodeSpec, win: WindowInfo): void {
    const count = win.count;
    const n = spec.position.shape[spec.position.shape.length - 2] ?? 0;
    const w: NodeWindow = {
      n,
      position: knob(spec.position, { itemLen: 3, n, count, what: `${this.kind}.position` })!,
      color: knob(spec.color, { itemLen: 4, n, count, what: `${this.kind}.color` }),
      size: knob(spec.size, { itemLen: 1, n, count, what: `${this.kind}.size` }),
      show: knob(spec.show, { itemLen: 1, n, count, what: `${this.kind}.show` }),
    };
    // The billboards themselves depend only on the family's shape: how many entities, which glyph,
    // and what each is labelled. Everything else is an attribute write on standing primitives.
    const marker = spec.marker ?? "disc";
    const signature = `${n}|${marker}|${spec.scaleByDistance ?? []}|${
      (spec.label ?? []).join("\u0000")}`;
    if (signature !== this.built) {
      // Sizes from this window's first keyframe, which is what the marker is born at. A billboard
      // built at one size and written to another draws right either way, but an SVG marker is
      // rasterized once, at the size it was born with — see `build`.
      this.build(n, marker, spec.label, spec.scaleByDistance, w.size?.frame(0) ?? null);
      this.built = signature;
    }
    this.n = n;
    this.timeline.install(w, win);
  }

  /**
   * The collection this family draws through. `size` is the first keyframe's sizes, or null where
   * the window sets none.
   *
   * A billboard is born at the size it will be drawn at, rather than at a placeholder the first
   * keyframe corrects. A raster image would not care — it is uploaded at its own resolution and the
   * quad is scaled — but Cesium rasterizes an SVG at the width and height the billboard carries when
   * the image is assigned, and never again. Born at a placeholder, an SVG marker is a small texture
   * stretched over a larger quad for the rest of its life.
   *
   * Two cases still outgrow their raster, both only for SVG: a `size` that grows over the window,
   * and `scaleByDistance` drawing the marker larger than its base size close up. Give such a family
   * a raster image instead.
   */
  private build(n: number, marker: string, labels?: string[], scaleByDistance?: number[],
                size: Slice | null = null): void {
    const { C, scene } = this;
    this.destroyPrimitives();
    this.positions.length = 0;
    this.scale = scaleByDistance && scaleByDistance.length === 4
      ? new C.NearFarScalar(scaleByDistance[0], scaleByDistance[1], scaleByDistance[2], scaleByDistance[3])
      : undefined;
    const billboards = scene.primitives.add(new C.BillboardCollection({ scene })) as BillboardCollection;
    const image = markerSprite(marker, this.assetUrl);
    for (let i = 0; i < n; i++) {
      const position = new C.Cartesian3();
      this.positions.push(position);
      const px = size ? at(size, i) : DEFAULT_SIZE;
      billboards.add({
        position,
        image,
        // A stock glyph is white, so the billboard's own colour is what tints it and per-entity
        // colour needs no second image. That tint multiplies a supplied image too, which the default
        // white leaves as it was drawn.
        //
        // `size` writes both width and height, so an image is drawn square whatever its own shape.
        width: px, height: px,
        scaleByDistance: this.scale,
        id: this.pickId(this.kind, i),
      });
    }
    this.billboards = billboards;
    if (labels && labels.length) {
      const collection = scene.primitives.add(new C.LabelCollection({ scene })) as LabelCollection;
      for (let i = 0; i < n; i++) {
        collection.add({
          position: this.positions[i],
          text: labels[i] ?? "",
          font: "13px sans-serif",
          fillColor: C.Color.WHITE,
          outlineColor: C.Color.BLACK,
          outlineWidth: 2,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -14),
          verticalOrigin: C.VerticalOrigin.BOTTOM,
        });
      }
      this.labels = collection;
    }
  }

  /** True when this family's positions interpolate rather than stand still for the window. */
  get moving(): boolean {
    return this.timeline.latest?.position.keyframed ?? false;
  }

  /** The pick stamp of entity `idx`, for a module drawing something anchored to it. */
  pickIdAt(idx: number): object | undefined {
    if (idx < 0 || idx >= this.n) return undefined;
    return this.billboards?.get(idx)?.id as object | undefined;
  }

  /**
   * Whether entity `idx` is drawn. Read off the billboard rather than kept beside it, so what an
   * anchored primitive hides with is the mask this family is actually drawing. A billboard is born
   * shown and takes its first mask at the first keyframe.
   */
  shownAt(idx: number): boolean | undefined {
    if (idx < 0 || idx >= this.n) return undefined;
    return this.billboards?.get(idx)?.show ?? true;
  }

  /** Colour, size and visibility at the keyframe `p` names — attribute writes, never a rebuild. */
  onKeyframe(where: Placement | null): void {
    const place = this.timeline.at(where);
    const bb = this.billboards;
    if (!place || !bb) return;
    const { w, k } = place;
    const color = w.color?.frame(k) ?? null;
    const size = w.size?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    for (let i = 0; i < this.n; i++) {
      const b = bb.get(i);
      b.color = colorOf(this.C, color, i, WHITE, this.scratch);
      const px = size ? at(size, i) : DEFAULT_SIZE;
      b.width = px;
      b.height = px;
      b.show = show ? at(show, i) !== 0 : true;
      if (this.labels) this.labels.get(i).show = b.show;
    }
  }

  /**
   * Blend positions from the keyframe `atA` names toward the one `atB` names — the one knob that
   * interpolates rather than switches. `atB` falls back to `atA` at the run's last frame and for a
   * static family, which have nothing to blend toward.
   */
  onFrame(atA: Placement | null, atB: Placement | null, alpha: number): void {
    const a = this.timeline.at(atA);
    if (!a || !this.billboards) return;
    const b = this.timeline.at(atB) ?? a;
    const pa = a.w.position.frame(a.k);
    const pb = b.w.position.frame(b.k) ?? pa;
    if (!pa || !pb) return;
    const t = 1 - alpha;
    for (let i = 0; i < this.n; i++) {
      const p = this.positions[i];
      p.x = at(pa, i, 0) * t + at(pb, i, 0) * alpha;
      p.y = at(pa, i, 1) * t + at(pb, i, 1) * alpha;
      p.z = at(pa, i, 2) * t + at(pb, i, 2) * alpha;
      // The setter clones into the billboard's own storage and only marks dirty on a real move, so a
      // static family costs a comparison per entity and no upload.
      this.billboards.get(i).position = p;
      if (this.labels) this.labels.get(i).position = p;
    }
  }

  private destroyPrimitives(): void {
    for (const prim of [this.billboards, this.labels]) {
      if (prim) {
        try { this.scene.primitives.remove(prim); } catch { /* already gone */ }
      }
    }
    this.billboards = null;
    this.labels = null;
  }

  destroy(): void {
    this.destroyPrimitives();
    this.timeline.clear();
    this.built = "";
  }
}
