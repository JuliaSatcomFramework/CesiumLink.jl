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

// core/src/overlay.ts
var REGIONS = ["top-left", "top-center", "top-right", "bottom-right"];

// ui/src/widgets.ts
var PANEL = "background:rgba(20,24,33,0.78);color:#e6e6e6;font:12px/1.4 system-ui,sans-serif;border-radius:6px;padding:8px 10px;user-select:none;box-shadow:0 1px 4px rgba(0,0,0,0.4)";
function el(tag, style, text) {
  const e = document.createElement(tag);
  e.style.cssText = style;
  if (text != null) e.textContent = text;
  return e;
}
function applyStyle(node, style) {
  if (!style || typeof style !== "object") return;
  for (const [prop, value] of Object.entries(style)) {
    node.style.setProperty(prop, String(value));
  }
}
var str = (v, fallback = "") => typeof v === "string" ? v : fallback;
var num = (v, fallback = 0) => typeof v === "number" ? v : fallback;
function title(spec) {
  const node = el("div", "font-weight:600", str(spec.text));
  const frames = spec.frames;
  if (!frames || typeof frames !== "object") return { el: node };
  return {
    el: node,
    onKeyframe(index) {
      const text = frames[String(index)];
      if (typeof text === "string") node.textContent = text;
    }
  };
}
function legend(spec) {
  const stops = Array.isArray(spec.stops) ? spec.stops : [];
  const wrap = el("div", "display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 8px");
  wrap.append(el("div", "font-size:11px;max-width:92px;text-align:center", str(spec.title)));
  const row = el("div", "display:flex;align-items:stretch;gap:4px;height:110px");
  const ramp = stops.map(([f, c]) => `${str(c, "#000")} ${num(f) * 100}%`).join(",");
  row.append(el("div", `width:12px;border-radius:2px;background:linear-gradient(to top,${ramp})`));
  const labels = el("div", "display:flex;flex-direction:column;justify-content:space-between;font-size:10px");
  labels.append(el("div", "", fmt(num(spec.max))), el("div", "", fmt(num(spec.min))));
  row.append(labels);
  wrap.append(row);
  return { el: wrap };
}
var fmt = (v) => Math.abs(v) >= 100 || v === 0 ? v.toFixed(0) : v.toFixed(1);
var ROW = "display:flex;align-items:center;gap:6px;cursor:pointer";
function toggle(spec, report) {
  const declared = spec.value === true;
  const row = el("label", ROW);
  const box = el("input", "margin:0;cursor:pointer");
  box.type = "checkbox";
  box.checked = declared;
  box.onchange = () => {
    const chosen = box.checked;
    box.checked = declared;
    report(chosen);
  };
  row.append(box, el("span", "", str(spec.label)));
  return { el: row };
}
function select(spec, report) {
  const options = Array.isArray(spec.options) ? spec.options : [];
  const row = el("label", ROW);
  const menu = el("select", "font:inherit;color:inherit;background:rgba(0,0,0,0.35);border:1px solid #555;border-radius:3px;padding:1px 3px;cursor:pointer");
  options.forEach((o, i) => {
    const opt = el("option", "", str(o.label, String(o.value)));
    opt.value = String(i);
    menu.append(opt);
  });
  const declared = String(options.findIndex((o) => o.value === spec.value));
  menu.value = declared;
  menu.onchange = () => {
    const chosen = options[Number(menu.value)];
    menu.value = declared;
    if (chosen) report(chosen.value);
  };
  row.append(el("span", "", str(spec.label)), menu);
  return { el: row };
}
var PASSIVE = { title, legend };
var INTERACTIVE = { toggle, select };
var custom = /* @__PURE__ */ new Map();
function defineWidget(kind, factory) {
  if (kind in PASSIVE || kind in INTERACTIVE) {
    console.warn(`ui: ${kind} is a built-in widget kind; the registration is ignored`);
    return;
  }
  if (custom.has(kind)) {
    console.warn(`ui: widget kind ${kind} is already registered; the registration is ignored`);
    return;
  }
  if (!kind.includes(".")) {
    console.warn(`ui: widget kind ${kind} is not owner-namespaced (e.g. "orbits.${kind}")`);
  }
  custom.set(kind, factory);
}
function clearWidgets() {
  custom.clear();
}
function build(spec, report) {
  const kind = str(spec.kind);
  const passive = PASSIVE[kind];
  if (passive) return passive(spec);
  const interactive = INTERACTIVE[kind];
  if (interactive) return interactive(spec, report);
  const registered = custom.get(kind);
  if (registered) return { el: registered(spec, report) };
  console.warn(`ui: no widget kind ${JSON.stringify(kind)} is registered; row skipped`);
  return null;
}

