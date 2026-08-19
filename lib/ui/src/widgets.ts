// The widget registry: the four built-in kinds, and whatever a module adds at setup. Nothing here
// knows what a control means — a widget shows the value the server declared and reports what the
// user chose, so which filters exist is a Julia-only decision.
//
// Pure DOM, no Cesium, so the registry and every built-in kind unit-test without WebGL.

/** What a factory builds: the element, plus an optional reaction to a keyframe crossing. */
export interface Widget {
  el: HTMLElement;
  /** Called on every crossing into an absolute keyframe index while this widget is on screen. */
  onKeyframe?(index: number): void;
}

/** One declared row of the overlay list: its kind, its region, and the kind's own fields. */
export interface WidgetSpec {
  kind?: unknown;
  region?: unknown;
  [field: string]: unknown;
}

/** What an interactive widget calls with the value the user chose. */
export type Report = (value: unknown) => void;

/**
 * A declared item that named keyframed fields, and how to show a new value for one. The declaration
 * is the only source of structure: an entry may supply the fields the declaration named and no
 * others. Widgets and floating objects share one id space, since one window's `per_keyframe`
 * entries address both.
 */
export interface Track {
  /** The declared id a window's `per_keyframe` entry addresses this item by. */
  id: string;
  fields: Set<string>;
  /** The declared spec, with the latest value each keyframed field took written into it. */
  spec: Record<string, unknown>;
  /** Show what `spec` now says, for the absolute keyframe just crossed into. */
  show(index: number): void;
}

/** A registered kind. Passive kinds are handed no `report` and so cannot send anything upward. */
type WidgetFactory = (spec: WidgetSpec, report: Report) => HTMLElement;

// One surface for every panel, so the title, the legends and the control panel read as one overlay
// rather than as several modules that happen to share a screen. It is worn by whoever *mounts* a
// widget, not by the widget itself: a top-level row gets one box of its own, and the children of a
// group get the group's box instead of one each.
export const PANEL =
  "background:rgba(20,24,33,0.78);color:#e6e6e6;" +
  "font:12px/1.4 system-ui,sans-serif;border-radius:6px;padding:8px 10px;" +
  "user-select:none;box-shadow:0 1px 4px rgba(0,0,0,0.4)";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = style;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Merge a declared `style` over the defaults already on `node`, one property at a time. Per-property
 * rather than `cssText`, which would either clobber the chrome it merges into or have to be
 * concatenated — and a stray `}` in a concatenated string breaks out of the rule.
 */
export function applyStyle(node: HTMLElement, style: unknown): void {
  if (!style || typeof style !== "object") return;
  for (const [prop, value] of Object.entries(style as Record<string, unknown>)) {
    node.style.setProperty(prop, String(value));
  }
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

/**
 * A title: one string, or text keyed by **absolute keyframe index** which the module selects on each
 * crossing. That selection is the one value the viewer picks locally — a per-frame title through the
 * server would be a round trip per keyframe.
 */
export function title(spec: WidgetSpec): Widget {
  const node = el("div", "font-weight:600", str(spec.text));
  const frames = spec.frames as Record<string, string> | undefined;
  if (!frames || typeof frames !== "object") return { el: node };
  return {
    el: node,
    onKeyframe(index) {
      const text = frames[String(index)];
      // A keyframe the declaration says nothing about keeps the text it had, so a title declared
      // only where it changes reads correctly in between.
      if (typeof text === "string") node.textContent = text;
    },
  };
}

/**
 * A colorbar: the gradient of a colormap between two values, drawn bottom-to-top from stops the
 * server sampled out of the same colormap value that coloured the entities.
 */
export function legend(spec: WidgetSpec): Widget {
  const stops = (Array.isArray(spec.stops) ? spec.stops : []) as [number, string][];
  const wrap = el("div", "display:flex;flex-direction:column;align-items:center;" +
    "gap:4px;padding:6px 8px");
  wrap.append(el("div", "font-size:11px;max-width:92px;text-align:center", str(spec.title)));
  const row = el("div", "display:flex;align-items:stretch;gap:4px;height:110px");
  // A CSS gradient rather than a canvas: the stops are already fractions of the bar, and `to top`
  // puts fraction 0 at the bottom where the minimum label is.
  const ramp = stops.map(([f, c]) => `${str(c, "#000")} ${num(f) * 100}%`).join(",");
  row.append(el("div", `width:12px;border-radius:2px;background:linear-gradient(to top,${ramp})`));
  const labels = el("div", "display:flex;flex-direction:column;justify-content:space-between;" +
    "font-size:10px");
  labels.append(el("div", "", fmt(num(spec.max))), el("div", "", fmt(num(spec.min))));
  row.append(labels);
  wrap.append(row);
  return { el: wrap };
}

const fmt = (v: number) => (Math.abs(v) >= 100 || v === 0 ? v.toFixed(0) : v.toFixed(1));

const ROW = "display:flex;align-items:center;gap:6px;cursor:pointer";

/** A checkbox. Reports the box the user clicked and immediately shows the declared value again. */
export function toggle(spec: WidgetSpec, report: Report): Widget {
  const declared = spec.value === true;
  const row = el("label", ROW);
  const box = el("input", "margin:0;cursor:pointer");
  box.type = "checkbox";
  box.checked = declared;
  box.onchange = () => {
    const chosen = box.checked;
    // Snap back to the declared value: the scene changes only when the server says so, and it
    // re-declares the overlay either way, so a value nothing applied never lingers on screen.
    box.checked = declared;
    report(chosen);
  };
  row.append(box, el("span", "", str(spec.label)));
  return { el: row };
}

/** A dropdown over the declared options. Reports the option chosen, then shows the declared one. */
export function select(spec: WidgetSpec, report: Report): Widget {
  const options = (Array.isArray(spec.options) ? spec.options : []) as
    { value: unknown; label: unknown }[];
  const row = el("label", ROW);
  const menu = el("select", "font:inherit;color:inherit;background:rgba(0,0,0,0.35);" +
    "border:1px solid #555;border-radius:3px;padding:1px 3px;cursor:pointer");
  // An option's DOM value is its index, so a declared value that is not a string — a shell number,
  // say — is reported back as itself rather than as its stringified form.
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

/** The passive built-ins get no `report`, so they physically cannot send anything upward. */
const PASSIVE: Record<string, (spec: WidgetSpec) => Widget> = { title, legend };
const INTERACTIVE: Record<string, (spec: WidgetSpec, report: Report) => Widget> = { toggle, select };

// Kinds registered by other modules, under owner-namespaced names. Module-level, like the registry
// of any other single-instance-per-page module: one viewer holds one `ui`.
const custom = new Map<string, WidgetFactory>();

/**
 * Register a further widget kind, from another module's `setup`. `kind` is owner-namespaced
 * (`orbits.shell-picker`) so two modules cannot collide; a built-in name is refused, since replacing
 * one would change what every declaration of it means.
 */
export function defineWidget(kind: string, factory: WidgetFactory): void {
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

/**
 * Drop every registered custom kind. Called when `ui` unloads: the modules that registered them are
 * unloaded alongside it, and their factories close over a context that no longer exists.
 */
export function clearWidgets(): void {
  custom.clear();
}

/**
 * Build the widget a declared row asks for, or `null` when no one registered that kind — the row is
 * then skipped and the rest of the panel still renders.
 */
export function build(spec: WidgetSpec, report: Report): Widget | null {
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
