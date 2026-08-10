import test from "node:test";
import assert from "node:assert/strict";
import { at, knob, type Knob } from "./knobs.ts";

// Four entities, three keyframes — enough that a per-entity array and a per-keyframe one differ in
// length, so a form mistaken for the other cannot pass.
const SHAPE = { n: 4, count: 3 };

const nd = (data: number[], shape: number[]) => ({ data: Float32Array.from(data), shape });
const bytes = (data: number[], shape: number[]) => ({ data: Uint8Array.from(data), shape });

/** Component `j` of entity `i` at window-relative keyframe `k`, as a reader reads it. */
const read = (kn: Knob, i: number, k: number, j = 0) => at(kn.frame(k)!, i, j);

test("a scalar covers the whole family, at every entity and every keyframe", () => {
  const kn = knob(9, { ...SHAPE, itemLen: 1, what: "size" })!;
  assert.equal(kn.keyframed, false);
  assert.equal(read(kn, 0, 0), 9);
  assert.equal(read(kn, 3, 2), 9);
});

test("a single vector covers the whole family", () => {
  const kn = knob(bytes([60, 190, 255, 255], [4]), { ...SHAPE, itemLen: 4, what: "color" })!;
  assert.equal(kn.keyframed, false);
  assert.deepEqual([0, 1, 2, 3].map((j) => read(kn, 2, 1, j)), [60, 190, 255, 255]);
});

test("an array of one value per entity holds for the whole window", () => {
  const kn = knob(nd([1, 2, 3, 4], [4]), { ...SHAPE, itemLen: 1, what: "size" })!;
  assert.equal(kn.keyframed, false);
  assert.deepEqual([0, 1, 2, 3].map((i) => read(kn, i, 0)), [1, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3].map((i) => read(kn, i, 2)), [1, 2, 3, 4]);
});

test("an array of one vector per entity holds for the whole window", () => {
  // Julia `3 x 4`, so row-major [4, 3].
  const kn = knob(nd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [4, 3]),
                  { ...SHAPE, itemLen: 3, what: "position" })!;
  assert.equal(kn.keyframed, false);
  assert.deepEqual([0, 1, 2].map((j) => read(kn, 1, 0, j)), [4, 5, 6]);
  assert.deepEqual([0, 1, 2].map((j) => read(kn, 3, 2, j)), [10, 11, 12]);
});

test("a trailing keyframe dimension makes the knob switch at each crossing", () => {
  // Julia `4 x 3` (entity x keyframe), so row-major [3, 4]: one contiguous block per keyframe.
  const kn = knob(nd([1, 2, 3, 4, 10, 20, 30, 40, 100, 200, 300, 400], [3, 4]),
                  { ...SHAPE, itemLen: 1, what: "size" })!;
  assert.equal(kn.keyframed, true);
  assert.deepEqual([0, 1, 2, 3].map((i) => read(kn, i, 0)), [1, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3].map((i) => read(kn, i, 2)), [100, 200, 300, 400]);
});

test("a keyframed vector knob picks the keyframe's block, then the entity", () => {
  // Julia `3 x 4 x 3`, so row-major [3, 4, 3].
  const data = Array.from({ length: 36 }, (_, i) => i);
  const kn = knob(nd(data, [3, 4, 3]), { ...SHAPE, itemLen: 3, what: "position" })!;
  assert.equal(kn.keyframed, true);
  assert.deepEqual([0, 1, 2].map((j) => read(kn, 0, 0, j)), [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((j) => read(kn, 2, 1, j)), [18, 19, 20]);
});

test("one array per keyframe carries a membership that changes size", () => {
  // What an edge family sends when its connectivity changes: 2, then 1, then 3 pairs.
  const kn = knob([nd([0, 1, 2, 3], [2, 2]), nd([1, 0], [1, 2]), nd([0, 0, 1, 1, 2, 2], [3, 2])],
                  { itemLen: 2, count: 3, what: "pairs" })!;
  assert.equal(kn.keyframed, true);
  assert.equal(kn.frame(0)!.length, 2);
  assert.equal(kn.frame(1)!.length, 1);
  assert.deepEqual([0, 1].map((j) => at(kn.frame(2)!, 2, j)), [2, 2]);
});

test("a keyframed knob says nothing about a keyframe outside the window", () => {
  const kn = knob(nd([1, 2, 3, 4, 10, 20, 30, 40, 100, 200, 300, 400], [3, 4]),
                  { ...SHAPE, itemLen: 1, what: "size" })!;
  assert.equal(kn.frame(-1), null);
  assert.equal(kn.frame(3), null);
});

test("a keyframe axis the window disagrees with is refused, naming the knob", () => {
  // Two keyframes of four entities, delivered in a window that carries three.
  assert.throws(() => knob(nd([1, 2, 3, 4, 10, 20, 30, 40], [2, 4]),
                           { ...SHAPE, itemLen: 1, what: "size" }),
                /size.*2 keyframes.*carries 3/);
});

test("an absent knob is absent, not a default", () => {
  assert.equal(knob(undefined, { ...SHAPE, itemLen: 1, what: "size" }), null);
  assert.equal(knob(null, { ...SHAPE, itemLen: 4, what: "color" }), null);
});

test("a shape matching none of the forms names the knob it came from", () => {
  assert.throws(() => knob(nd([1, 2, 3], [3]), { ...SHAPE, itemLen: 1, what: "size" }), /size/);
  assert.throws(() => knob(nd(Array(24).fill(0), [2, 4, 3]), { ...SHAPE, itemLen: 3, what: "position" }),
                /position/);
  assert.throws(() => knob("big", { ...SHAPE, itemLen: 1, what: "size" }), /size/);
  assert.throws(() => knob([nd([0, 1], [1, 2])], { itemLen: 2, count: 3, what: "pairs" }),
                /pairs has 1 keyframes/);
});

test("the error names the module the knob belongs to", () => {
  const bad = nd([1, 2, 3], [3]);
  assert.throws(() => knob(bad, { ...SHAPE, itemLen: 1, what: "size" }), /^Error: primitives: size/);
  assert.throws(() => knob(bad, { ...SHAPE, itemLen: 1, what: "sat.show", module: "models" }),
                /^Error: models: sat\.show/);
});