// ui/src/tooltip.ts
var CHROME = "background:rgba(20,24,33,0.92);color:#e6e6e6;font:12px/1.45 system-ui,sans-serif;border-radius:6px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.5)";
var BOX = "position:absolute;z-index:6;pointer-events:none;max-width:340px";
var GAP = 14;
function place(at, box, bounds, beside = true) {
  const axis = (point, size, limit) => {
    const after = point + GAP;
    const start = !beside ? point : after + size > limit ? point - GAP - size : after;
    return Math.max(0, Math.min(start, Math.max(0, limit - size)));
  };
  return { left: axis(at.x, box.w, bounds.w), top: axis(at.y, box.h, bounds.h) };
}
function createTooltip(container) {
  let box = null;
  let cursor = { x: 0, y: 0 };
  const boxOf = () => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = BOX;
      box.setAttribute("data-ui", "tooltip");
      container.appendChild(box);
    }
    return box;
  };
  const position = () => {
    if (!box || box.style.display === "none") return;
    const p = place(
      cursor,
      { w: box.offsetWidth, h: box.offsetHeight },
      { w: container.clientWidth, h: container.clientHeight }
    );
    box.style.left = `${p.left}px`;
    box.style.top = `${p.top}px`;
  };
  return {
    apply(payload) {
      const p = payload ?? {};
      const fragments = (Array.isArray(p.html) ? p.html : p.html == null ? [] : [p.html]).map((h) => String(h));
      const node = boxOf();
      if (!fragments.length) {
        node.style.display = "none";
        node.replaceChildren();
        return;
      }
      node.style.cssText = BOX + (p.bare === true ? "" : ";" + CHROME);
      node.replaceChildren(...fragments.map(isolate));
      node.style.display = "block";
      position();
    },
    track(at) {
      cursor = { x: at.x, y: at.y };
      position();
    },
    destroy() {
      box?.remove();
      box = null;
    }
  };
}
function isolate(html) {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = html;
  return host;
}

