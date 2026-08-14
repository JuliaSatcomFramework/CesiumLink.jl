// A continuous field, draped over the globe as imagery: the module drapes a grid of finished colour
// over a declared rectangle, and knows nothing about what the scalar underneath it meant.
//
// Julia bakes the colour. There is no colormap here, no legend and no value — the payload is RGBA
// bytes and this module copies them onto a canvas. That is what keeps a colorbar and the pixels it
// describes from drifting apart: one author decided both.
//
// A keyframe crossing swaps the image; it does not blend two of them. Blending needs two textures
// and a shader mix, and the whole reason there is no shader here is that the colour arrives
// finished.
//
// What draws geometry is `primitives`. A raster is imagery, which is a different Cesium subsystem
// with its own layer stack, and that is why it is a module of its own.

import type { ImageryLayer, ImageryLayerCollection } from "@cesium/engine";
import { isNdArray, numbers, type NdArray } from "../../core/src/codec.ts";
import type { Disposable, ModuleContext } from "../../core/src/module-host.ts";
import type { Timeline } from "../../core/src/windows.ts";
import { gridAt, toCanvas, type Grid } from "./grid.ts";

/** One raster a window carries. */
interface HeatmapSpec {
  /** Names the raster inside the window. A later window replaces the layer of the same name. */
  kind: string;
  /** `[west, south, east, north]` in degrees. */
  extent: number[] | NdArray;
  /** `[H, W, 4]` u8, or `[K, H, W, 4]` for one grid per keyframe. */
  rgba: unknown;
}

/** What a window carries for this module: the rasters to drape, in the order they stack. */
interface HeatmapWindow {
  heatmaps?: HeatmapSpec[];
}

// This module's slice of each window it was addressed in. Null until setup makes the store.
let held: Timeline<HeatmapWindow> | null = null;
// The context of the loaded instance, for the placement and the scene a draw needs.
let host: ModuleContext | null = null;

/** One raster on screen: what it was drawn from, and the layer drawing it. */
interface Shown {
  spec: HeatmapSpec;
  /** Where that keyframe's block starts in the payload — what tells two keyframes apart. */
  offset: number;
  layer: ImageryLayer;
}

// The layers this module added, in declared order, and nothing else in the collection. The base
// imagery is not this module's to take down.
let shown: Shown[] = [];
// Counts draws. An image resolves asynchronously, so the token a draw took is compared against this
// before it reaches the screen: the last draw wins and every earlier one is dropped.
let epoch = 0;

/** The grid as something a provider can be built from, which for a canvas is a data URL. */
const url = (g: Grid): string => toCanvas(g).toDataURL();

function clear(layers: ImageryLayerCollection): void {
  for (const { layer } of shown) layers.remove(layer, true);
  shown = [];
}

/**
 * Draw what absolute keyframe `index` says, or leave the screen as it is where no window covers it.
 *
 * The whole stack is rebuilt whenever anything in it changes, because adding a layer appends it on
 * top: replacing one raster of several in place would silently restack the others.
 */
async function redraw(index: number): Promise<void> {
  const ctx = host;
  const at = ctx?.placement(index);
  const win = held?.at(at)?.w;
  if (!ctx || !at || !win) return;

  const want = (win.heatmaps ?? []).flatMap((spec) => {
    if (!isNdArray(spec.rgba)) throw new Error(`${spec.kind}: rgba is not an encoded array`);
    // A raster that says nothing about this keyframe draws nothing for it.
    const grid = gridAt(spec.rgba, at.k, at.window.count);
    return grid ? [{ spec, grid }] : [];
  });
  // Whatever this draw decides, an image still resolving is answering an older keyframe.
  const token = ++epoch;
  const same = want.length === shown.length &&
    want.every((w, i) => shown[i].spec === w.spec && shown[i].offset === w.grid.rgba.byteOffset);
  if (same) return;

  const { Cesium, scene } = ctx;
  // Every swap encodes one PNG per raster. A keyframe crossing is rare enough to pay for that. A
  // field that must follow the render tick needs a provider that uploads its texture directly.
  const providers = await Promise.all(want.map(({ spec, grid }) => {
    const [west, south, east, north] = numbers(spec.extent);
    return Cesium.SingleTileImageryProvider.fromUrl(url(grid), {
      rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
    });
  }));
  if (token !== epoch) return;
  clear(scene.imageryLayers);
  shown = want.map(({ spec, grid }, i) => ({
    spec,
    offset: grid.rgba.byteOffset,
    layer: scene.imageryLayers.addImageryProvider(providers[i]),
  }));
}

const draw = (index: number): void => {
  redraw(index).catch((err) => console.warn(`heatmap: ${err}`));
};

export default {
  setup(ctx: ModuleContext): Disposable {
    host = ctx;
    held = ctx.perWindow<HeatmapWindow>();
    const disposables = [
      ctx.onWindow((w, payload) => held?.install((payload ?? {}) as HeatmapWindow, w)),
      ctx.onKeyframe(draw),
    ];
    return () => {
      for (const dispose of disposables) dispose();
      // Anything still resolving is stale, so nothing it built reaches a scene this module has left.
      epoch++;
      clear(ctx.scene.imageryLayers);
      host = null;
      held = null;
    };
  },
};
