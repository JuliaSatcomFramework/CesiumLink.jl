import test from "node:test";
import assert from "node:assert/strict";
import { clearEdgeMaterials, defineEdgeMaterial, EdgeFamily, type EdgeSpec } from "./edges.ts";
import type { NodeFamily } from "./nodes.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

/** The store the Core hands a family; each family gets its own. */

// EdgeFamily reaches Cesium only through the namespace it is handed, so the batching rules — one
// material per appearance, and an attribute write where a rebuild is not needed — are testable
// without WebGL. These stubs implement exactly what it touches.

class FakePolyline {
  positions: unknown;
  width = 1;
  show = true;
  material: FakeMaterial | undefined;
  _material: FakeMaterial | undefined;
  id: unknown;
  constructor(opts: Record<string, unknown>) {
    Object.assign(this, opts);
    this._material = this.material;
  }
}

class FakeMaterial {
  destroyed = false;
  type: string;
  /** What the family asked the material to carry, which is where an image URL lands. */
  uniforms: Record<string, unknown>;
  constructor(type: string, uniforms: Record<string, unknown> = {}) {
    this.type = type;
    this.uniforms = uniforms;
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakePolylineCollection {
  readonly lines: FakePolyline[] = [];
  /** Every line ever added, so a test can tell a rebuild from an attribute write. */
  adds = 0;
  get length() {
    return this.lines.length;
  }
  add(opts: Record<string, unknown>) {
    this.adds++;
    const line = new FakePolyline(opts);
    this.lines.push(line);
    return line;
  }
  get(i: number) {
    return this.lines[i];
  }
  removeAll() {
    for (const line of this.lines) line._material?.destroy();
    this.lines.length = 0;
  }
}

const made: FakeMaterial[] = [];
const C = {
  PolylineCollection: FakePolylineCollection,
  Color: { fromBytes: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
  Material: {
    fromType: (type: string, uniforms: Record<string, unknown>) => {
      const m = new FakeMaterial(type, uniforms);
      made.push(m);
      return m;
    },
  },
} as unknown as typeof import("@cesium/engine");

// Records what a family adds, which is how a test gets hold of the collection it built.
const added: FakePolylineCollection[] = [];
const scene = {
  primitives: {
    add: (p: FakePolylineCollection) => (added.push(p), p),
    remove: () => true,
  },
} as unknown as import("@cesium/engine").Scene;

/** A node family of `n` entities standing still, which is all an edge reads of one. */
const stubNodes = (n: number): NodeFamily =>
  ({ positions: Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 })), moving: false }) as
    unknown as NodeFamily;

const window = (count: number, mode: "replace" | "append" = "replace"): WindowInfo =>
  ({ startFrame: 0, count, id: 1, mode, totalFrames: 10, dtSeconds: 60, epoch: null as never });

/** A host that serves every asset path, which is what a browser page is. */
const served = (path: string) => `https://host/${path}`;

const nd = (data: number[], shape: number[]) => ({ data: Uint32Array.from(data), shape });
const bytes = (data: number[], shape: number[]) => ({ data: Uint8Array.from(data), shape });

function build(spec: Omit<EdgeSpec, "kind" | "from" | "to">, count: number) {
  made.length = 0;
  added.length = 0;
  const nodes = stubNodes(4);
  const family = new EdgeFamily("link", C, scene, () => nodes,
                                (kind, idx) => ({ kind, idx }), served, new Timeline());
  const win = window(count);
  family.onWindow({ kind: "link", from: "a", to: "b", ...spec }, win);
  // What the Core answers for an absolute keyframe: this window, and the offset within it.
  const at = (index: number) => ({ window: win, k: index - win.startFrame });
  return { family, pl: added[0], at };
}

// Six edges in two appearances: two stock styles, one colour.
const SIX = nd([0, 1, 1, 2, 2, 3, 3, 0, 0, 2, 1, 3], [6, 2]);

test("a family of many edges in a few appearances shares one material per appearance", () => {
  const { family, pl, at } = build(
    { pairs: SIX, style: bytes([0, 2, 0, 2, 0, 2], [6]), width: { data: Float32Array.from([1, 2.5, 1, 2.5, 1, 2.5]), shape: [6] } },
    1,
  );
  family.onKeyframe(at(0));
  assert.equal(pl.length, 6);
  const materials = new Set(pl.lines.map((l) => l.material));
  assert.equal(materials.size, 2, "one material per appearance, never one per line");
  // Lines of one appearance are consecutive, which is what makes them one draw command.
  const types = pl.lines.map((l) => l.material!.type);
  assert.deepEqual(types, [...types].sort(), "appearances are not interleaved");
  // Width rides the batch table, so mixing widths inside one appearance splits nothing.
  assert.deepEqual([...new Set(pl.lines.map((l) => l.width))].sort(), [1, 2.5]);
});