// ui/src/floating.ts
var BOX2 = "position:absolute;z-index:6;pointer-events:auto;max-width:480px";
var CLOSE = "position:absolute;top:1px;right:5px;cursor:pointer;line-height:1;opacity:0.65";
var ADJUSTABLE = "resize:both;overflow:hidden;box-sizing:border-box;max-width:none;min-width:80px;min-height:48px;padding-top:0";
var STRIP_HEIGHT = 16;
var STRIP_GAP = 8;
var STRIP = `position:relative;height:${STRIP_HEIGHT}px;margin:0 -10px ${STRIP_GAP}px;cursor:move;touch-action:none;border-radius:6px 6px 0 0;background:#1b202b`;
var CONTENT = `overflow:auto;scrollbar-color:auto;height:calc(100% - ${STRIP_HEIGHT + STRIP_GAP}px)`;
var CONTENT_SEL = '[data-float] > [data-ui="content"]';
var WEDGE_SEL = "[data-float][data-adjustable]";
var WEDGE = "linear-gradient(315deg,rgba(230,230,230,0.9) 0 30%,transparent 30%)";
var GRIP = [
  "[data-float]::-webkit-resizer{background:transparent}",
  `${WEDGE_SEL}::after{content:"";position:absolute;right:2px;bottom:2px;width:9px;height:9px;pointer-events:none;opacity:0;transition:opacity 90ms linear;background:${WEDGE}}`,
  `${WEDGE_SEL}:hover::after{opacity:1}`,
  `${CONTENT_SEL}::-webkit-scrollbar{width:8px;height:8px}`,
  `${CONTENT_SEL}::-webkit-scrollbar-track{background:transparent}`,
  `${CONTENT_SEL}::-webkit-scrollbar-button{display:none}`,
  `${CONTENT_SEL}::-webkit-scrollbar-corner{background:transparent}`,
  `${CONTENT_SEL}::-webkit-scrollbar-thumb{background:rgba(230,230,230,0.22);border-radius:4px}`,
  `${CONTENT_SEL}::-webkit-scrollbar-thumb:hover{background:rgba(230,230,230,0.38)}`
].join("");
function createFloats(deps) {
  const live = /* @__PURE__ */ new Map();
  const anchorOf = (a) => {
    const kind = a?.anchor;
    return kind === "screen" || kind === "entity" || kind === "world" ? a : null;
  };
  const fragment = (one) => {
    if (one.root) one.root.innerHTML = typeof one.spec.html === "string" ? one.spec.html : "";
  };
  const create = (id, key) => {
    const box = el("div", BOX2);
    box.setAttribute("data-float", id);
    const inner = el("div", "");
    inner.setAttribute("data-ui", "content");
    box.appendChild(inner);
    const one = {
      spec: {},
      json: "",
      key,
      box,
      inner,
      root: null,
      mount: null,
      close: null,
      strip: null,
      anchor: null,
      rect: null
    };
    if (key === "html") {
      one.root = inner.attachShadow({ mode: "open" });
    } else {
      one.mount = mountInto(id, key.slice("mount:".length), inner);
    }
    deps.container.appendChild(box);
    live.set(id, one);
    return one;
  };
  const mountInto = (id, module, inner) => {
    const factory = deps.mountOf(module);
    if (!factory) {
      console.warn(`ui: float ${JSON.stringify(id)} mounts ${JSON.stringify(module)}, which is not a loaded module exporting \`mount\`; the box renders nothing`);
      return null;
    }
    try {
      return factory({ el: inner, id, report: (value) => deps.notify("control", { id, value }) }) ?? null;
    } catch (err) {
      console.warn(`ui: float ${JSON.stringify(id)} failed to mount ${JSON.stringify(module)}: ${err}`);
      return null;
    }
  };
  const dress = (id, one) => {
    const adjustable = one.spec.adjustable === true;
    one.box.style.cssText = BOX2 + ";" + PANEL + (adjustable ? ";" + ADJUSTABLE : one.spec.closable === true ? ";padding-right:20px" : "");
    one.inner.style.cssText = adjustable ? CONTENT : "";
    one.box.toggleAttribute("data-adjustable", adjustable);
    applyStyle(one.box, one.spec.style);
    one.anchor = anchorOf(one.spec.anchor);
    fragment(one);
    if (adjustable) sheet();
    handles(id, one, adjustable);
    keep(one);
  };
  const handles = (id, one, adjustable) => {
    one.strip?.remove();
    one.close?.remove();
    one.strip = null;
    one.close = null;
    if (adjustable) {
      one.strip = el("div", STRIP);
      one.strip.setAttribute("data-ui", "drag");
      one.strip.onpointerdown = (e) => drag(id, one, e);
      one.box.prepend(one.strip);
      watch(id, one);
    } else {
      one.box.onpointerdown = null;
      one.box.onpointerup = null;
    }
    if (one.spec.closable === true) {
      const x = el("div", CLOSE, "\xD7");
      x.onpointerdown = (e) => e.stopPropagation();
      x.onclick = () => deps.notify("close", { id });
      (one.strip ?? one.box).appendChild(x);
      one.close = x;
    }
  };
  const px = (v) => Math.round(parseFloat(v) || 0);
  const rectOf = (box) => ({
    x: px(box.style.left),
    y: px(box.style.top),
    w: Math.round(box.offsetWidth),
    h: Math.round(box.offsetHeight)
  });
  const settle = (id, one) => {
    one.rect = rectOf(one.box);
    deps.notify("rect", { id, ...one.rect });
  };
  const keep = (one) => {
    if (!one.rect) return;
    one.anchor = { anchor: "screen", x: one.rect.x, y: one.rect.y };
    one.box.style.width = `${one.rect.w}px`;
    one.box.style.height = `${one.rect.h}px`;
  };
  const drag = (id, one, e) => {
    e.stopPropagation();
    e.preventDefault();
    const strip = one.strip;
    const box = one.box;
    const from = { x: e.clientX, y: e.clientY };
    const at = { x: px(box.style.left), y: px(box.style.top) };
    let moved = false;
    strip.setPointerCapture(e.pointerId);
    strip.onpointermove = (m) => {
      moved = true;
      const to = place(
        { x: at.x + m.clientX - from.x, y: at.y + m.clientY - from.y },
        { w: box.offsetWidth, h: box.offsetHeight },
        { w: deps.container.clientWidth, h: deps.container.clientHeight },
        false
      );
      one.anchor = { anchor: "screen", x: to.left, y: to.top };
      box.style.left = `${to.left}px`;
      box.style.top = `${to.top}px`;
    };
    strip.onpointerup = (u) => {
      strip.onpointermove = null;
      strip.onpointerup = null;
      strip.releasePointerCapture(u.pointerId);
      if (moved) settle(id, one);
    };
  };
  const watch = (id, one) => {
    let before = null;
    one.box.onpointerdown = () => {
      before = rectOf(one.box);
    };
    one.box.onpointerup = () => {
      const now = rectOf(one.box);
      if (before && (now.w !== before.w || now.h !== before.h)) settle(id, one);
      before = null;
    };
  };
  let grip = null;
  const sheet = () => {
    if (grip) return;
    grip = el("style", "");
    grip.textContent = GRIP;
    deps.container.appendChild(grip);
  };
  const drop = (id, one) => {
    try {
      one.mount?.dispose?.();
    } catch (err) {
      console.warn(`ui: float ${JSON.stringify(id)} threw while disposing its mount: ${err}`);
    }
    one.box.remove();
    live.delete(id);
  };
  const reposition = () => {
    for (const one of live.values()) {
      const at = one.anchor && deps.screenOf(one.anchor);
      if (!at) {
        one.box.style.display = "none";
        continue;
      }
      one.box.style.display = "block";
      const beside = one.anchor?.anchor !== "screen";
      const p = place(
        at,
        { w: one.box.offsetWidth, h: one.box.offsetHeight },
        { w: deps.container.clientWidth, h: deps.container.clientHeight },
        beside
      );
      one.box.style.left = `${p.left}px`;
      one.box.style.top = `${p.top}px`;
    }
  };
  return {
    declare(payload) {
      const specs = Array.isArray(payload) ? payload : [];
      const declared = /* @__PURE__ */ new Set();
      const dressed = [];
      for (const spec of specs) {
        if (spec?.id == null) {
          console.warn("ui: a float declares no id, so nothing can address it; skipped");
          continue;
        }
        const id = String(spec.id);
        if (declared.has(id)) {
          console.warn(`ui: float ${JSON.stringify(id)} is declared twice; the second is ignored`);
          continue;
        }
        declared.add(id);
        const json = JSON.stringify(spec);
        const key = spec.mount == null ? "html" : `mount:${String(spec.mount)}`;
        const prev = live.get(id);
        if (prev && prev.json === json) continue;
        if (prev && prev.key !== key) drop(id, prev);
        const one = live.get(id) ?? create(id, key);
        one.spec = spec;
        one.json = json;
        dress(id, one);
        dressed.push(one);
      }
      for (const [id, one] of [...live]) {
        if (!declared.has(id)) drop(id, one);
      }
      reposition();
      for (const one of dressed) one.mount?.resize?.();
    },
    tracks() {
      const out = [];
      for (const [id, one] of live) {
        const named = (Array.isArray(one.spec.keyframed) ? one.spec.keyframed : []).filter((f) => typeof f === "string");
        if (!named.length) continue;
        out.push({ id, fields: new Set(named), spec: one.spec, show: () => fragment(one) });
      }
      return out;
    },
    reposition,
    destroy() {
      for (const [id, one] of [...live]) drop(id, one);
      grip?.remove();
      grip = null;
    }
  };
}

