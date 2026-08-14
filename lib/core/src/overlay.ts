// Overlay real-estate, arbitrated by the Core (ADR-0004). The Core owns a small set of named,
// positioned regions; a module contributes DOM with `addControl(region, element)` and never
// absolute-positions its own overlay. Controls stack in insertion order within a region, so two
// modules' contributions (e.g. a scene's colorbar and a future heatmap colorbar) sit adjacent
// rather than overlapping. Each addControl returns a Disposable, and the Core drains every region on
// destroy, so a module cannot leak overlay DOM. Pure DOM — no Cesium, so it unit-tests without WebGL.

/**
 * The overlay positions in use today. Every reader of a declared region name checks it against this
 * list. Add a new region when a real layout needs one (ADR-0004).
 */
export const REGIONS = ["top-left", "top-center", "top-right", "bottom-right"] as const;

/** One of the positions the Core arbitrates. The wire carries a name and may carry an unknown one. */
export type OverlayRegion = (typeof REGIONS)[number];

/** The contribution surface a module sees (via `ctx.overlay`): add a control, get a Disposable back. */
export interface OverlayControls {
  /** Append `element` to `region`, stacking after any earlier controls there; returns a remover. */
  addControl(region: OverlayRegion, element: HTMLElement): () => void;
}

export interface Overlay extends OverlayControls {
  /** Lift the `bottom-right` region clear of the band the Core's timeline furniture occupies. */
  setBottomInset(px: number): void;
  /**
   * State every region's declared style as one set: a region absent from `bags` returns to the
   * Core's default. The placement properties are refused and warned about (ADR-0004).
   */
  declareRegionStyles(bags: Partial<Record<OverlayRegion, Record<string, string>>>): void;
  destroy(): void;
}

// Per-region placement. The top-left and top-center regions stack downward; the bottom region stacks
// upward (column-reverse) so later controls grow away from the screen edge. `top-right` is a row
// laid out in reverse, so the first control mounted there — the Core's own furniture group — keeps
// the corner and a module's contribution grows leftward from it.
const REGION_STYLE: Record<OverlayRegion, string> = {
  "top-left": "top:8px;left:8px;flex-direction:column;align-items:flex-start",
  "top-center": "top:8px;left:50%;transform:translateX(-50%);flex-direction:column;align-items:center",
  "top-right": "top:8px;right:8px;flex-direction:row-reverse;align-items:flex-start",
  "bottom-right": "right:8px;flex-direction:column-reverse;align-items:flex-end",
};

/** The band the Core's timeline ruler occupies, which the `bottom-right` region starts clear of. */
const DEFAULT_BOTTOM_INSET = 34;

// The Core owns placement (ADR-0004), so a declared region style may not set any of these.
const PLACEMENT = ["position", "top", "right", "bottom", "left", "transform", "z-index", "inset"];

/**
 * A region's declared CSS with the placement properties removed. A refusal warns, names the
 * property, and drops that property only — the rest of the bag still applies. Keys arrive in CSS
 * spelling (`flex-direction`, not `flex_direction`). The refusal compares the key in lower case,
 * because `setProperty` lowers it too: `Top` and `top` reach the same declaration.
 */
export function scrubRegionStyle(
  region: string,
  bag: Record<string, string>,
  warn: (message: string) => void = console.warn,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [property, value] of Object.entries(bag)) {
    if (PLACEMENT.includes(property.toLowerCase())) {
      warn(`overlay: region ${region} may not set '${property}' — the Core owns placement (ADR-0004)`);
      continue;
    }
    kept[property] = value;
  }
  return kept;
}

/** Create the overlay over `container` (the viewer's DOM parent). Regions are created on first use. */
export function createOverlay(container: HTMLElement): Overlay {
  const regions = new Map<OverlayRegion, HTMLElement>();
  const declared = new Map<OverlayRegion, Record<string, string>>();
  let bottomInset = DEFAULT_BOTTOM_INSET;

  const base = (region: OverlayRegion): string => {
    const placement = region === "bottom-right"
      ? `bottom:${bottomInset}px;${REGION_STYLE[region]}`
      : REGION_STYLE[region];
    return `position:absolute;display:flex;gap:8px;z-index:5;pointer-events:none;${placement}`;
  };

  // A declared bag merges over the base rule one property at a time. Writing it as `cssText` would
  // drop the placement the region depends on.
  const dress = (host: HTMLElement, region: OverlayRegion): void => {
    host.style.cssText = base(region);
    for (const [property, value] of Object.entries(declared.get(region) ?? {})) {
      host.style.setProperty(property, value);
    }
  };

  // A region host shrink-wraps its controls and is itself click-through (pointer-events:none); each
  // control re-enables events, so only the control rectangles capture clicks — the empty gaps between
  // stacked controls never steal a globe drag.
  const ensure = (region: OverlayRegion): HTMLElement => {
    let host = regions.get(region);
    if (!host) {
      host = document.createElement("div");
      container.appendChild(host);
      regions.set(region, host);
      dress(host, region);
    }
    return host;
  };

  return {
    setBottomInset(px) {
      bottomInset = px;
      const host = regions.get("bottom-right");
      if (host) dress(host, "bottom-right");
    },
    declareRegionStyles(bags) {
      declared.clear();
      for (const [region, bag] of Object.entries(bags) as [OverlayRegion, Record<string, string>][]) {
        if (bag) declared.set(region, scrubRegionStyle(region, bag));
      }
      for (const [region, host] of regions) dress(host, region);
    },
    addControl(region, element) {
      const host = ensure(region);
      element.style.pointerEvents = "auto";
      host.appendChild(element);
      return () => element.remove();
    },
    destroy() {
      for (const host of regions.values()) host.remove();
      regions.clear();
    },
  };
}
