import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

// The module reaches two things outside itself: a canvas, to fill with the grid's own bytes, and
// Cesium, to turn that canvas into an imagery layer. Both are stood in for here. A canvas whose data
// URL spells out the pixels put into it is what carries the payload's bytes through to the
// assertions, so one string says which texel became which pixel.
interface FakeImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
(globalThis as Record<string, unknown>).ImageData =
  function (data: Uint8ClampedArray, width: number, height: number): FakeImage {
    return { data, width, height };
  };
(globalThis as Record<string, unknown>).document = {
  createElement: () => {
    let image: FakeImage | null = null;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ putImageData: (img: FakeImage) => { image = img; } }),
      toDataURL: () =>
        `${canvas.width}x${canvas.height}:${image ? [...(image as FakeImage).data].join(",") : ""}`,
    };
    return canvas;
  },
};

const { gridAt } = await import("./grid.ts");
const { default: heatmap } = await import("./index.ts");

/** A layer as the fake collection makes one: the provider it draws, and nothing else. */
interface FakeLayer {
  provider: { url: string; rectangle: unknown };
}

/** An encoded u8 array as the codec decodes one. */
const nd = (data: number[], ...shape: number[]) =>
  ({ data: Uint8Array.from(data), shape });

// Asymmetric in both axes: three rows north to south, two columns west to east, and every texel a
// different red. Row 0 column 0 is the north-west texel and must arrive as the image's first pixel.
const GRID = [10, 0, 0, 255, 20, 0, 0, 255,
              30, 0, 0, 255, 40, 0, 0, 255,
              50, 0, 0, 255, 60, 0, 0, 255];
const EXTENT = [-10, 40, 10, 50];

/** A viewer the module can be set up against, driving the two things it listens to. */
function fakeViewer() {
  const windows: ((w: WindowInfo, payload: unknown) => void)[] = [];
  const keyframe: ((index: number) => void)[] = [];
  const covers = new Map<number, WindowInfo>();
  // The collection already carries the globe's own imagery, which this module never touches.
  const base = { provider: { url: "base", rectangle: null } } as FakeLayer;
  const stack: FakeLayer[] = [base];
  const ctx = {
    frame: null as { index: number; alpha: number } | null,
    Cesium: {
      Rectangle: { fromDegrees: (west: number, south: number, east: number, north: number) =>
        ({ west, south, east, north }) },
      SingleTileImageryProvider: {
        fromUrl: async (url: string, opts: { rectangle: unknown }) =>
          ({ url, rectangle: opts.rectangle }),
      },
    },
    scene: {
      imageryLayers: {
        addImageryProvider: (provider: FakeLayer["provider"]) => {
          const layer = { provider };
          stack.push(layer);
          return layer;
        },
        remove: (layer: FakeLayer) => {
          const i = stack.indexOf(layer);
          if (i >= 0) stack.splice(i, 1);
          return i >= 0;
        },
      },
    },
    onWindow(cb: (w: WindowInfo, payload: unknown) => void) {
      windows.push(cb);
      return () => {};
    },
    onKeyframe(cb: (index: number) => void) {
      keyframe.push(cb);
      return () => {};
    },
    placement: (index: number) => {
      const w = covers.get(index);
      return w ? { window: w, k: index - w.startFrame } : null;
    },
    perWindow: <T>() => new Timeline<T>(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teardown = heatmap.setup(ctx as any);
  return {
    ctx,
    teardown,
    base,
    stack,
    deliver: (payload: unknown, w: Partial<WindowInfo> & { startFrame: number; count: number }) => {
      const info = { mode: "replace", ...w } as WindowInfo;
      if (info.mode === "replace") covers.clear();
      for (let k = 0; k < info.count; k++) covers.set(info.startFrame + k, info);
      windows.forEach((cb) => cb(info, payload));
      // The Core's own guarantee, modelled: a replace re-indexes, so it fires a crossing at the
      // index the clock is on. An append changes nothing on screen and fires none.
      if (info.mode === "replace") {
        const i = ctx.frame?.index ?? info.startFrame;
        keyframe.forEach((cb) => cb(i));
      }
    },
    crossInto: (index: number) => keyframe.forEach((cb) => cb(index)),
  };
}

// A draw builds its image asynchronously, so a test reads the stack after the microtasks it queued.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a grid is read north-first, and a keyframe reads its own block", () => {
  const one = gridAt(nd(GRID, 3, 2, 4), 0, 3)!;
  assert.equal(one.width, 2);
  assert.equal(one.height, 3);
  assert.deepEqual([...one.rgba.subarray(0, 4)], [10, 0, 0, 255],
                   "the north-west texel is the first four bytes, and nothing flips a row");
  assert.deepEqual([...one.rgba], GRID);
  assert.deepEqual([...gridAt(nd(GRID, 3, 2, 4), 2, 3)!.rgba], GRID,
                   "one grid for the whole window is read by every keyframe");

  // Two keyframes of a 1 × 2 grid, the keyframe leading.
  const perFrame = nd([1, 1, 1, 255, 2, 2, 2, 255,
                       3, 3, 3, 255, 4, 4, 4, 255], 2, 1, 2, 4);
  assert.deepEqual([...gridAt(perFrame, 0, 2)!.rgba], [1, 1, 1, 255, 2, 2, 2, 255]);
  assert.deepEqual([...gridAt(perFrame, 1, 2)!.rgba], [3, 3, 3, 255, 4, 4, 4, 255]);
  assert.equal(gridAt(perFrame, 1, 2)!.height, 1, "the keyframe axis is not a row");

  assert.throws(() => gridAt(nd(GRID, 6, 4), 0, 3), /\[H, W, 4\]/);
  assert.throws(() => gridAt(nd(GRID, 3, 3, 4), 0, 3), /36 bytes/);
  assert.equal(gridAt(perFrame, 2, 2), null, "a keyframe outside the window draws nothing");
  assert.throws(() => gridAt(perFrame, 0, 3), /2 keyframes.*carries 3/,
                "a keyframe axis the window disagrees with is refused");
});

