import test from "node:test";
import assert from "node:assert/strict";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";
import { NodeFamily, type NodeSpec } from "./nodes.ts";

// A billboard is born at the size it will be drawn at. Cesium rasterizes an SVG marker at the width
// and height the billboard carries when the image is assigned, and never again, so a placeholder
// size that the first keyframe corrects leaves a small texture stretched over a larger quad.

class FakeCartesian3 {
  x = 0;
  y = 0;
  z = 0;
}

class FakeCollection {
  readonly items: Record<string, unknown>[] = [];
  get length() {
    return this.items.length;
  }
  add(opts: Record<string, unknown>) {
    this.items.push({ ...opts });
    return this.items[this.items.length - 1];
  }
  get(i: number) {
    return this.items[i];
  }
  removeAll() {
    this.items.length = 0;
  }
}

const C = {
  Cartesian3: FakeCartesian3,
  Color: class {},
  BillboardCollection: FakeCollection,
} as unknown as typeof import("@cesium/engine");

const window = (): WindowInfo =>
  ({ startFrame: 0, count: 1, id: 1, mode: "replace", totalFrames: 1, dtSeconds: 60,
     epoch: null as never });

const SATELLITE = "data:image/svg+xml;base64,PHN2Zy8+";

/** Two entities at the origin, drawn with whatever `size` the case supplies. */
function widths(size: unknown): number[] {
  const added: FakeCollection[] = [];
  const scene = {
    primitives: { add: (p: FakeCollection) => (added.push(p), p), remove: () => true },
  } as unknown as import("@cesium/engine").Scene;
  const family = new NodeFamily("sat", C, scene, (kind, idx) => ({ kind, idx }), (p) => p,
                                new Timeline());
  const spec: NodeSpec = {
    kind: "sat",
    position: { data: Float64Array.from([0, 0, 0, 1, 1, 1]), shape: [2, 3] },
    marker: SATELLITE,
    size,
  };
  family.onWindow(spec, window());
  return added[0].items.map((b) => b.width as number);
}

test("a billboard is born at the size the window declares, not at a placeholder", () => {
  assert.deepEqual(widths(34), [34, 34], "one size covers the family");
  assert.deepEqual(widths({ data: Float64Array.from([20, 40]), shape: [2] }), [20, 40],
                   "and one per entity varies across it");
  // Height follows width, so an image is drawn square whatever its own shape.
  assert.deepEqual(widths(34), [34, 34]);
});

test("a window that declares no size falls back to the default", () => {
  assert.deepEqual(widths(undefined), [10, 10]);
});
