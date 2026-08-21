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

// primitives/src/knobs.ts
var at = (s, i, j = 0) => s.data[s.offset + i * s.stride + j];
var whole = (data, stride) => ({ data, offset: 0, stride, length: stride === 0 ? Infinity : data.length / stride });
var constant = (slice) => ({ keyframed: false, frame: () => slice });
function knob(raw, s) {
  const { itemLen, count, what, n, module = "primitives" } = s;
  const name = `${module}: ${what}`;
  if (raw === null || raw === void 0) return null;
  if (typeof raw === "number") {
    if (itemLen !== 1) {
      throw new Error(`${name} takes ${itemLen} components, not one number`);
    }
    return constant(whole([raw], 0));
  }
  if (Array.isArray(raw)) {
    if (raw.length !== count) {
      throw new Error(`${name} has ${raw.length} keyframes, the window carries ${count}`);
    }
    const slices = raw.map((one, k) => {
      if (!isNdArray(one)) throw new Error(`${name} keyframe ${k} is not an array`);
      if (one.data.length % itemLen !== 0) {
        throw new Error(`${name} keyframe ${k} has ${one.data.length} values, not whole groups of ${itemLen}`);
      }
      return whole(one.data, itemLen);
    });
    return { keyframed: true, frame: (k) => slices[k] ?? null };
  }
  if (!isNdArray(raw)) throw new Error(`${name} is neither a number nor an array`);
  const { data, shape } = raw;
  const dims = shape.length;
  const want = (expected, form) => {
    if (data.length !== expected) {
      throw new Error(`${name} as ${form} wants ${expected} values, got ${data.length}`);
    }
  };
  if (itemLen > 1 && dims === 1) {
    want(itemLen, "one value for the family");
    return constant(whole(data, 0));
  }
  const entityDims = itemLen > 1 ? 2 : 1;
  if (dims === entityDims) {
    if (n !== void 0) want(n * itemLen, "one value per entity");
    else if (data.length % itemLen !== 0) want(data.length, "one value per entity");
    return constant(whole(data, itemLen));
  }
  if (dims === entityDims + 1) {
    let first;
    try {
      first = blockAt(raw, 0, entityDims, count);
    } catch (err) {
      throw new Error(`${name}, ${err.message}`);
    }
    if (first && n !== void 0 && first.len !== n * itemLen) {
      want(count * n * itemLen, "one value per entity per keyframe");
    }
    return {
      keyframed: true,
      frame: (k) => {
        const block = blockAt(raw, k, entityDims, count);
        return block && {
          data: block.data,
          offset: block.offset,
          stride: itemLen,
          length: block.len / itemLen
        };
      }
    };
  }
  throw new Error(`${name} has shape [${shape}], which is none of the forms for a family of ${n ?? "?"} over ${count} keyframes`);
}

// primitives/src/paint.ts
var WHITE = [255, 255, 255, 255];
var BLACK = [0, 0, 0, 217];
var channel = (s, i, j, fallback) => s ? at(s, i, j) : fallback[j];
var colorOf = (C, s, i, fallback, result) => C.Color.fromBytes(
  channel(s, i, 0, fallback),
  channel(s, i, 1, fallback),
  channel(s, i, 2, fallback),
  channel(s, i, 3, fallback),
  result
);

