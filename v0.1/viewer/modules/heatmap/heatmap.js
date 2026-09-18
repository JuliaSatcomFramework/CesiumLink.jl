// core/src/codec.ts
function blockAt(a, k, baseRank, count) {
  const { data, shape } = a;
  if (shape.length <= baseRank) {
    return { data, offset: 0, len: data.length, keyframed: false };
  }
  if (shape.length !== baseRank + 1) {
    throw new Error(`codec: shape [${shape}] is more than one rank above base rank ${baseRank}`);
  }
  if (shape[0] !== count) {
    throw new Error(`codec: shape [${shape}] has ${shape[0]} keyframes, the window carries ${count}`);
  }
  if (k < 0 || k >= count) return null;
  let len = 1;
  for (let axis = 1; axis < shape.length; axis++) len *= shape[axis];
  return { data, offset: k * len, len, keyframed: true };
}
function isNdArray(v) {
  const o = v;
  return !!o && typeof o === "object" && ArrayBuffer.isView(o.data) && Array.isArray(o.shape);
}
var numbers = (v) => v === void 0 ? [] : isNdArray(v) ? Array.from(v.data) : v;

// heatmap/src/grid.ts
function gridAt(a, k, count) {
  const { shape, data } = a;
  if (shape.length !== 3 && shape.length !== 4) {
    throw new Error(`a grid is [H, W, 4] or [K, H, W, 4], not [${shape}]`);
  }
  if (shape[shape.length - 1] !== 4) {
    throw new Error(`the last axis of a grid is the four RGBA bytes, not ${shape[shape.length - 1]}`);
  }
  if (!(data instanceof Uint8Array)) {
    throw new Error(`a grid is u8, and this one is ${data.constructor.name}`);
  }
  const size = shape.reduce((bytes, axis) => bytes * axis, 1);
  if (data.length !== size) {
    throw new Error(`a grid of [${shape}] is ${size} bytes, and this one is ${data.length}`);
  }
  const [height, width] = shape.slice(-3);
  const block = blockAt(a, k, 3, count);
  return block && { width, height, rgba: data.subarray(block.offset, block.offset + block.len) };
}
function toCanvas(g) {
  const canvas = document.createElement("canvas");
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("a 2d canvas context was refused");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(g.rgba), g.width, g.height), 0, 0);
  return canvas;
}

// heatmap/src/index.ts
var held = null;
var host = null;
var shown = [];
var epoch = 0;
var url = (g) => toCanvas(g).toDataURL();
function clear(layers) {
  for (const { layer } of shown) layers.remove(layer, true);
  shown = [];
}
async function redraw(index) {
  const ctx = host;
  const at = ctx?.placement(index);
  const win = held?.at(at)?.w;
  if (!ctx || !at || !win) return;
  const want = (win.heatmaps ?? []).flatMap((spec) => {
    if (!isNdArray(spec.rgba)) throw new Error(`${spec.kind}: rgba is not an encoded array`);
    const grid = gridAt(spec.rgba, at.k, at.window.count);
    return grid ? [{ spec, grid }] : [];
  });
  const token = ++epoch;
  const same = want.length === shown.length && want.every((w, i) => shown[i].spec === w.spec && shown[i].offset === w.grid.rgba.byteOffset);
  if (same) return;
  const { Cesium, scene } = ctx;
  const providers = await Promise.all(want.map(({ spec, grid }) => {
    const [west, south, east, north] = numbers(spec.extent);
    return Cesium.SingleTileImageryProvider.fromUrl(url(grid), {
      rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north)
    });
  }));
  if (token !== epoch) return;
  clear(scene.imageryLayers);
  shown = want.map(({ spec, grid }, i) => ({
    spec,
    offset: grid.rgba.byteOffset,
    layer: scene.imageryLayers.addImageryProvider(providers[i])
  }));
}
var draw = (index) => {
  redraw(index).catch((err) => console.warn(`heatmap: ${err}`));
};
var src_default = {
  setup(ctx) {
    host = ctx;
    held = ctx.perWindow();
    const disposables = [
      ctx.onWindow((w, payload) => held?.install(payload ?? {}, w)),
      ctx.onKeyframe(draw)
    ];
    return () => {
      for (const dispose of disposables) dispose();
      epoch++;
      clear(ctx.scene.imageryLayers);
      host = null;
      held = null;
    };
  }
};
export {
  src_default as default
};
//# sourceMappingURL=heatmap.js.map
