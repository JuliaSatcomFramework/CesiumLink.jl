// Bytes to an image, and nothing else. This file knows the shape a grid arrives in and how a canvas
// is filled from it; it does not know where the bytes came from. That separation is the point: the
// bytes reach this module in a window today, and a tiled provider that fetches its own would reuse
// every line here unchanged.
//
// A grid arrives north-first — row 0 is the north edge, column 0 the west edge, four bytes per texel
// as R, G, B, A. That is exactly what a canvas wants, so nothing here flips a row. Do not add a
// flip. It looks right on a field symmetric in latitude and is wrong on every other one.

import { blockAt, type NdArray } from "../../core/src/codec.ts";

/** One keyframe of a grid, ready to become an image. */
export interface Grid {
  width: number;
  height: number;
  /** `height × width × 4` bytes, row-major from the north-west texel. */
  rgba: Uint8Array;
}

/**
 * The grid that keyframe `k` of a window of `count` keyframes draws, or null where the payload says
 * nothing about `k`.
 *
 * The base rank of a grid is 3, `[H, W, 4]`: one grid for the whole window, which every keyframe
 * reads. A rank-4 grid is `[K, H, W, 4]`, one grid per keyframe. The returned bytes are a view on the
 * payload, so nothing is copied.
 */
export function gridAt(a: NdArray, k: number, count: number): Grid | null {
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

/** The grid drawn into a canvas of its own size, one texel per pixel. */
export function toCanvas(g: Grid): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("a 2d canvas context was refused");
  // `ImageData` needs the clamped view of the same bytes, which costs one copy of the grid — small
  // beside the encode that follows it.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(g.rgba), g.width, g.height), 0, 0);
  return canvas;
}
