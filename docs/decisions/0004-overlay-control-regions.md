---
status: accepted
---

# Overlay DOM is arbitrated by Core-owned control regions

The Core owns named overlay regions, which are screen positions. A module contributes DOM through
`ctx.overlay.addControl(region, element)`, which returns a Disposable. The Core stacks the controls
of one region in insertion order, so two contributions — the generic renderer's colorbar and the
heatmap's colorbar, say — sit adjacent rather than overlapping. A module never absolute-positions
its own overlay DOM. The title, the legend and the colorbar panels are controls like any other.

This is the Leaflet `Control` model, minimally applied: the only battle-tested overlay-real-estate
design the research found.

What sits in the regions is declared. One ordered list from the server describes the whole overlay —
titles, legends and controls alike — and re-declaring replaces it, so removing a legend means
declaring the list without it. Julia owns composition order; the Core owns placement, and a declared
control is contributed through `addControl` like any other.

## A region's style is declared, its placement is not

The server may state a region's style, because a layout demanded it: a colorbar beside the Core's
own buttons rather than under them makes `top-right` a row.

The Core owning placement is enforced rather than merely written. A declaration merges a CSS bag
over the Core's default for a region, and the Core **refuses** the eight properties that would move
one — `position`, `top`, `right`, `bottom`, `left`, `transform`, `z-index`, `inset` — warning and
naming the property it dropped. Direction, gap, wrapping, alignment and sizing belong to the author;
where the region sits does not. Without the refusal this becomes the option rejected below:
hand-tuned absolute positions, and two colorbars free to collide again.

## Considered options

- **Core-arbitrated control regions** (chosen).
- **Uncoordinated absolute-positioned divs.** Rejected: two colorbars collide unless authors
  hand-tune positions by convention. Giving each module a bare container does not solve placement,
  it relocates the conflict.

## Consequences

The regions are the ones layouts actually ask for, with insertion-order stacking. A full corner set
arrives when a real layout demands it.

Each control is a Disposable the Core drains on module teardown, so a module cannot leak overlay
DOM.

A region host is click-through, and each control re-enables pointer events on itself. Without that,
the gaps between stacked controls swallow a globe drag.

The Core contributes its own **furniture** to a region through `addControl`, like any other
contributor and with no privileged path — which is what stops it painting under a module's controls
(ADR-0015).
