import test from "node:test";
import assert from "node:assert/strict";
import { windowCoverage } from "../../core/src/testing.ts";
import { Timeline, type WindowInfo } from "../../core/src/windows.ts";

// The module touches the DOM and nothing else — no Cesium — so a handful of stubs is the whole
// environment it needs. An element is its children, its style bag and the few properties a widget
// writes; a shadow root is an element that records what was mounted into it.
/** A style bag: named properties, written either wholesale as `cssText` or one at a time. */
function styleBag(): Record<string, string> & { setProperty(name: string, value: string): void } {
  const bag: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      bag[name] = value;
    },
  };
  let text = "";
  // Writing `cssText` drops every property already on the bag, as a real one does. A re-declaration
  // rewrites a box wholesale, so anything that must outlive it has to be written again after.
  Object.defineProperty(bag, "cssText", {
    get: () => text,
    set: (value: string) => {
      for (const name of Object.keys(bag)) if (name !== "setProperty") delete bag[name];
      text = value;
    },
  });
  return bag as Record<string, string> & { setProperty(name: string, value: string): void };
}

class FakeEl {
  style = styleBag();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent = "";
  innerHTML = "";
  value = "";
  type = "";
  checked = false;
  onchange: (() => void) | null = null;
  onclick: (() => void) | null = null;
  onpointerdown: ((e: FakePointer) => void) | null = null;
  onpointermove: ((e: FakePointer) => void) | null = null;
  onpointerup: ((e: FakePointer) => void) | null = null;
  /** The pointer this element holds, so a test sees a drag routed to the strip that started it. */
  captured: number | null = null;
  shadow: FakeEl | null = null;
  offsetWidth = 0;
  offsetHeight = 0;
  clientWidth = 800;
  clientHeight = 600;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  prepend(...cs: FakeEl[]): void {
    for (const c of cs.reverse()) { c.parent = this; this.children.unshift(c); }
  }
  replaceChildren(...cs: FakeEl[]): void {
    this.children = [];
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    const i = this.parent?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parent!.children.splice(i, 1);
    this.parent = null;
  }
  /** Take this element's place. A node lives in one place, so `other` leaves wherever it was. */
  replaceWith(other: FakeEl): void {
    other.remove();
    const i = this.parent?.children.indexOf(this) ?? -1;
    if (i >= 0) {
      this.parent!.children[i] = other;
      other.parent = this.parent;
    }
    this.parent = null;
  }
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !(name in this.attributes);
    if (on) this.attributes[name] = ""; else delete this.attributes[name];
    return on;
  }
  attachShadow(): FakeEl {
    return (this.shadow = new FakeEl("#shadow"));
  }
  setPointerCapture(id: number): void {
    this.captured = id;
  }
  releasePointerCapture(id: number): void {
    if (this.captured === id) this.captured = null;
  }
  /** The text of this element and everything under it, for asserting on rendered widgets. */
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join("");
  }
  /** Depth-first search for the first descendant of `tag`. */
  find(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (c.tag === tag) return c;
      const hit = c.find(tag);
      if (hit) return hit;
    }
    return null;
  }
}

/**
 * The fields of a pointer event the module reads, and the two calls it makes on one. `stopped`
 * records the second call: the fake DOM does not bubble, so a handler that must keep an event away
 * from the element under it can only be shown to ask for that.
 */