test("a window drapes each raster over the extent it declares, in the order it declares them", async () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 0, alpha: 0 };
  v.deliver({ heatmaps: [{ kind: "coverage", extent: EXTENT, rgba: nd(GRID, 3, 2, 4) },
                         { kind: "rain", extent: EXTENT, rgba: nd(GRID, 3, 2, 4) }] },
            { startFrame: 0, count: 3 });
  await settled();

  assert.equal(v.stack.length, 3, "two layers over the base imagery");
  assert.equal(v.stack[0], v.base, "and under nothing of the module's own");
  assert.equal(v.stack[1].provider.url, `2x3:${GRID.join(",")}`,
               "the grid's own bytes, the north-west texel first");
  assert.deepEqual(v.stack[1].provider.rectangle,
                   { west: -10, south: 40, east: 10, north: 50 });

  v.teardown();
});

test("a crossing swaps the image, and a window naming a kind again replaces its layer", async () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 0, alpha: 0 };
  // One grid per keyframe: two keyframes of a single texel.
  const perFrame = nd([7, 0, 0, 255, 9, 0, 0, 255], 2, 1, 1, 4);
  v.deliver({ heatmaps: [{ kind: "coverage", extent: EXTENT, rgba: perFrame }] },
            { startFrame: 0, count: 2 });
  await settled();
  assert.equal(v.stack.length, 2);
  assert.equal(v.stack[1].provider.url, "1x1:7,0,0,255");

  v.crossInto(1);
  await settled();
  assert.equal(v.stack.length, 2, "the crossing swapped the layer rather than stacking a second");
  assert.equal(v.stack[1].provider.url, "1x1:9,0,0,255");

  // A keyframe no window covers leaves on screen what was last drawn.
  v.crossInto(9);
  await settled();
  assert.equal(v.stack.length, 2);
  assert.equal(v.stack[1].provider.url, "1x1:9,0,0,255");

  // A later window naming the same kind replaces that raster; it does not add a second one.
  v.deliver({ heatmaps: [{ kind: "coverage", extent: EXTENT, rgba: nd([1, 2, 3, 4], 1, 1, 4) }] },
            { startFrame: 0, count: 1 });
  await settled();
  assert.equal(v.stack.length, 2);
  assert.equal(v.stack[1].provider.url, "1x1:1,2,3,4");

  // A window that names no raster takes this module's layers off, and only its own.
  v.deliver({ heatmaps: [] }, { startFrame: 0, count: 1 });
  await settled();
  assert.deepEqual(v.stack, [v.base]);

  v.teardown();
});

test("dispose removes exactly the layers the module added", async () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 0, alpha: 0 };
  v.deliver({ heatmaps: [{ kind: "coverage", extent: EXTENT, rgba: nd(GRID, 3, 2, 4) }] },
            { startFrame: 0, count: 1 });
  await settled();
  assert.equal(v.stack.length, 2);

  v.teardown();
  assert.deepEqual(v.stack, [v.base], "the base imagery is not this module's to take down");

  // An image still resolving when the module left never reaches the scene it has gone from.
  v.crossInto(0);
  await settled();
  assert.deepEqual(v.stack, [v.base]);
});
