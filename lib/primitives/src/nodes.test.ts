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

class FakeCartesian2 {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

class FakeNearFar {
  near: number;
  nearValue: number;
  far: number;
  farValue: number;
  constructor(near: number, nearValue: number, far: number, farValue: number) {
    this.near = near;
    this.nearValue = nearValue;
    this.far = far;
    this.farValue = farValue;
  }
}

class FakeRange {
  near: number;
  far: number;
  constructor(near: number, far: number) {
    this.near = near;
    this.far = far;
  }
}

// Cesium clones every colour it is handed, so the fake hands back a fresh value the way a clone
// does: one scratch reused across a family must still give each label its own colour.
class FakeColor {
  static readonly BLACK = "BLACK";
  static fromBytes(r: number, g: number, b: number, a: number) {
    return [r, g, b, a];
  }
}

const C = {
  Cartesian2: FakeCartesian2,
  Cartesian3: FakeCartesian3,
  Color: FakeColor,
  NearFarScalar: FakeNearFar,
  DistanceDisplayCondition: FakeRange,
  LabelStyle: { FILL_AND_OUTLINE: "FILL_AND_OUTLINE" },
  HorizontalOrigin: { LEFT: "LEFT", CENTER: "CENTER", RIGHT: "RIGHT" },
  VerticalOrigin: { TOP: "TOP", CENTER: "CENTER", BOTTOM: "BOTTOM", BASELINE: "BASELINE" },
  BillboardCollection: FakeCollection,
  LabelCollection: FakeCollection,
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

/** The labels two entities are built with, for whatever `label` the case supplies. */
function labelsOf(label: NodeSpec["label"]): Record<string, unknown>[] {
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
    label,
  };
  family.onWindow(spec, window());
  // The billboards are added first, the labels second.
  return added[1].items;
}

test("a plain array of texts draws the default look", () => {
  const [first, second] = labelsOf(["one", "two"]);
  assert.equal(first.text, "one");
  assert.equal(second.text, "two");
  assert.equal(first.font, "13px sans-serif");
  assert.deepEqual(first.pixelOffset, new FakeCartesian2(0, -14));
  assert.equal(first.horizontalOrigin, "LEFT");
  assert.equal(first.verticalOrigin, "BOTTOM");
  assert.deepEqual(first.fillColor, [255, 255, 255, 255]);
  assert.equal(first.showBackground, false);
  assert.equal(first.scaleByDistance, undefined);
  assert.equal(first.distanceDisplayCondition, undefined);
});

test("a style says how the whole family's labels are drawn", () => {
  const [first, second] = labelsOf({
    text: ["one", "two"],
    align: ["center", "top"],
    offset: [4, 8],
    font: "20px serif",
    color: { data: Uint8Array.from([10, 20, 30, 40]), shape: [4] },
    background: { data: Uint8Array.from([1, 2, 3, 4]), shape: [4] },
    scaleByDistance: [1e5, 2, 1e7, 0.5],
    fadeByDistance: [1e5, 1, 1e7, 0],
    showBetween: [0, 1e7],
  });
  assert.equal(first.text, "one");
  assert.equal(second.text, "two");
  assert.equal(first.font, "20px serif");
  assert.deepEqual(first.pixelOffset, new FakeCartesian2(4, 8));
  assert.equal(first.horizontalOrigin, "CENTER");
  assert.equal(first.verticalOrigin, "TOP");
  assert.deepEqual(first.fillColor, [10, 20, 30, 40]);
  assert.equal(first.showBackground, true);
  assert.deepEqual(first.backgroundColor, [1, 2, 3, 4]);
  assert.deepEqual(first.scaleByDistance, new FakeNearFar(1e5, 2, 1e7, 0.5));
  assert.deepEqual(first.translucencyByDistance, new FakeNearFar(1e5, 1, 1e7, 0));
  assert.deepEqual(first.distanceDisplayCondition, new FakeRange(0, 1e7));
  // The style covers the family, so the second label is drawn exactly as the first.
  assert.deepEqual(second.fillColor, first.fillColor);
});

test("one colour per entity varies the text colour across the family", () => {
  const [first, second] = labelsOf({
    text: ["one", "two"],
    color: { data: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]), shape: [2, 4] },
  });
  assert.deepEqual(first.fillColor, [10, 20, 30, 40]);
  assert.deepEqual(second.fillColor, [50, 60, 70, 80]);
});