interface FakePointer {
  pointerId: number;
  clientX: number;
  clientY: number;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

const pointerAt = (x: number, y: number): FakePointer => {
  const e: FakePointer = { pointerId: 1, clientX: x, clientY: y, stopped: false,
                           preventDefault: () => {}, stopPropagation: () => { e.stopped = true; } };
  return e;
};

(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => new FakeEl(tag),
};

const { default: ui, defineWidget } = await import("./index.ts");
const { place } = await import("./tooltip.ts");

/**
 * A scene a float can be anchored into: one module owning two satellites, and just enough of the
 * Cesium namespace for the projection `ui` does. A world position projects to its own x/y, so what
 * a test asserts on is the placement rule rather than any transform.
 */
function fakeScene() {
  const positions: Record<string, { x: number; y: number; z: number } | undefined> = {
    "sat:0": { x: 100, y: 50, z: 0 },
    "sat:1": { x: 300, y: 200, z: 0 },
  };
  return {
    positions,
    modules: {
      get: (id: string) =>
        id === "primitives"
          ? { positionOf: (kind: string, idx: number) => positions[`${kind}:${idx}`] }
          // A module owning entities but exposing no `positionOf` cannot be anchored to.
          : id === "opaque" ? {} : undefined,
    },
    Cesium: {
      SceneTransforms: {
        worldToWindowCoordinates: (_scene: unknown, p: { x: number; y: number }) => p,
      },
      Cartesian3: { fromDegrees: (lon: number, lat: number, h: number) => ({ x: lon, y: lat, z: h }) },
    },
  };
}

/** A viewer the module can be set up against: records what it contributed and what it sent. */
function fakeViewer(scene = fakeScene()) {
  const container = new FakeEl("div");
  // The overlay's own DOM, so a contribution can be replaced in place the way the Core's region
  // host allows: one element per mounted row, in mount order, each remembering its region.
  const host = new FakeEl("#overlay");
  const regionOf = new Map<FakeEl, string>();
  const commands = new Map<string, (payload: unknown, seq: number | null) => void>();
  const windows: ((w: WindowInfo, payload: unknown) => void)[] = [];
  const keyframe: ((index: number) => void)[] = [];
  const frames: (() => void)[] = [];
  const pointer: ((e: { screen: { x: number; y: number } }) => void)[] = [];
  const sent: { topic: string; payload: unknown }[] = [];
  const covers = windowCoverage();
  const ctx = {
    container,
    frame: null as { index: number; alpha: number } | null,
    modules: scene.modules,
    Cesium: scene.Cesium,
    scene: {},
    overlay: {
      addControl(region: string, el: FakeEl) {
        regionOf.set(el, region);
        host.appendChild(el);
        return () => el.remove();
      },
    },
    onCommand(topic: string, cb: (payload: unknown, seq: number | null) => void) {
      commands.set(topic, cb);
      return () => commands.delete(topic);
    },
    onWindow(cb: (w: WindowInfo, payload: unknown) => void) {
      windows.push(cb);
      return () => {};
    },
    onKeyframe(cb: (index: number) => void) {
      keyframe.push(cb);
      return () => {};
    },
    onFrame(cb: () => void) {
      frames.push(cb);
      return () => {};
    },
    onPointer(cb: (e: { screen: { x: number; y: number } }) => void) {
      pointer.push(cb);
      return () => {};
    },
    notify(topic: string, payload: unknown) {
      sent.push({ topic, payload });
    },
    placement: covers.placement,
    perWindow: <T>() => new Timeline<T>(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teardown = ui.setup(ctx as any);
  return {
    ctx,
    scene,
    /** What the overlay is showing, in mount order. */
    get controls() {
      return host.children.map((el) => ({ region: regionOf.get(el)!, el }));
    },
    sent,
    teardown,
    declare: (list: unknown) => commands.get("declare")!(list, null),
    floating: (list: unknown) => commands.get("floating")!(list, null),
    /** The float boxes, which the module appends to the container itself, keyed by declared id. */
    floats: () => new Map(container.children.filter((c) => c.attributes["data-float"] != null)
                          .map((c) => [c.attributes["data-float"], c] as const)),
    /** One render tick, which is what re-projects an anchored float. */
    render: () => frames.forEach((cb) => cb()),
    /** Deliver one window's `ui` payload, covering `count` keyframes from absolute `startFrame`. */
    deliver: (payload: unknown, w: Partial<WindowInfo> & { startFrame: number; count: number }) => {
      const info = { mode: "replace", ...w } as WindowInfo;
      covers.deliver(info);
      windows.forEach((cb) => cb(info, payload));
      // The Core's own guarantee, modelled: a replace re-indexes, so it fires a crossing at the
      // index the clock is on. An append changes nothing on screen and fires none.
      if (info.mode === "replace") {
        const i = ctx.frame?.index ?? info.startFrame;
        keyframe.forEach((cb) => cb(i));
      }
    },
    tooltip: (payload: unknown) => commands.get("tooltip")!(payload, null),
    crossInto: (index: number) => keyframe.forEach((cb) => cb(index)),
    moveTo: (x: number, y: number) => pointer.forEach((cb) => cb({ screen: { x, y } })),
    /** The tooltip box, which the module appends to the container itself. */
    box: () => container.children.find((c) => c.attributes["data-ui"] === "tooltip") ?? null,
  };
}

const TITLE = { kind: "title", region: "top-center", text: "Visibility demo" };
const TOGGLE = { kind: "toggle", region: "bottom-right", id: "isl", label: "ISL links", value: true };

test("one declared list is the whole overlay, and re-declaring replaces it", () => {
  const v = fakeViewer();
  v.declare([TITLE, TOGGLE]);
  assert.deepEqual(v.controls.map((c) => c.region), ["top-center", "bottom-right"],
                   "each row is contributed to its own region, in declared order");
  assert.match(v.controls[0].el.text(), /Visibility demo/);

  // Declaring without the toggle removes it: the list is the overlay, not an addition to it.
  v.declare([TITLE]);
  assert.equal(v.controls.length, 1);
  assert.match(v.controls[0].el.text(), /Visibility demo/);

  v.teardown();
  assert.equal(v.controls.length, 0, "unloading drains what the overlay contributed");
});

test("a kind nobody registered skips that row, and the rest of the panel renders", () => {
  const v = fakeViewer();
  v.declare([TITLE, { kind: "orbits.shell-picker", region: "top-left" }, TOGGLE]);
  assert.equal(v.controls.length, 2, "the unknown row is skipped, the two known ones render");

  // A module registering the kind makes the same declaration render in full.
  defineWidget("orbits.shell-picker", (spec, report) => {
    const el = document.createElement("div");
    el.textContent = `shells:${spec.id}`;
    (el as unknown as FakeEl).onchange = () => report(7);
    return el;
  });
  v.declare([TITLE, { kind: "orbits.shell-picker", region: "top-left", id: "shell" }, TOGGLE]);
  assert.equal(v.controls.length, 3);
  assert.equal(v.controls[1].el.text(), "shells:shell");

  // A registered kind may report, and its report carries the row's own id.
  v.controls[1].el.onchange!();
  assert.deepEqual(v.sent.at(-1), { topic: "control", payload: { id: "shell", value: 7 } });
});

test("a title may be keyed by absolute keyframe, and follows the clock", () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 4, alpha: 0 };
  v.declare([{ kind: "title", region: "top-center", frames: { "4": "frame five", "6": "frame seven" } }]);
  const title = v.controls[0].el;
  assert.equal(title.text(), "frame five", "the frame the clock is already on, without a crossing");

  v.crossInto(6);
  assert.equal(title.text(), "frame seven");
  v.crossInto(7);
  assert.equal(title.text(), "frame seven", "a keyframe the declaration is silent about keeps it");
});

// A widget that names keyframed fields, and so may be addressed by a window's `per_keyframe`.
const READOUT = { kind: "title", region: "top-left", id: "load", text: "—", keyframed: ["text"] };

test("a keyframed field takes its value from the window on each crossing", () => {
  const v = fakeViewer();
  v.declare([READOUT, TOGGLE]);
  assert.equal(v.controls[0].el.text(), "—", "the declared value, until a window carries another");

  v.deliver({ per_keyframe: { load: { text: ["4.2 Gbps", "5.0 Gbps"] } } },
            { startFrame: 3, count: 3 });
  assert.equal(v.controls[0].el.text(), "4.2 Gbps",
               "the keyframe the clock is on, without waiting for a crossing");
  v.crossInto(4);
  assert.equal(v.controls[0].el.text(), "5.0 Gbps");
  v.crossInto(5);
  assert.equal(v.controls[0].el.text(), "5.0 Gbps",
               "a keyframe the entry is silent about keeps it");
  v.crossInto(99);
  assert.equal(v.controls[0].el.text(), "5.0 Gbps", "and so does one no window covered");
  assert.deepEqual(v.controls.map((c) => c.region), ["top-left", "bottom-right"],
                   "a row showing a new value keeps its place in the overlay");
  assert.equal(v.sent.length, 0, "and none of it asks the server anything");

  // A declaration landing after the window opens on the keyframe the clock is on.
  v.ctx.frame = { index: 4, alpha: 0 };
  v.declare([{ ...READOUT, text: "declared again" }, TOGGLE]);
  assert.equal(v.controls[0].el.text(), "5.0 Gbps");
});

test("an entry supplies the fields the declaration named, and nothing else", () => {
  const v = fakeViewer();
  v.declare([{ kind: "legend", region: "top-right", id: "sat", title: "Throughput", min: 0, max: 12,
               stops: [[0, "#440154"], [1, "#fde725"]], keyframed: ["max"] }]);
  v.deliver({ per_keyframe: {
    // Numbers travel as a typed array, so both forms are read the same way.
    sat: { max: { data: new Float32Array([12, 20]), shape: [2] },
           min: { data: new Float32Array([0, 5]), shape: [2] } },
    // Windows and declarations arrive independently, so an entry naming a widget nothing declared
    // is nothing to do rather than an error.
    ghost: { text: ["gone"] },
  } }, { startFrame: 0, count: 2 });

  assert.match(v.controls[0].el.text(), /12/);
  v.crossInto(1);
  assert.match(v.controls[0].el.text(), /20/, "the keyframed field follows the window");
  assert.doesNotMatch(v.controls[0].el.text(), /5/,
                      "the field the declaration did not name is the declaration's alone");
  assert.equal(v.controls.length, 1);
});

test("a keyframed child of a group is swapped without disturbing its siblings", () => {
  const v = fakeViewer();
  v.declare([{ kind: "group", region: "top-left",
               controls: [{ kind: "title", id: "count", text: "0", keyframed: ["text"] }, TOGGLE] }]);
  const box = v.controls[0].el;
  const sibling = box.children[1];

  v.deliver({ per_keyframe: { count: { text: ["7 sats", "9 sats"] } } },
            { startFrame: 0, count: 2 });
  assert.equal(box.children[0].text(), "7 sats");
  v.crossInto(1);
  assert.equal(box.children[0].text(), "9 sats");
  assert.equal(v.controls[0].el, box, "the box around it is not rebuilt");
  assert.equal(box.children[1], sibling, "nor is the sibling no entry names");
  assert.equal(box.children.length, 2);
});

test("the keyframes a window's per-keyframe values cover follow its mode", () => {
  const v = fakeViewer();
  v.declare([READOUT]);
  v.deliver({ per_keyframe: { load: { text: ["a", "b"] } } }, { startFrame: 0, count: 2 });
  v.deliver({ per_keyframe: { load: { text: ["c", "d"] } } },
            { startFrame: 2, count: 2, mode: "append" });
  v.crossInto(3);
  assert.equal(v.controls[0].el.text(), "d");
  v.crossInto(1);
  assert.equal(v.controls[0].el.text(), "b", "an append leaves the keyframes before it addressed");

  // A replace is the whole scene again, so the keyframes it does not carry have no values left.
  v.deliver({ per_keyframe: { load: { text: ["e"] } } }, { startFrame: 9, count: 1 });
  assert.equal(v.controls[0].el.text(), "e");
  v.crossInto(1);
  assert.equal(v.controls[0].el.text(), "e", "and a keyframe it dropped keeps the last value shown");
});

test("a window carrying the name `per_keyframe` replaced is reported, not applied", () => {
  const v = fakeViewer();
  v.declare([READOUT]);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warned.push(m);
  try {
    v.deliver({ tracks: { load: { text: ["4.2 Gbps", "5.0 Gbps"] } } },
              { startFrame: 0, count: 2 });
    v.crossInto(1);
  } finally {
    console.warn = warn;
  }
  assert.equal(v.controls[0].el.text(), "—", "the declared value stands");
  assert.equal(warned.length, 1, "reported once, not on every crossing");
  assert.match(warned[0], /per_keyframe/);
});

test("a legend renders a colorbar from the declared stops and range", () => {
  const v = fakeViewer();
  v.declare([{ kind: "legend", region: "top-right", title: "Throughput [Gbps]", min: 0, max: 12,
               stops: [[0, "#440154"], [1, "#fde725"]] }]);
  const bar = v.controls[0].el;
  assert.match(bar.text(), /Throughput \[Gbps\]/);
  assert.match(bar.text(), /12/);
  const ramp = bar.children.find((c) => c.children.length)!.children[0];
  assert.match(ramp.style.cssText, /linear-gradient\(to top,#440154 0%,#fde725 100%\)/);
  assert.equal(v.sent.length, 0, "a passive widget never reports");
});

test("an interactive widget reports upward and keeps showing the declared value", () => {
  const v = fakeViewer();
  v.declare([TOGGLE,
             { kind: "select", region: "bottom-right", id: "cells", label: "Cells", value: "served",
               options: [{ value: "all", label: "All" }, { value: "served", label: "Served" }] }]);

  const box = v.controls[0].el.find("input")!;
  assert.equal(box.checked, true, "the widget opens on the declared value");
  box.checked = false;
  box.onchange!();
  assert.deepEqual(v.sent.at(-1), { topic: "control", payload: { id: "isl", value: false } });
  assert.equal(box.checked, true, "and snaps back to it until the server declares otherwise");

  const menu = v.controls[1].el.find("select")!;
  assert.equal(menu.value, "1", "the declared option is the one selected");
  menu.value = "0";
  menu.onchange!();
  assert.deepEqual(v.sent.at(-1), { topic: "control", payload: { id: "cells", value: "all" } });
  assert.equal(menu.value, "1");
});

test("re-declaring keeps the element of a row that did not change", () => {
  const v = fakeViewer();
  const SELECT = { kind: "select", region: "bottom-right", id: "cells", label: "Cells",
                   value: "served",
                   options: [{ value: "all", label: "All" }, { value: "served", label: "Served" }] };
  v.declare([{ kind: "title", region: "top-center", text: "keyframe 1" }, SELECT]);
  const [title, select] = v.controls.map((c) => c.el);

  // The caption changes; the select does not. Element identity is what is asserted: a rebuilt
  // widget renders the same text, so text would prove nothing — and an element that leaves the
  // document takes an open dropdown with it.
  v.declare([{ kind: "title", region: "top-center", text: "keyframe 2" }, SELECT]);
  assert.equal(v.controls.length, 2);
  assert.equal(v.controls[1].el, select, "the unchanged row is the same element object");
  assert.notEqual(v.controls[0].el, title, "the changed row is not");
  assert.equal(v.controls[0].el.text(), "keyframe 2", "and shows what was declared");
  assert.deepEqual(v.controls.map((c) => c.region), ["top-center", "bottom-right"],
                   "a replaced row keeps its place in the overlay");

  // A row left standing is still on the crossing path, and a replaced one is on it too.
  v.declare([{ kind: "title", region: "top-center", frames: { "3": "keyframe 4" } }, SELECT]);
  v.crossInto(3);
  assert.equal(v.controls[0].el.text(), "keyframe 4");
  assert.equal(v.controls[1].el, select, "still the same select");

  // Anything but a position-for-position match of the rows is rebuilt wholesale.
  v.declare([SELECT, { kind: "title", region: "top-center", text: "keyframe 5" }]);
  assert.notEqual(v.controls[0].el, select, "a reordered list is not reconciled");
  assert.deepEqual(v.controls.map((c) => c.region), ["bottom-right", "top-center"]);
});

test("a group is one box, and its children carry no chrome of their own", () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 4, alpha: 0 };
  v.declare([{ kind: "group", region: "top-left", style: { "flex-direction": "row" },
               controls: [{ kind: "title", frames: { "4": "frame five" } },
                          { ...TOGGLE, region: "bottom-right" }] },
             TOGGLE]);

  assert.deepEqual(v.controls.map((c) => c.region), ["top-left", "bottom-right"],
                   "the group is one contribution, placed by its own region");
  const box = v.controls[0].el;
  assert.match(box.style.cssText, /background/, "the group wears the panel chrome");
  assert.equal(box.style["flex-direction"], "row", "the declared style merges over the defaults");
  assert.match(box.style.cssText, /display:flex/, "and does not replace them");

  assert.equal(box.children.length, 2, "both children are mounted inside it");
  for (const child of box.children) {
    assert.doesNotMatch(child.style.cssText, /background/, "a child gets no box of its own");
  }
  assert.equal(box.children[0].text(), "frame five",
               "a child follows the clock the same as a top-level row");
  v.crossInto(6);
  assert.equal(box.children[0].text(), "frame five", "including on a later crossing");

  // A child reports under its own id, exactly as a top-level control does.
  box.children[1].find("input")!.onchange!();
  assert.deepEqual(v.sent.at(-1), { topic: "control", payload: { id: "isl", value: true } });

  // A top-level row still gets a box of its own.
  assert.match(v.controls[1].el.style.cssText, /background/);
});

test("a group of unknown kinds is skipped, and a style reaches a lone control", () => {
  const v = fakeViewer();
  v.declare([{ kind: "group", region: "top-left", controls: [{ kind: "orbits.nothing" }] },
             // A group inside a group is not a kind: nesting stops at one level.
             { kind: "group", region: "top-left", controls: [{ kind: "group", controls: [TITLE] }] },
             { ...TOGGLE, style: { "font-size": "16px", opacity: "0.5" } }]);
  assert.equal(v.controls.length, 1, "an empty group leaves no box on the globe");
  assert.equal(v.controls[0].el.style["font-size"], "16px");
  assert.equal(v.controls[0].el.style.opacity, "0.5");
  assert.match(v.controls[0].el.style.cssText, /background/, "a style adds to the chrome");
});

test("each tooltip fragment is isolated, and no content leaves an empty box behind", () => {
  const v = fakeViewer();
  v.tooltip({ html: ["<b>Satellite 3</b>", "<style>b{color:red}</style>4.2 Gbps"] });
  const box = v.box()!;
  assert.equal(box.children.length, 2, "one element per contributing listener");
  assert.equal(box.children[0].shadow!.innerHTML, "<b>Satellite 3</b>",
               "mounted in its own shadow root, so its CSS cannot reach the other fragment");
  assert.equal(box.children[1].shadow!.innerHTML, "<style>b{color:red}</style>4.2 Gbps");
  assert.equal(box.style.display, "block");
  assert.match(box.style.cssText, /background/, "the module's own chrome, by default");

  // `bare` hands the whole box to the contributor.
  v.tooltip({ html: ["<div class='mine'>everything</div>"], bare: true });
  assert.doesNotMatch(box.style.cssText, /background/);

  v.tooltip({ html: null });
  assert.equal(box.style.display, "none");
  assert.equal(box.children.length, 0);
});

test("the tooltip is one box and it follows the cursor", () => {
  const v = fakeViewer();
  v.moveTo(100, 50);
  v.tooltip({ html: ["<b>hover</b>"] });
  const box = v.box()!;
  assert.deepEqual([box.style.left, box.style.top], ["114px", "64px"]);

  v.moveTo(300, 200);
  assert.deepEqual([box.style.left, box.style.top], ["314px", "214px"]);

  // A second hover replaces what the first said: the box holds no identity of its own.
  v.tooltip({ html: ["<b>another</b>"] });
  assert.equal(v.box(), box, "and it is still the one box");
  assert.equal(box.children[0].shadow!.innerHTML, "<b>another</b>");
});

const PIN = { id: "pin", anchor: { anchor: "screen", x: 320, y: 180 }, html: "<b>Sat 12</b>",
              closable: true, keyframed: ["html"] };

test("a float's top-left sits on its screen anchor, exactly", () => {
  const v = fakeViewer();
  v.floating([PIN]);
  const box = v.floats().get("pin")!;
  assert.equal(box.children[0].shadow!.innerHTML, "<b>Sat 12</b>",
               "server-authored content, in its own shadow root");
  assert.deepEqual([box.style.left, box.style.top], ["320px", "180px"]);
  assert.match(box.style.cssText, /background/, "the overlay's own chrome, by default");

  // The cursor is nothing to a float: it was put somewhere and it stays there.
  v.moveTo(10, 10);
  assert.deepEqual([box.style.left, box.style.top], ["320px", "180px"]);

  // Declaring the set without it is the removal, and several stand at once until then.
  v.floating([PIN, { ...PIN, id: "second", anchor: { anchor: "screen", x: 10, y: 20 } }]);
  assert.deepEqual([...v.floats().keys()], ["pin", "second"]);
  assert.equal(v.floats().get("pin"), box, "an unchanged float keeps the box it already had");
  v.floating([]);
  assert.equal(v.floats().size, 0);
  assert.equal(v.sent.length, 0, "and none of it asked the server anything");
});

test("a float follows the entity it names, through the module that owns it", () => {
  const v = fakeViewer();
  v.floating([{ id: "follow", anchor: { anchor: "entity", module: "primitives", kind: "sat", idx: 0 },
                html: "<b>Sat 1</b>" },
              { id: "ground", anchor: { anchor: "world", lon: 12, lat: 42, height: 0 },
                html: "<b>Rome</b>" }]);
  const follow = v.floats().get("follow")!;
  assert.deepEqual([follow.style.left, follow.style.top], ["114px", "64px"]);
  assert.deepEqual([v.floats().get("ground")!.style.left, v.floats().get("ground")!.style.top],
                   ["26px", "56px"], "a world anchor projects the same way");

  // The entity moves as positions interpolate, and the box rides it on the next rendered tick.
  v.scene.positions["sat:0"] = { x: 400, y: 300, z: 0 };
  v.render();
  assert.deepEqual([follow.style.left, follow.style.top], ["414px", "314px"]);
  assert.equal(v.sent.length, 0, "with nothing asked of the server");
});

test("a float whose anchor does not resolve hides rather than throwing", () => {
  const v = fakeViewer();
  v.floating([{ id: "gone", anchor: { anchor: "entity", module: "primitives", kind: "sat", idx: 9 },
                html: "<b>renumbered away</b>" },
              // A module that owns entities but exports no `positionOf` cannot be anchored to, and
              // neither can one nothing declared at all.
              { id: "opaque", anchor: { anchor: "entity", module: "opaque", kind: "sat", idx: 0 },
                html: "<b>no accessor</b>" },
              { id: "absent", anchor: { anchor: "entity", module: "nobody", kind: "sat", idx: 0 },
                html: "<b>no module</b>" },
              { id: "nonsense", anchor: { anchor: "elsewhere" }, html: "<b>no such anchor</b>" }]);
  for (const [id, box] of v.floats()) {
    assert.equal(box.style.display, "none", `${id} is hidden rather than misplaced`);
  }

  // Hiding is not removal: the float stands, and comes back when its entity does.
  v.scene.positions["sat:9"] = { x: 100, y: 50, z: 0 };
  v.render();
  assert.equal(v.floats().get("gone")!.style.display, "block");
  assert.deepEqual([v.floats().get("gone")!.style.left, v.floats().get("gone")!.style.top],
                   ["114px", "64px"]);
});

test("a float's keyframed content follows the clock, and its close reports its id", () => {
  const v = fakeViewer();
  v.floating([PIN]);
  const box = v.floats().get("pin")!;
  assert.equal(box.children[0].shadow!.innerHTML, "<b>Sat 12</b>",
               "the declared value, until a window carries another");

  v.deliver({ per_keyframe: { pin: { html: ["<b>frame 3</b>", "<b>frame 4</b>"] } } },
            { startFrame: 3, count: 2 });
  assert.equal(box.children[0].shadow!.innerHTML, "<b>frame 3</b>",
               "the keyframe the clock is on, without waiting for a crossing");
  v.crossInto(4);
  assert.equal(box.children[0].shadow!.innerHTML, "<b>frame 4</b>");
  assert.equal(v.floats().get("pin"), box, "the box is not rebuilt around it");
  v.crossInto(5);
  assert.equal(box.children[0].shadow!.innerHTML, "<b>frame 4</b>",
               "a keyframe the entry is silent about keeps what it showed");
  assert.equal(v.sent.length, 0, "and none of it asks the server anything");

  // The close button says the user asked; the float leaves when the server declares without it.
  box.children.at(-1)!.onclick!();
  assert.deepEqual(v.sent.at(-1), { topic: "close", payload: { id: "pin" } });
  assert.equal(v.floats().size, 1, "and not before");
});

test("a float declared after the window opens on the keyframe the clock is on", () => {
  const v = fakeViewer();
  v.ctx.frame = { index: 4, alpha: 0 };
  v.deliver({ per_keyframe: { late: { html: ["<b>frame 3</b>", "<b>frame 4</b>"] } } },
            { startFrame: 3, count: 2 });
  // Its own spec object: a crossing writes each keyframe's values into the spec the float rebuilds
  // from, so a shared literal would carry another test's values into this one.
  v.floating([{ id: "late", anchor: { anchor: "screen", x: 0, y: 0 }, html: "<b>declared</b>",
                keyframed: ["html"] }]);
  assert.equal(v.floats().get("late")!.children[0].shadow!.innerHTML, "<b>frame 4</b>",
               "the value its window carries, not the declared one, and without a crossing");
});

test("a module fills a float's box, and keeps it across a keyframe crossing", () => {
  const log: string[] = [];
  const scene = fakeScene();
  let filled: { el: FakeEl; report: (v: unknown) => void } | null = null;
  (scene.modules as { get: (id: string) => unknown }).get = (id: string) =>
    id === "charts"
      ? {
          mount: (site: { el: FakeEl; id: string; report: (v: unknown) => void }) => {
            log.push(`create:${site.id}`);
            filled = site;
            site.el.textContent = "drawn by the module";
            return { resize: () => log.push("resize"), dispose: () => log.push("dispose") };
          },
        }
      : undefined;
  const v = fakeViewer(scene);

  // Declared with a keyframed field, which a mounted float has no use for: its data reaches it
  // through the window addressed to the module. The declaration is off the wire and not to be
  // trusted, so what is asserted below is that `ui` leaves the module standing regardless.
  const MOUNTED = { id: "panel", anchor: { anchor: "screen", x: 40, y: 40 }, mount: "charts",
                    keyframed: ["html"] };
  v.floating([MOUNTED]);
  const box = v.floats().get("panel")!;
  assert.deepEqual(log, ["create:panel", "resize"],
                   "created once, and told its box after it was placed");
  assert.equal(box.children[0].shadow, null, "a mount is a plain element, never a shadow root");
  assert.equal(box.text(), "drawn by the module");

  // A window and its crossings are the module's own business: rebuilding the box on each one would
  // tear down and rebuild whatever it is drawing.
  v.deliver({ per_keyframe: { panel: { html: ["<b>a</b>", "<b>b</b>"] } } },
            { startFrame: 0, count: 2 });
  v.crossInto(1);
  assert.deepEqual(log, ["create:panel", "resize"], "not disposed, not recreated, not resized");
  assert.equal(box.text(), "drawn by the module");

  // It reports as the site it fills: the same id and the same event a built-in widget sends.
  filled!.report(7);
  assert.deepEqual(v.sent.at(-1), { topic: "control", payload: { id: "panel", value: 7 } });

  // Moving or restyling it keeps the module; the box is re-declared, so the module is told.
  v.floating([{ ...MOUNTED, anchor: { anchor: "screen", x: 90, y: 90 } }]);
  assert.equal(v.floats().get("panel"), box, "the same box");
  assert.deepEqual(log, ["create:panel", "resize", "resize"]);
  assert.deepEqual([box.style.left, box.style.top], ["90px", "90px"]);

  // Declaring the set without it is what takes the module down.
  v.floating([]);
  assert.deepEqual(log, ["create:panel", "resize", "resize", "dispose"]);
  assert.equal(v.floats().size, 0);
});

test("a float naming a module that cannot be mounted renders nothing and still stands", () => {
  const v = fakeViewer();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warned.push(m);
  try {
    v.floating([{ id: "panel", anchor: { anchor: "screen", x: 40, y: 40 }, mount: "nobody" }]);
  } finally {
    console.warn = warn;
  }
  assert.equal(v.floats().size, 1, "the float stays in the set, so a later declaration reconciles");
  assert.equal(v.floats().get("panel")!.text(), "");
  assert.match(warned.join("\n"), /nobody/);

  // And the box is still the module's to fill once one that exports `mount` is loaded.
  assert.equal(v.sent.length, 0);
});

test("a float leaves nothing behind when the module unloads", () => {
  const v = fakeViewer();
  v.floating([PIN]);
  v.tooltip({ html: ["<b>hover</b>"] });
  assert.equal(v.floats().size, 1);
  v.teardown();
  assert.equal(v.floats().size, 0);
  assert.equal(v.box(), null);
});

// A box the user may move and resize. Closable too, since the close button moves into the strip.
const PANE = { id: "pane", anchor: { anchor: "screen", x: 320, y: 180 }, html: "<b>Sat 12</b>",
               closable: true, adjustable: true };

/** The drag strip of a float's box, or null for one nobody may move. */
const dragStrip = (box: FakeEl) =>
  box.children.find((c) => c.attributes["data-ui"] === "drag") ?? null;

/** The grip rule on the page, which the first adjustable float puts there. */
const styleTag = (v: { ctx: { container: FakeEl } }) =>
  v.ctx.container.children.find((c) => c.tag === "style") ?? null;

test("an adjustable float is dragged by its strip, and says where it landed on release", () => {
  const v = fakeViewer();
  v.floating([{ ...PANE, adjustable: false }]);
  const plain = v.floats().get("pane")!;
  assert.equal(dragStrip(plain), null, "a float nobody may adjust wears no strip");
  assert.doesNotMatch(plain.style.cssText, /resize/, "and no resize grip");
  assert.equal("data-adjustable" in plain.attributes, false, "and says so, so it wears no wedge");
  assert.equal(styleTag(v), null, "and puts no stylesheet on the page");

  v.floating([PANE]);
  const box = v.floats().get("pane")!;
  box.offsetWidth = 200;
  box.offsetHeight = 100;
  const strip = dragStrip(box)!;
  assert.match(strip.style.cssText, /cursor:move/);
  assert.equal(strip.children.at(-1)!.textContent, "×", "the close button sits in the strip");
  assert.match(box.style.cssText, /resize:both/);
  // The corner only resizes on a box whose overflow is not visible, and `hidden` is what keeps the
  // box itself from scrolling: a bar on the box runs its whole height and takes the strip's width
  // with it. The content element under the strip is what scrolls, over the height the strip and its
  // gap leave.
  assert.match(box.style.cssText, /overflow:hidden/);
  const content = box.children.find((c) => c.attributes["data-ui"] === "content")!;
  assert.match(content.style.cssText, /overflow:auto/);
  assert.match(content.style.cssText, /height:calc\(100% - 24px\)/);
  // Load-bearing, and it looks removable: an inherited `scrollbar-color` from the host page
  // silences every ::-webkit-scrollbar rule below, and a VSCode webview sets one.
  assert.match(content.style.cssText, /scrollbar-color:auto/);
  assert.equal(box.children[0], strip, "the strip is the box's first child");
  assert.match(styleTag(v)!.textContent, /^\[data-float\]::-webkit-resizer\{/,
               "the grip rule, alone rather than in a selector list");
  assert.equal("data-adjustable" in box.attributes, true, "the box says it may be resized");
  assert.match(styleTag(v)!.textContent, /\[data-float\]\[data-adjustable\]:hover::after\{opacity:1\}/,
               "and the corner wedge shows only while the box is under the pointer");
  assert.match(styleTag(v)!.textContent, /\[data-ui="content"\]::-webkit-scrollbar\{/,
               "and the bar is shaped on the element that scrolls");

  // A press on the strip that moved nothing is not an interaction and says nothing.
  strip.onpointerdown!(pointerAt(400, 300));
  strip.onpointerup!(pointerAt(400, 300));
  assert.equal(v.sent.length, 0);

  // The strip holds the pointer for the whole drag, so the box follows one that wanders over the
  // globe and Cesium below never sees the move.
  strip.onpointerdown!(pointerAt(400, 300));
  assert.equal(strip.captured, 1);
  strip.onpointermove!(pointerAt(450, 330));
  assert.deepEqual([box.style.left, box.style.top], ["370px", "210px"]);
  assert.equal(v.sent.length, 0, "and nothing is said while the pointer is down");

  strip.onpointerup!(pointerAt(450, 330));
  assert.deepEqual(v.sent, [{ topic: "rect",
                              payload: { id: "pane", x: 370, y: 210, w: 200, h: 100 } }],
                   "told once, on release");
  assert.equal(strip.captured, null);

  // The drop re-anchored the float, so the next rendered tick leaves the box where it is.
  v.render();
  assert.deepEqual([box.style.left, box.style.top], ["370px", "210px"]);

  v.teardown();
  assert.equal(styleTag(v), null, "and the grip rule leaves with the module");
});

test("the close button of an adjustable float outranks the drag strip under it", () => {
  const v = fakeViewer();
  v.floating([PANE]);
  const box = v.floats().get("pane")!;
  const strip = dragStrip(box)!;
  const x = strip.children.at(-1)!;
  assert.equal(x.textContent, "×");

  // The press is kept off the strip. A strip that sees it starts a drag and captures the pointer,
  // and then the × never sees the release, so a closable box cannot be closed.
  const down = pointerAt(400, 300);
  x.onpointerdown!(down);
  assert.equal(down.stopped, true);
  assert.equal(strip.captured, null, "so no drag starts under it");

  x.onclick!();
  assert.deepEqual(v.sent, [{ topic: "close", payload: { id: "pane" } }]);
});

test("a moved float keeps where the user put it, whatever a later declaration says", () => {
  const v = fakeViewer();
  v.floating([PANE]);
  const box = v.floats().get("pane")!;
  box.offsetWidth = 200;
  box.offsetHeight = 100;
  const strip = dragStrip(box)!;

  // Dragged past the corner: the box stops at the container's edge rather than leaving it.
  strip.onpointerdown!(pointerAt(0, 0));
  strip.onpointermove!(pointerAt(900, 700));
  strip.onpointerup!(pointerAt(900, 700));
  assert.deepEqual([box.style.left, box.style.top], ["600px", "500px"]);
  assert.deepEqual(v.sent.at(-1), { topic: "rect",
                                    payload: { id: "pane", x: 600, y: 500, w: 200, h: 100 } });

  // A declaration that moves and resizes it. The box is the user's now, and rewriting its chrome
  // wholesale — which is what a changed declaration does — does not take it back.
  v.floating([{ ...PANE, anchor: { anchor: "screen", x: 10, y: 20 }, style: { width: "50px" } }]);
  assert.equal(v.floats().get("pane"), box, "the same box");
  assert.deepEqual([box.style.left, box.style.top], ["600px", "500px"]);
  assert.deepEqual([box.style.width, box.style.height], ["200px", "100px"]);
  v.render();
  assert.deepEqual([box.style.left, box.style.top], ["600px", "500px"]);

  // What the user did dies with the box: dropped from the set and declared again, the float comes
  // back where the declaration puts it.
  v.floating([]);
  v.floating([{ ...PANE, anchor: { anchor: "screen", x: 10, y: 20 } }]);
  const back = v.floats().get("pane")!;
  assert.deepEqual([back.style.left, back.style.top], ["10px", "20px"]);
  assert.equal(v.sent.length, 1, "and none of that asked the server anything");
});

test("resizing an adjustable float reports the box it ended at, once", () => {
  const v = fakeViewer();
  v.floating([PANE]);
  const box = v.floats().get("pane")!;
  box.offsetWidth = 200;
  box.offsetHeight = 100;

  // The browser owns this gesture: it reports no move while it runs and writes the size onto the
  // box itself, so the box is measured on either side of it.
  box.onpointerdown!(pointerAt(520, 280));
  box.offsetWidth = 260.4;
  box.offsetHeight = 140.6;
  box.onpointerup!(pointerAt(580, 320));
  assert.deepEqual(v.sent, [{ topic: "rect",
                              payload: { id: "pane", x: 320, y: 180, w: 260, h: 141 } }],
                   "in whole container pixels");

  // A press that resized nothing is not an interaction and says nothing.
  box.onpointerdown!(pointerAt(400, 200));
  box.onpointerup!(pointerAt(400, 200));
  assert.equal(v.sent.length, 1);
});

test("a tooltip box flips and clamps to stay inside the container", () => {
  const bounds = { w: 800, h: 600 };
  assert.deepEqual(place({ x: 10, y: 10 }, { w: 200, h: 100 }, bounds), { left: 24, top: 24 });
  // Down-right would overflow, so it flips to the other side of the cursor.
  assert.deepEqual(place({ x: 790, y: 590 }, { w: 200, h: 100 }, bounds), { left: 576, top: 476 });
  // Flipping is not enough near the corner: it clamps to the edge rather than leaving the container.
  assert.deepEqual(place({ x: 5, y: 5 }, { w: 790, h: 595 }, bounds), { left: 0, top: 0 });
  // A box larger than its container still starts at the edge instead of off-screen.
  assert.deepEqual(place({ x: 400, y: 300 }, { w: 900, h: 700 }, bounds), { left: 0, top: 0 });
});

test("a point the box does not sit beside is its top-left, clamped inside", () => {
  const bounds = { w: 800, h: 600 };
  assert.deepEqual(place({ x: 320, y: 180 }, { w: 200, h: 100 }, bounds, false),
                   { left: 320, top: 180 }, "no gap: the point is the box's top-left");
  // Nothing to flip around: past the edge the box moves back only as far as the container.
  assert.deepEqual(place({ x: 790, y: 590 }, { w: 200, h: 100 }, bounds, false),
                   { left: 600, top: 500 });
  // A box larger than its container still starts at the edge instead of off-screen.
  assert.deepEqual(place({ x: 400, y: 300 }, { w: 900, h: 700 }, bounds, false), { left: 0, top: 0 });
});