// primitives/src/areas.ts
var DEFAULT_SIDES = 6;
var DEFAULT_RADIUS = 1e3;
var DRAPE_SPAN_DEG = 0.5;
var DRAPE_GRANULARITY_RAD = DRAPE_SPAN_DEG * Math.PI / 180;
var EARTH_RADIUS_M = 6371e3;
var spanDegrees = (radius) => 2 * radius * 180 / (EARTH_RADIUS_M * Math.PI);
var AreaFamily = class {
  fill = null;
  outline = null;
  ids = [];
  // The mask this family last applied, for an anchored primitive to hide with. Kept rather than read
  // back: a geometry-instance attribute exists only once its Primitive has rendered, so before that
  // there is nothing to ask, and the build-time value is the only answer.
  shown = [];
  /** The point each footprint stands on, for an edge family hanging off this one. */
  positions = [];
  timeline;
  n = 0;
  built = "";
  showScratch = new Uint8Array(1);
  scratch;
  kind;
  C;
  scene;
  pickId;
  constructor(kind, C, scene, pickId, timeline) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.pickId = pickId;
    this.scratch = new C.Color();
    this.timeline = timeline;
  }
  onWindow(spec, win) {
    const count = win.count;
    if (!spec.center && !spec.boundary && !this.built) {
      throw new Error(`primitives: ${win.mode} window gives area family "${this.kind}" no footprint centres and no boundary, and none are standing \u2014 they ride a replacing window`);
    }
    if (spec.center) this.n = spec.center.shape[0] ?? 0;
    else if (spec.boundary) this.n = spec.boundary.length;
    const n = this.n;
    const what = (name) => `${this.kind}.${name}`;
    const w = {
      color: knob(spec.color, { itemLen: 4, n, count, what: what("color") }),
      outline: knob(spec.outline, { itemLen: 4, n, count, what: what("outline") }),
      show: knob(spec.show, { itemLen: 1, n, count, what: what("show") })
    };
    if (spec.center || spec.boundary) {
      const drape = `${spec.drape ?? "span"}`;
      const height = digest(scalarData(spec.heightM));
      const signature = spec.boundary ? `${n}|${height}|${drape}|${ringsDigest(spec.boundary)}` : `${n}|${spec.sides ?? DEFAULT_SIDES}|${height}|${drape}|${digest(spec.center.data)}|${digest(scalarData(spec.radius))}`;
      if (signature !== this.built) {
        this.build(spec, w, n, count);
        this.built = signature;
      }
    }
    this.timeline.install(w, win);
  }
  build(spec, w, n, count) {
    const { C, scene } = this;
    this.destroyPrimitives();
    const lonlat = spec.center?.data ?? null;
    const sides = Math.max(3, Math.round(spec.sides ?? DEFAULT_SIDES));
    const heights = knob(spec.heightM, { itemLen: 1, n, count, what: `${this.kind}.height_m` })?.frame(0) ?? null;
    const radius = knob(spec.radius, { itemLen: 1, n, count, what: `${this.kind}.radius` })?.frame(0) ?? null;
    const color = w.color?.frame(0) ?? null;
    const outlineColor = w.outline?.frame(0) ?? null;
    const show = w.show?.frame(0) ?? null;
    const fills = new Array(n);
    const outlines = outlineColor ? new Array(n) : [];
    this.ids = new Array(n);
    this.shown = new Array(n);
    for (let i = 0; i < n; i++) {
      const region = spec.boundary?.[i];
      const height = heights ? at(heights, i) : 0;
      let hierarchy;
      let span;
      if (region) {
        hierarchy = this.rings(region, height);
        const e = spec.extent.data;
        this.positions.push(C.Cartesian3.fromDegrees(
          (e[i * 4] + e[i * 4 + 1]) / 2,
          (e[i * 4 + 2] + e[i * 4 + 3]) / 2,
          height
        ));
        span = Math.max(e[i * 4 + 1] - e[i * 4], e[i * 4 + 3] - e[i * 4 + 2]);
      } else {
        const center = C.Cartesian3.fromDegrees(lonlat[i * 2], lonlat[i * 2 + 1], height);
        this.positions.push(center);
        const r = radius ? at(radius, i) : DEFAULT_RADIUS;
        hierarchy = this.footprint(center, r, sides);
        span = spanDegrees(r);
      }
      const shape = spec.drape ?? span > DRAPE_SPAN_DEG ? { height, granularity: DRAPE_GRANULARITY_RAD } : { perPositionHeight: true };
      const id = this.ids[i] = this.pickId(this.kind, i);
      this.shown[i] = show ? at(show, i) !== 0 : true;
      const shown = new C.ShowGeometryInstanceAttribute(this.shown[i]);
      fills[i] = new C.GeometryInstance({
        geometry: new C.PolygonGeometry({ polygonHierarchy: hierarchy, ...shape }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(this.color(color, i, WHITE)),
          show: shown
        },
        id
      });
      if (outlineColor) {
        outlines[i] = new C.GeometryInstance({
          geometry: new C.PolygonOutlineGeometry({ polygonHierarchy: hierarchy, ...shape }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(this.color(outlineColor, i, BLACK)),
            show: shown
          },
          id
        });
      }
    }
    this.fill = scene.primitives.add(new C.Primitive({
      geometryInstances: fills,
      appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
      asynchronous: true
    }));
    if (outlineColor) {
      this.outline = scene.primitives.add(new C.Primitive({
        geometryInstances: outlines,
        appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true
      }));
    }
  }
  /**
   * The hierarchy a region's rings describe: the outer ring, and one hole for every ring after it.
   * The tessellated geometry genuinely has the hole, so the outline traces it and a pointer over it
   * misses this region.
   */
  rings(region, height) {
    const { C } = this;
    const holes = region.slice(1).map((h) => new C.PolygonHierarchy(this.vertices(h, height)));
    return new C.PolygonHierarchy(this.vertices(region[0], height), holes);
  }
  /** One ring's vertices, lifted to `height`. The ring is open: its last vertex joins its first. */
  vertices(ring, height) {
    const { data } = ring;
    const out = new Array(data.length / 2);
    for (let j = 0; j < out.length; j++) {
      out[j] = this.C.Cartesian3.fromDegrees(data[j * 2], data[j * 2 + 1], height);
    }
    return out;
  }
  /** Corners of a regular `sides`-gon of `radius` metres about `center`, in its ENU frame. */
  footprint(center, radius, sides) {
    const { C } = this;
    const enu = C.Transforms.eastNorthUpToFixedFrame(center);
    const corners = Array.from({ length: sides }, (_, i) => {
      const a = 2 * Math.PI * i / sides;
      return C.Matrix4.multiplyByPoint(
        enu,
        new C.Cartesian3(radius * Math.cos(a), radius * Math.sin(a), 0),
        new C.Cartesian3()
      );
    });
    return new C.PolygonHierarchy(corners);
  }
  /** Colour and mask at the keyframe `where` names: attribute writes on geometry that stands. */
  onKeyframe(where) {
    const place = this.timeline.at(where);
    if (!place) return;
    const { w, k } = place;
    const fill = this.fill?.ready ? this.fill : null;
    const outline = this.outline?.ready ? this.outline : null;
    if (!fill && !outline) return;
    const color = w.color?.frame(k) ?? null;
    const outlineColor = w.outline?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    const C = this.C;
    for (let i = 0; i < this.n; i++) {
      this.shown[i] = show ? at(show, i) !== 0 : true;
      const shown = C.ShowGeometryInstanceAttribute.toValue(this.shown[i], this.showScratch);
      const f = fill?.getGeometryInstanceAttributes(this.ids[i]);
      if (f) {
        if (color) f.color = C.ColorGeometryInstanceAttribute.toValue(this.color(color, i, WHITE), f.color);
        f.show = shown;
      }
      const o = outline?.getGeometryInstanceAttributes(this.ids[i]);
      if (o) {
        if (outlineColor) {
          o.color = C.ColorGeometryInstanceAttribute.toValue(this.color(outlineColor, i, BLACK), o.color);
        }
        o.show = shown;
      }
    }
  }
  color(s, i, fallback) {
    return colorOf(this.C, s, i, fallback, this.scratch);
  }
  /** Footprints are tessellated once and never move, so nothing hanging off one has to follow it. */
  get moving() {
    return false;
  }
  /** The pick stamp of entity `idx`, for a module drawing something anchored to it. */
  pickIdAt(idx) {
    return this.ids[idx];
  }
  /** Whether entity `idx` is drawn, so an anchored primitive hides with it. */
  shownAt(idx) {
    return this.shown[idx];
  }
  destroyPrimitives() {
    for (const prim of [this.fill, this.outline]) {
      if (prim) {
        try {
          this.scene.primitives.remove(prim);
        } catch {
        }
      }
    }
    this.fill = null;
    this.outline = null;
    this.ids = [];
    this.shown = [];
    this.positions.length = 0;
  }
  destroy() {
    this.destroyPrimitives();
    this.timeline.clear();
    this.built = "";
    this.n = 0;
  }
};
var scalarData = (knobValue) => typeof knobValue === "number" ? [knobValue] : knobValue?.data ?? [];
function digest(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  return `${a.length}:${a[0] ?? 0}:${a[a.length - 1] ?? 0}:${sum}`;
}
function ringsDigest(boundary) {
  let counts = "";
  let sum = 0;
  for (const region of boundary) {
    for (const ring of region) {
      counts += `${ring.data.length / 2},`;
      for (let i = 0; i < ring.data.length; i++) sum += ring.data[i];
    }
    counts += ";";
  }
  return `${counts}:${sum}`;
}

