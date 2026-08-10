import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeArrays, type NdArray } from "./codec.ts";
import { splitFrame } from "./transport.ts";

// The cross-language pin. Julia only builds frames and this side only reads them, so neither can
// round-trip against itself and nothing in either suite would catch the two drifting apart.
// `tools/golden-frame.jl` writes this file and `test/golden_frame_tests.jl`
// asserts the bytes it produces. Regenerate it deliberately, and only when the format changes.
const PATH = new URL("../../../tools/baseline/golden-frame.bin", import.meta.url);

function golden() {
  const bytes = readFileSync(PATH);
  const frame = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { header, region } = splitFrame(frame as ArrayBuffer);
  const msg = JSON.parse(header) as {
    method: string;
    params: { commands: { module: string; topic: string; payload: unknown }[] };
  };
  return { msg, region };
}

test("the golden frame splits into a readable header and a region", () => {
  const { msg, region } = golden();
  assert.equal(msg.method, "commands");
  assert.equal(msg.params.commands.length, 1);
  assert.equal(msg.params.commands[0].module, "golden");
  assert.equal(region.byteLength, 88);
  // The region starts on a multiple of 8, so a Float64Array view over any array in it is legal.
  assert.equal(region.byteOffset % 8, 0);
});

test("every array in the golden frame decodes to its values, dtype and shape", () => {
  const { msg, region } = golden();
  const p = decodeArrays(msg.params.commands[0].payload, region) as Record<string, NdArray> & {
    label: string;
    nested: { count: number; kind: string; ids: NdArray };
  };

  assert.deepEqual([...p.flags.data], [1, 2, 3]);
  assert.equal(p.flags.data.constructor, Uint8Array);
  assert.deepEqual([...p.scale.data], [1.5, -2.5]);
  assert.equal(p.scale.data.constructor, Float64Array);
  assert.deepEqual([...p.one.data], [7]);
  assert.deepEqual([...p.speed.data], [1, 2, 3]);
  assert.equal(p.speed.data.constructor, Float32Array);
  assert.deepEqual([...p.depth.data], [9.25]);

  // Row-major on the wire, the reverse of the Julia `Int32[1 3 5; 2 4 6]` it came from, and the
  // flat byte order is the same on both sides.
  assert.deepEqual(p.grid.shape, [3, 2]);
  assert.deepEqual([...p.grid.data], [1, 2, 3, 4, 5, 6]);
  assert.equal(p.grid.data.constructor, Int32Array);

  // A flat array states its shape too, and a plain value keeps travelling in the header.
  assert.deepEqual(p.one.shape, [1]);
  assert.equal(p.label, "north");
  assert.equal(p.nested.count, 3);
  assert.deepEqual([...p.nested.ids.data], [10, 20]);
});

test("the golden frame's offsets are padded to 8, whatever the dtype", () => {
  const { msg } = golden();
  const p = msg.params.commands[0].payload as Record<string, { off: number }>;
  // A frame of same-dtype arrays exercises no padding at all — every offset lands 8-aligned by
  // luck and the test still looks green. This payload needs a pad of 5, then 7, then 4.
  assert.deepEqual(
    ["flags", "scale", "one", "speed", "depth", "grid"].map((k) => p[k].off),
    [0, 8, 24, 32, 48, 56],
  );
  assert.equal((p.nested as unknown as { ids: { off: number } }).ids.off, 80);
});