// ui/src/index.ts
var GROUP = PANEL + ";display:flex;flex-direction:column;gap:6px";
function trackOf(spec, show) {
  const named = (Array.isArray(spec.keyframed) ? spec.keyframed : []).filter((f) => typeof f === "string");
  if (!named.length) return null;
  if (spec.id == null) {
    console.warn(`ui: ${JSON.stringify(spec.kind)} declares keyframed fields but no id, so no window can address it`);
    return null;
  }
  return { id: String(spec.id), fields: new Set(named), spec, show };
}
function valueAt(track, k, count) {
  if (Array.isArray(track)) return track[k];
  if (!isNdArray(track)) return void 0;
  const block = blockAt(track, k, 0, count);
  return block ? track.data[block.offset] : void 0;
}
function project(ctx, world) {
  const at = ctx.Cesium?.SceneTransforms?.worldToWindowCoordinates(ctx.scene, world);
  return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null;
}
function screenOf(ctx, a) {
  if (a.anchor === "screen") return { x: a.x, y: a.y };
  if (a.anchor === "world") {
    const C = ctx.Cesium;
    return C ? project(ctx, C.Cartesian3.fromDegrees(a.lon, a.lat, a.height)) : null;
  }
  const owner = ctx.modules.get(a.module);
  const at = owner?.positionOf?.(a.kind, a.idx);
  return at ? project(ctx, at) : null;
}
var src_default = {
  setup(ctx) {
    const tooltip = createTooltip(ctx.container);
    const floats = createFloats({
      container: ctx.container,
      screenOf: (a) => screenOf(ctx, a),
      // A module named by a float but never declared has nothing to hand over, and the float says
      // so and renders nothing. One declared either side of `ui` is reached the same way.
      mountOf: (id) => {
        const mount2 = ctx.modules.get(id)?.mount;
        return typeof mount2 === "function" ? mount2 : null;
      },
      notify: (topic, payload) => ctx.notify(topic, payload)
    });
    let live = [];
    const held = ctx.perWindow();
    const clear = () => {
      for (const row of live) row.dispose?.();
      live = [];
    };
    const apply = (index) => {
      const at = ctx.placement(index);
      const win = held.at(at)?.w;
      if (!at || !win) return;
      for (const [id, fields] of Object.entries(win.per_keyframe ?? {})) {
        const track = [...live.flatMap((row) => row.tracks), ...floats.tracks()].find((t) => t.id === id);
        if (!track) continue;
        let changed = false;
        for (const [field, values] of Object.entries(fields ?? {})) {
          if (!track.fields.has(field)) continue;
          const value = valueAt(values, at.k, at.window.count);
          if (value == null || Object.is(value, track.spec[field])) continue;
          track.spec[field] = value;
          changed = true;
        }
        if (changed) track.show(index);
      }
    };
    const applyNow = () => {
      const index = ctx.frame?.index ?? null;
      if (index !== null) apply(index);
    };
    const widgetOf = (spec, chrome) => {
      let widget;
      try {
        widget = build(spec, (value) => ctx.notify("control", { id: spec.id, value }));
      } catch (err) {
        console.warn(`ui: widget ${JSON.stringify(spec.kind)} failed to build: ${err}`);
        return null;
      }
      if (!widget) return null;
      if (chrome) widget.el.style.cssText = PANEL + ";" + widget.el.style.cssText;
      applyStyle(widget.el, spec.style);
      return widget;
    };
    const groupOf = (spec) => {
      const children = Array.isArray(spec.controls) ? spec.controls : [];
      const built = [];
      const tracks = [];
      for (const child of children) {
        const own = { ...child };
        const widget = widgetOf(own, false);
        if (!widget) continue;
        const at = built.length;
        built.push(widget);
        const track = trackOf(own, (index) => {
          const next = widgetOf(own, false);
          if (!next) return;
          built[at].el.replaceWith(next.el);
          built[at] = next;
          next.onKeyframe?.(index);
        });
        if (track) tracks.push(track);
      }
      if (!built.length) return null;
      const box = el("div", GROUP);
      box.append(...built.map((w) => w.el));
      applyStyle(box, spec.style);
      return {
        widget: { el: box, onKeyframe: (i) => {
          for (const w of built) w.onKeyframe?.(i);
        } },
        tracks
      };
    };
    const buildRow = (spec) => {
      if (spec.kind === "group") return groupOf(spec);
      const widget = widgetOf(spec, true);
      return widget === null ? null : { widget, tracks: [] };
    };
    const mount = (widget, region, index, anchor) => {
      if (index !== null) widget.onKeyframe?.(index);
      const dispose = ctx.overlay.addControl(region, widget.el);
      anchor?.replaceWith(widget.el);
      return { el: widget.el, dispose, onKeyframe: widget.onKeyframe };
    };
    const rowOf = (r, built, index, anchor) => {
      const row = {
        ...mount(built.widget, r.region, index, anchor),
        key: r.key,
        json: r.json,
        tracks: []
      };
      row.tracks = tracksOf(row, r, built);
      return row;
    };
    const rebuild = (row, r, index) => {
      const built = buildRow(r.spec);
      if (!built) return;
      const dispose = row.dispose;
      Object.assign(row, mount(built.widget, r.region, index, row.el));
      row.tracks = tracksOf(row, r, built);
      dispose?.();
    };
    const tracksOf = (row, r, built) => {
      const own = trackOf(r.spec, (index) => rebuild(row, r, index));
      return own === null ? built.tracks : [own, ...built.tracks];
    };
    const declare = (payload) => {
      const index = ctx.frame?.index ?? null;
      const rows = (Array.isArray(payload) ? payload : []).map((spec) => {
        const region = REGIONS.includes(spec.region) ? spec.region : "top-left";
        return {
          spec: { ...spec },
          region,
          key: JSON.stringify([spec.kind, spec.id ?? null, region]),
          json: JSON.stringify(spec)
        };
      });
      const aligned = rows.length === live.length && rows.every((r, i) => r.key === live[i].key);
      if (aligned) {
        const swaps = rows.map((r, i) => r.json === live[i].json ? null : { i, built: buildRow(r.spec) });
        if (swaps.every((s) => s === null || s.built !== null === (live[s.i].el !== null))) {
          const next = live.slice();
          for (const swap of swaps) {
            if (!swap) continue;
            const old = live[swap.i];
            const r = rows[swap.i];
            next[swap.i] = swap.built === null ? { key: r.key, json: r.json, el: null, dispose: null, tracks: [] } : rowOf(r, swap.built, index, old.el);
            old.dispose?.();
          }
          live = next;
          applyNow();
          return;
        }
      }
      clear();
      live = rows.map((r) => {
        const built = buildRow(r.spec);
        return built === null ? { key: r.key, json: r.json, el: null, dispose: null, tracks: [] } : rowOf(r, built, index, null);
      });
      applyNow();
    };
    let onCanvas = true;
    const enter = () => {
      onCanvas = true;
    };
    const leave = () => {
      onCanvas = false;
      tooltip.apply({ html: null });
    };
    ctx.scene.canvas.addEventListener("mouseenter", enter);
    ctx.scene.canvas.addEventListener("mouseleave", leave);
    const disposables = [
      ctx.onCommand("declare", declare),
      ctx.onCommand("floating", (payload) => {
        floats.declare(payload);
        applyNow();
      }),
      ctx.onCommand("tooltip", (payload) => tooltip.apply(onCanvas ? payload : { html: null })),
      ctx.onWindow((w, payload) => held.install(payload ?? {}, w)),
      ctx.onKeyframe((index) => {
        for (const row of live) row.onKeyframe?.(index);
        apply(index);
      }),
      // An anchored float is re-projected every tick, so it rides the entity it names as the
      // positions interpolate and as the camera moves, with nothing asked of the server.
      ctx.onFrame(() => floats.reposition()),
      // Local dispatch: the box follows the cursor at frame rate, with nothing asked of the server.
      ctx.onPointer((e) => tooltip.track(e.screen)),
      () => {
        ctx.scene.canvas.removeEventListener("mouseenter", enter);
        ctx.scene.canvas.removeEventListener("mouseleave", leave);
      }
    ];
    return () => {
      for (const dispose of disposables) dispose();
      clear();
      clearWidgets();
      floats.destroy();
      tooltip.destroy();
    };
  }
};
export {
  src_default as default,
  defineWidget
};
//# sourceMappingURL=ui.js.map