// primitives/src/edges.ts
var STYLES = ["solid", "dashed", "glow"];
var DEFAULT_WIDTH = 1;
var DEFAULT_DASH = 16;
var EdgeFamily = class {
  lines = null;
  timeline;
  materials = /* @__PURE__ */ new Map();
  /** Endpoint pairs by edge index — the node families' own position objects, not copies. */
  ends = [];
  /** Edge index drawn by each polyline, in the order they were added. */
  order = [];
  /** What the standing polylines describe, or null when none stand. */
  drawn = null;
  moving = false;
  /**
   * True from a rebuild until the next frame reads the endpoints back. A line is added against the
   * endpoint families' position objects, which hold the coordinates of the tick before, so every
   * rebuild owes one read whether or not either end moves.
   */
  stale = false;
  kind;
  C;
  scene;
  endpoints;
  pickId;
  constructor(kind, C, scene, endpoints, pickId, timeline) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.endpoints = endpoints;
    this.pickId = pickId;
    this.timeline = timeline;
  }
  onWindow(spec, win) {
    const count = win.count;
    const what = (name) => `${this.kind}.${name}`;
    const w = {
      spec,
      pairs: knob(spec.pairs, { itemLen: 2, count, what: what("pairs") }),
      color: knob(spec.color, { itemLen: 4, count, what: what("color") }),
      style: knob(spec.style, { itemLen: 1, count, what: what("style") }),
      width: knob(spec.width, { itemLen: 1, count, what: what("width") }),
      show: knob(spec.show, { itemLen: 1, count, what: what("show") }),
      rebuilds: false,
      restyles: false
    };
    w.rebuilds = !!(w.pairs.keyframed || w.color?.keyframed || w.style?.keyframed);
    w.restyles = !!(w.width?.keyframed || w.show?.keyframed);
    if (!this.lines) {
      this.lines = this.scene.primitives.add(new this.C.PolylineCollection());
    }
    if (win.mode === "replace") this.drawn = null;
    this.timeline.install(w, win);
  }
  /** Bring the lines up to date with the keyframe `where` names, rebuilding only where it must. */
  onKeyframe(where) {
    const place = this.timeline.at(where);
    const pl = this.lines;
    if (!place || !pl) return;
    const { w, k } = place;
    const pairs = w.pairs.frame(k);
    if (!pairs) return;
    if (!Number.isFinite(pairs.length)) throw new Error(`primitives: ${this.kind}.pairs is per edge`);
    const from = this.endpoints(w.spec.from);
    const to = this.endpoints(w.spec.to);
    if (!from || !to) {
      this.clearLines();
      this.order = [];
      this.drawn = null;
      return;
    }
    this.moving = from.moving || to.moving;
    const width = w.width?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    if (this.drawn && !w.rebuilds) {
      if (w.restyles) {
        for (let p2 = 0; p2 < this.order.length; p2++) {
          const e = this.order[p2];
          const line = pl.get(p2);
          if (width) line.width = at(width, e);
          if (show) line.show = at(show, e) !== 0;
        }
      }
      this.drawn = place;
      return;
    }
    const color = w.color?.frame(k) ?? null;
    const style = w.style?.frame(k) ?? null;
    const dash = w.spec.dashLength ?? DEFAULT_DASH;
    const byLook = /* @__PURE__ */ new Map();
    const m = pairs.length;
    for (let e = 0; e < m; e++) {
      const look = {
        code: style ? at(style, e) : 0,
        rgba: [
          channel(color, e, 0, WHITE),
          channel(color, e, 1, WHITE),
          channel(color, e, 2, WHITE),
          channel(color, e, 3, WHITE)
        ]
      };
      const key = `${look.code}|${look.rgba}|${dash}`;
      const group = byLook.get(key);
      if (group) group.edges.push(e);
      else byLook.set(key, { look, edges: [e] });
    }
    this.clearLines();
    this.ends = new Array(m);
    this.order = new Array(m);
    let p = 0;
    for (const [key, { look, edges }] of byLook) {
      const material = this.material(key, look, dash);
      for (const e of edges) {
        const u = at(pairs, e, 0);
        const v = at(pairs, e, 1);
        const ends = [from.positions[u], to.positions[v]];
        if (!ends[0] || !ends[1]) continue;
        this.ends[e] = ends;
        this.order[p++] = e;
        pl.add({
          positions: ends,
          width: width ? at(width, e) : DEFAULT_WIDTH,
          show: show ? at(show, e) !== 0 : true,
          material,
          id: this.pickId(this.kind, e)
        });
      }
    }
    this.order.length = p;
    this.evictMaterials(byLook);
    this.drawn = place;
    this.stale = true;
  }
  /** Follow the interpolated endpoints, so an edge tracks its moving end between keyframes. */
  onFrame() {
    const pl = this.lines;
    if (!pl || !this.moving && !this.stale) return;
    this.stale = false;
    for (let p = 0; p < this.order.length; p++) {
      const ends = this.ends[this.order[p]];
      if (ends) pl.get(p).positions = ends;
    }
  }
  /** Live endpoints of edge `idx`, for a module drawing something coincident with it. */
  endpointsOf(idx) {
    const ends = this.ends[idx];
    return ends ? [ends[0], ends[1]] : void 0;
  }
  /** The endpoint families this family joins, and the pairs standing at the drawn keyframe. */
  connectivity() {
    const place = this.drawn ?? void 0;
    if (!place) return void 0;
    const slice = place.w.pairs.frame(place.k);
    if (!slice || !Number.isFinite(slice.length)) return void 0;
    const { data, offset, length } = slice;
    const pairs = data instanceof Uint32Array ? data.subarray(offset, offset + length * 2) : Uint32Array.from({ length: length * 2 }, (_, i) => data[offset + i]);
    return { from: place.w.spec.from, to: place.w.spec.to, pairs };
  }
  /** The one material every line of one appearance shares, built on first use and kept for reuse. */
  material(key, look, dashLength) {
    const held = this.materials.get(key);
    if (held) return held;
    const [r, g, b, a] = look.rgba;
    const color = this.C.Color.fromBytes(r, g, b, a);
    const style = STYLES[look.code] ?? "solid";
    const material = style === "dashed" ? this.C.Material.fromType("PolylineDash", { color, dashLength }) : style === "glow" ? this.C.Material.fromType("PolylineGlow", { color, glowPower: 0.28, taperPower: 1 }) : this.C.Material.fromType("Color", { color });
    this.materials.set(key, material);
    return material;
  }
  // Materials outlive a rebuild, so a family cycling through the same few appearances every keyframe
  // builds each of them once. Only the ones still in use, though: with a colour per edge off a
  // colormap the cache would otherwise gain an object per distinct colour for the family's life.
  evictMaterials(inUse) {
    for (const [key, material] of this.materials) {
      if (inUse.has(key)) continue;
      this.materials.delete(key);
      try {
        material.destroy();
      } catch {
      }
    }
  }
  clearLines() {
    const pl = this.lines;
    if (!pl) return;
    for (let i = 0; i < pl.length; i++) {
      pl.get(i)._material = void 0;
    }
    pl.removeAll();
  }
  destroy() {
    this.clearLines();
    if (this.lines) {
      try {
        this.scene.primitives.remove(this.lines);
      } catch {
      }
    }
    this.evictMaterials(/* @__PURE__ */ new Map());
    this.lines = null;
    this.ends = [];
    this.order = [];
    this.drawn = null;
    this.timeline.clear();
  }
};

