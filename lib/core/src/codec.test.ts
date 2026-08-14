import test from "node:test";
import assert from "node:assert/strict";
import { blockAt, decodeArrays, numbers, type NdArray } from "./codec.ts";

// A region holding a Julia `Float32[1 3 5; 2 4 6]` (2x3, column-major), whose row-major shape
// [3, 2] describes the same buffer.
const MAT = new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6]).buffer);

test("decodes an encoded array to a typed array and its shape", () => {
  const got = decodeArrays({ $wire: "f32", shape: [3, 2], off: 0 }, MAT) as NdArray;
  assert.deepEqual(got.shape, [3, 2]);
  assert.ok(got.data instanceof Float32Array);
  assert.deepEqual([...got.data], [1, 2, 3, 4, 5, 6]);
});

test("an array is a view into the region, not a copy of it", () => {
  const region = new Uint8Array(MAT);
  const got = decodeArrays({ $wire: "f32", shape: [6], off: 0 }, region) as NdArray;
  assert.equal(got.data.buffer, region.buffer);
  new DataView(region.buffer).setFloat32(0, 99, true);
  assert.equal(got.data[0], 99);
  // Detaching a copy is what a module keeping a slice past its window does.
  const copy = new Float32Array(got.data);
  new DataView(region.buffer).setFloat32(0, 1, true);
  assert.equal(copy[0], 99);
});

test("finds arrays at any nesting depth, leaving everything else alone", () => {
  const got = decodeArrays(
    {
      frames: [{ pos: { $wire: "f32", shape: [6], off: 0 }, label: "sat 1", n: 3 }],
      flags: [true, null],
    },
    MAT,
  ) as { frames: { pos: NdArray; label: string; n: number }[]; flags: unknown[] };
  assert.deepEqual([...got.frames[0].pos.data], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(got.frames[0].pos.shape, [6]);
  assert.equal(got.frames[0].label, "sat 1");
  assert.equal(got.frames[0].n, 3);
  assert.deepEqual(got.flags, [true, null]);
});

test("leaves objects that merely look like the marker untouched", () => {
  for (const lookalike of [
    { $wire: "not-a-dtype", shape: [6], off: 0 },
    { $wire: "f32", shape: [6] }, // no offset
    { $wire: "f32", off: 0 }, // no shape
    { $wire: 32, shape: [6], off: 0 },
    { shape: [3, 2], off: 0 }, // no marker
  ]) {
    assert.deepEqual(decodeArrays(lookalike, MAT), lookalike);
  }
});

test("reads every dtype out of one region, at the offset each names", () => {
  const region = new Uint8Array(48);
  const dv = new DataView(region.buffer);
  dv.setFloat64(0, -2.5, true);
  dv.setUint8(8, 255);
  dv.setUint32(16, 4_000_000_000, true);
  dv.setInt32(24, -2_000_000_000, true);
  dv.setFloat32(32, 1.5, true);
  const got = decodeArrays(
    {
      f64: { $wire: "f64", shape: [1], off: 0 },
      u8: { $wire: "u8", shape: [1], off: 8 },
      u32: { $wire: "u32", shape: [1], off: 16 },
      i32: { $wire: "i32", shape: [1], off: 24 },
      f32: { $wire: "f32", shape: [1], off: 32 },
    },
    region,
  ) as Record<string, NdArray>;
  assert.deepEqual([got.f64.data[0], got.u8.data[0], got.u32.data[0]], [-2.5, 255, 4_000_000_000]);
  assert.deepEqual([got.i32.data[0], got.f32.data[0]], [-2_000_000_000, 1.5]);
  assert.equal(got.f64.data.constructor, Float64Array);
  assert.equal(got.u8.data.constructor, Uint8Array);
});

test("empty arrays survive", () => {
  const got = decodeArrays({ $wire: "f32", shape: [0], off: 0 }, MAT) as NdArray;
  assert.equal(got.data.length, 0);
  assert.deepEqual(got.shape, [0]);
});

test("an array that runs past the region throws, naming both numbers", () => {
  // The length is derived from the shape, so this bound is the whole of what stands between a
  // malformed frame and a view over bytes that never arrived.
  assert.throws(() => decodeArrays({ $wire: "f32", shape: [7], off: 0 }, MAT), /28 bytes.*24/);
  assert.throws(() => decodeArrays({ $wire: "f32", shape: [1], off: 24 }, MAT), /offset 24/);
  assert.throws(() => decodeArrays({ $wire: "f32", shape: [1], off: -8 }, MAT), /offset -8/);
});

const nd = (values: number[], ...shape: number[]): NdArray =>
  ({ data: new Float32Array(values), shape });

test("an array at or below the base rank is the whole array at every keyframe", () => {
  const a = nd([1, 2, 3, 4, 5, 6], 3, 2);
  for (const k of [0, 4]) {
    assert.deepEqual(blockAt(a, k, 2, 5), { data: a.data, offset: 0, len: 6, keyframed: false });
  }
  // A rank below the base rank is the same answer: the form says nothing about keyframes.
  assert.deepEqual(blockAt(nd([7], 1), 3, 2, 5),
                   { data: new Float32Array([7]), offset: 0, len: 1, keyframed: false });
});

test("one rank above the base rank cuts the block keyframe k addresses", () => {
  const a = nd([1, 2, 3, 4, 5, 6], 3, 2);
  assert.deepEqual(blockAt(a, 0, 1, 3), { data: a.data, offset: 0, len: 2, keyframed: true });
  assert.deepEqual(blockAt(a, 2, 1, 3), { data: a.data, offset: 4, len: 2, keyframed: true });
});

test("a keyframe outside the window is null, and a leading axis that disagrees throws", () => {
  const a = nd([1, 2, 3, 4, 5, 6], 3, 2);
  assert.equal(blockAt(a, -1, 1, 3), null);
  assert.equal(blockAt(a, 3, 1, 3), null);
  assert.throws(() => blockAt(a, 0, 1, 5), /3 keyframes.*carries 5/);
});

test("a rank more than one above the base rank throws, naming the shape and the base rank", () => {
  assert.throws(() => blockAt(nd([1, 2, 3, 4, 5, 6], 3, 2, 1), 0, 0, 3), /\[3,2,1\].*base rank 0/);
});

test("a declared list of numbers reads the same whichever way it travelled", () => {
  assert.deepEqual(numbers([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(numbers(nd([1, 2, 3], 3)), [1, 2, 3]);
  assert.deepEqual(numbers(undefined), []);
});