test("a keyframed mask hides an edge by attribute write, without rebuilding the collection", () => {
  // Constant connectivity and appearance; only the mask switches.
  const { family, pl, at } = build(
    { pairs: SIX, show: bytes([1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0], [2, 6]) },
    2,
  );
  family.onKeyframe(at(0));
  assert.deepEqual(pl.lines.map((l) => l.show), [true, true, true, true, true, true]);
  const addsAfterBuild = pl.adds;
  const lines = [...pl.lines];

  family.onKeyframe(at(1));
  assert.deepEqual(pl.lines.map((l) => l.show), [true, false, true, false, true, false]);
  assert.equal(pl.adds, addsAfterBuild, "hiding an edge rebuilt the collection");
  assert.deepEqual([...pl.lines], lines, "the same polylines stand");
});

test("a keyframed width is written onto the lines that stand", () => {
  const { family, pl, at } = build(
    { pairs: SIX, width: { data: Float32Array.from([1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3]), shape: [2, 6] } },
    2,
  );
  family.onKeyframe(at(0));
  const addsAfterBuild = pl.adds;
  family.onKeyframe(at(1));
  assert.deepEqual(pl.lines.map((l) => l.width), [3, 3, 3, 3, 3, 3]);
  assert.equal(pl.adds, addsAfterBuild);
});

test("a keyframed colour rebuilds, and drops the materials no line uses any more", () => {
  const { family, pl, at } = build(
    { pairs: SIX, color: bytes([...Array(24).fill(255), ...Array(24).fill(10)], [2, 6, 4]) },
    2,
  );
  family.onKeyframe(at(0));
  const first = pl.lines[0].material!;
  family.onKeyframe(at(1));
  const second = pl.lines[0].material!;
  assert.notEqual(first, second, "the new colour needs its own material");
  assert.equal(first.destroyed, true, "the material nothing uses any more was freed");
  // One colour across the whole family at either keyframe, so one live material at a time.
  assert.equal(made.filter((m) => !m.destroyed).length, 1);
});

/** Run `f` with `console.warn` captured, and answer what it wrote. */
function warnings(f: () => void): string[] {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => said.push(m);
  try {
    f();
  } finally {
    console.warn = warn;
  }
  return said;
}

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

test("a style table names the material of a code beyond the stock three", () => {
  defineEdgeMaterial("orbits.pulse", (_C, look) =>
    new FakeMaterial("Pulse", { color: look.color, dashLength: look.dashLength }) as unknown as
      import("@cesium/engine").Material);

  // One edge per form: solid, a `data:` URI, an asset path, a registered name, and a name nobody
  // answers for. The three leading nulls keep the stock codes where they are.
  const { family, pl, at } = build(
    {
      pairs: nd([0, 1, 1, 2, 2, 3, 3, 0, 0, 2], [5, 2]),
      style: bytes([0, 3, 4, 5, 6], [5]),
      styles: [null, null, null, PIXEL, "assets/lines/pulse.png", "orbits.pulse", "orbits.absent"],
      dashLength: 8,
    },
    1,
  );
  const said = warnings(() => family.onKeyframe(at(0)));

  const types = pl.lines.map((l) => l.material!.type);
  assert.deepEqual(types, ["Color", "Image", "Image", "Pulse", "Color"],
                   "each form built its own material, and the unanswered name fell back to solid");
  assert.equal(pl.lines[1].material!.uniforms.image, PIXEL, "a data URI goes to Cesium as it stands");
  assert.equal(pl.lines[2].material!.uniforms.image, "https://host/assets/lines/pulse.png",
               "an asset path went through the host's resolver");
  assert.equal(pl.lines[3].material!.uniforms.dashLength, 8, "the factory gets the family's dash period");
  assert.equal(said.length, 1);
  assert.match(said[0], /no edge material named "orbits.absent" is registered/);

  clearEdgeMaterials();
});

test("a family that names no custom material builds exactly the stock materials", () => {
  const { family, pl, at } = build({ pairs: SIX, style: bytes([0, 1, 2, 0, 1, 2], [6]) }, 1);
  family.onKeyframe(at(0));
  assert.deepEqual(new Set(pl.lines.map((l) => l.material!.type)),
                   new Set(["Color", "PolylineDash", "PolylineGlow"]));
  assert.equal(made.length, 3, "three appearances, three materials, table or no table");
});