// primitives/src/sprites.ts
var SIZE = 32;
var cache = /* @__PURE__ */ new Map();
function canvas(draw) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = SIZE;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.lineJoin = "round";
  draw(g, SIZE);
  g.lineWidth = SIZE * 0.1;
  g.strokeStyle = "rgba(0,0,0,0.85)";
  g.stroke();
  return cv;
}
var polygon = (g, points) => {
  g.beginPath();
  points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  g.fill();
};
function regular(sides, r, phase) {
  const c = SIZE / 2;
  return Array.from({ length: sides }, (_, i) => {
    const a = phase + 2 * Math.PI * i / sides;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  });
}
var DRAW = {
  disc: (g, s) => {
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2);
    g.fill();
  },
  star: (g, s) => {
    const R = s * 0.46, r = R * 0.4, c = s / 2;
    polygon(g, Array.from({ length: 10 }, (_, i) => {
      const rad = i % 2 ? r : R;
      const a = Math.PI / 5 * i - Math.PI / 2;
      return [c + rad * Math.cos(a), c + rad * Math.sin(a)];
    }));
  },
  square: (g, s) => polygon(g, regular(4, s * 0.42, Math.PI / 4)),
  triangle: (g, s) => polygon(g, regular(3, s * 0.44, -Math.PI / 2))
};
function markerSprite(marker) {
  if (marker.startsWith("data:")) return marker;
  const stock = marker;
  const draw = DRAW[stock] ?? DRAW.disc;
  const key = DRAW[stock] ? stock : "disc";
  let cv = cache.get(key);
  if (!cv) cache.set(key, cv = canvas(draw));
  return cv;
}

// primitives/src/nodes.ts
var DEFAULT_SIZE = 10;
var NodeFamily = class {
  positions = [];
  billboards = null;
  labels = null;
  timeline;
  n = 0;
  built = "";
  scale;
  scratch;
  kind;
  C;
  scene;
  pickId;
  constructor(kind, C, scene, pickId, timeline) {
    this.kind = kind;
    this.C = C;
    this.scene = scene;
    this.pickId = pickId;
    this.scratch = new C.Color();
    this.timeline = timeline;
  }
  /** Take one window's arrays, rebuilding the collection only when the family's shape changed. */
  onWindow(spec, win) {
    const count = win.count;
    const n = spec.position.shape[spec.position.shape.length - 2] ?? 0;
    const w = {
      n,
      position: knob(spec.position, { itemLen: 3, n, count, what: `${this.kind}.position` }),
      color: knob(spec.color, { itemLen: 4, n, count, what: `${this.kind}.color` }),
      size: knob(spec.size, { itemLen: 1, n, count, what: `${this.kind}.size` }),
      show: knob(spec.show, { itemLen: 1, n, count, what: `${this.kind}.show` })
    };
    const marker = spec.marker ?? "disc";
    const signature = `${n}|${marker}|${spec.scaleByDistance ?? []}|${(spec.label ?? []).join("\0")}`;
    if (signature !== this.built) {
      this.build(n, marker, spec.label, spec.scaleByDistance, w.size?.frame(0) ?? null);
      this.built = signature;
    }
    this.n = n;
    this.timeline.install(w, win);
  }
  /**
   * The collection this family draws through. `size` is the first keyframe's sizes, or null where
   * the window sets none.
   *
   * A billboard is born at the size it will be drawn at, rather than at a placeholder the first
   * keyframe corrects. A raster image would not care — it is uploaded at its own resolution and the
   * quad is scaled — but Cesium rasterizes an SVG at the width and height the billboard carries when
   * the image is assigned, and never again. Born at a placeholder, an SVG marker is a small texture
   * stretched over a larger quad for the rest of its life.
   *
   * Two cases still outgrow their raster, both only for SVG: a `size` that grows over the window,
   * and `scaleByDistance` drawing the marker larger than its base size close up. Give such a family
   * a raster image instead.
   */
  build(n, marker, labels, scaleByDistance, size = null) {
    const { C, scene } = this;
    this.destroyPrimitives();
    this.positions.length = 0;
    this.scale = scaleByDistance && scaleByDistance.length === 4 ? new C.NearFarScalar(scaleByDistance[0], scaleByDistance[1], scaleByDistance[2], scaleByDistance[3]) : void 0;
    const billboards = scene.primitives.add(new C.BillboardCollection({ scene }));
    const image = markerSprite(marker);
    for (let i = 0; i < n; i++) {
      const position = new C.Cartesian3();
      this.positions.push(position);
      const px = size ? at(size, i) : DEFAULT_SIZE;
      billboards.add({
        position,
        image,
        // A stock glyph is white, so the billboard's own colour is what tints it and per-entity
        // colour needs no second image. That tint multiplies a supplied image too, which the default
        // white leaves as it was drawn.
        //
        // `size` writes both width and height, so an image is drawn square whatever its own shape.
        width: px,
        height: px,
        scaleByDistance: this.scale,
        id: this.pickId(this.kind, i)
      });
    }
    this.billboards = billboards;
    if (labels && labels.length) {
      const collection = scene.primitives.add(new C.LabelCollection({ scene }));
      for (let i = 0; i < n; i++) {
        collection.add({
          position: this.positions[i],
          text: labels[i] ?? "",
          font: "13px sans-serif",
          fillColor: C.Color.WHITE,
          outlineColor: C.Color.BLACK,
          outlineWidth: 2,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -14),
          verticalOrigin: C.VerticalOrigin.BOTTOM
        });
      }
      this.labels = collection;
    }
  }
  /** True when this family's positions interpolate rather than stand still for the window. */
  get moving() {
    return this.timeline.latest?.position.keyframed ?? false;
  }
  /** The pick stamp of entity `idx`, for a module drawing something anchored to it. */
  pickIdAt(idx) {
    if (idx < 0 || idx >= this.n) return void 0;
    return this.billboards?.get(idx)?.id;
  }
  /**
   * Whether entity `idx` is drawn. Read off the billboard rather than kept beside it, so what an
   * anchored primitive hides with is the mask this family is actually drawing. A billboard is born
   * shown and takes its first mask at the first keyframe.
   */
  shownAt(idx) {
    if (idx < 0 || idx >= this.n) return void 0;
    return this.billboards?.get(idx)?.show ?? true;
  }
  /** Colour, size and visibility at the keyframe `p` names — attribute writes, never a rebuild. */
  onKeyframe(where) {
    const place = this.timeline.at(where);
    const bb = this.billboards;
    if (!place || !bb) return;
    const { w, k } = place;
    const color = w.color?.frame(k) ?? null;
    const size = w.size?.frame(k) ?? null;
    const show = w.show?.frame(k) ?? null;
    for (let i = 0; i < this.n; i++) {
      const b = bb.get(i);
      b.color = colorOf(this.C, color, i, WHITE, this.scratch);
      const px = size ? at(size, i) : DEFAULT_SIZE;
      b.width = px;
      b.height = px;
      b.show = show ? at(show, i) !== 0 : true;
      if (this.labels) this.labels.get(i).show = b.show;
    }
  }
  /**
   * Blend positions from the keyframe `atA` names toward the one `atB` names — the one knob that
   * interpolates rather than switches. `atB` falls back to `atA` at the run's last frame and for a
   * static family, which have nothing to blend toward.
   */
  onFrame(atA, atB, alpha) {
    const a = this.timeline.at(atA);
    if (!a || !this.billboards) return;
    const b = this.timeline.at(atB) ?? a;
    const pa = a.w.position.frame(a.k);
    const pb = b.w.position.frame(b.k) ?? pa;
    if (!pa || !pb) return;
    const t = 1 - alpha;
    for (let i = 0; i < this.n; i++) {
      const p = this.positions[i];
      p.x = at(pa, i, 0) * t + at(pb, i, 0) * alpha;
      p.y = at(pa, i, 1) * t + at(pb, i, 1) * alpha;
      p.z = at(pa, i, 2) * t + at(pb, i, 2) * alpha;
      this.billboards.get(i).position = p;
      if (this.labels) this.labels.get(i).position = p;
    }
  }
  destroyPrimitives() {
    for (const prim of [this.billboards, this.labels]) {
      if (prim) {
        try {
          this.scene.primitives.remove(prim);
        } catch {
        }
      }
    }
    this.billboards = null;
    this.labels = null;
  }
  destroy() {
    this.destroyPrimitives();
    this.timeline.clear();
    this.built = "";
  }
};

// primitives/src/index.ts
var live = null;
var src_default = {
  setup(ctx) {
    const { Cesium, scene } = ctx;
    const nodes = /* @__PURE__ */ new Map();
    const edges = /* @__PURE__ */ new Map();
    const areas = /* @__PURE__ */ new Map();
    const pickId = (kind, idx) => ctx.pickId(kind, idx);
    const endpoint = (kind) => nodes.get(kind) ?? areas.get(kind);
    const applyKeyframe = (index) => {
      const at2 = ctx.placement(index);
      for (const family2 of nodes.values()) family2.onKeyframe(at2);
      for (const family2 of areas.values()) family2.onKeyframe(at2);
      for (const family2 of edges.values()) family2.onKeyframe(at2);
    };
    const disposables = [
      // One registration answers for every entity this module draws, however many there are: the
      // resolver reads a name on demand and nothing here enumerates what can be ridden.
      ctx.anchors(anchorFor),
      ctx.onWindow((w, payload) => {
        const p = payload ?? {};
        const replace = w.mode === "replace";
        if (replace) {
          prune(nodes, p.nodes);
          prune(edges, p.edges);
          prune(areas, p.areas);
        }
        for (const spec of p.nodes ?? []) {
          family(
            nodes,
            spec.kind,
            () => new NodeFamily(spec.kind, Cesium, scene, pickId, ctx.perWindow())
          ).onWindow(spec, w);
        }
        for (const spec of p.areas ?? []) {
          family(
            areas,
            spec.kind,
            () => new AreaFamily(spec.kind, Cesium, scene, pickId, ctx.perWindow())
          ).onWindow(spec, w);
        }
        for (const spec of p.edges ?? []) {
          family(
            edges,
            spec.kind,
            () => new EdgeFamily(spec.kind, Cesium, scene, endpoint, pickId, ctx.perWindow())
          ).onWindow(spec, w);
        }
      }),
      ctx.onKeyframe(applyKeyframe),
      ctx.onFrame(({ index, alpha }) => {
        const a = ctx.placement(index);
        const b = ctx.placement(index + 1);
        for (const f of nodes.values()) f.onFrame(a, b, alpha);
        for (const f of edges.values()) f.onFrame();
      })
    ];
    live = { endpoint, edges, C: Cesium };
    return () => {
      for (const dispose of disposables) dispose();
      for (const f of nodes.values()) f.destroy();
      for (const f of edges.values()) f.destroy();
      for (const f of areas.values()) f.destroy();
      nodes.clear();
      edges.clear();
      areas.clear();
      live = null;
    };
  }
};
function positionOf(kind, idx) {
  if (!live) return void 0;
  const at2 = live.endpoint(kind)?.positions[idx];
  if (at2) return at2;
  const ends = edgeEndpoints(kind, idx);
  return ends && live.C.Cartesian3.midpoint(ends[0], ends[1], new live.C.Cartesian3());
}
function countOf(kind) {
  return live?.endpoint(kind)?.positions.length;
}
function edgeEndpoints(kind, idx) {
  return live?.edges.get(kind)?.endpointsOf(idx);
}
function pairsOf(kind) {
  return live?.edges.get(kind)?.connectivity();
}
function pickIdOf(kind, idx) {
  return live?.endpoint(kind)?.pickIdAt(idx);
}
function showOf(kind, idx) {
  return live?.endpoint(kind)?.shownAt(idx);
}
function anchorFor(target) {
  const named = /^([^[\]]+)\[(\d+)\]$/.exec(target);
  if (!named) return null;
  const kind = named[1];
  const idx = Number(named[2]) - 1;
  const at2 = () => positionOf(kind, idx) ?? null;
  return idx >= 0 && at2() ? at2 : null;
}
function family(into, kind, make) {
  let one = into.get(kind);
  if (!one) into.set(kind, one = make());
  return one;
}
function prune(from, specs) {
  const named = new Set((specs ?? []).map((s) => s.kind));
  for (const [kind, one] of from) {
    if (named.has(kind)) continue;
    one.destroy();
    from.delete(kind);
  }
}
export {
  countOf,
  src_default as default,
  edgeEndpoints,
  pairsOf,
  pickIdOf,
  positionOf,
  showOf
};
//# sourceMappingURL=primitives.js.map
