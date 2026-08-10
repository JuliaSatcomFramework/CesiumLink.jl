---
status: accepted
---

# The server decides what the scene shows; the viewer reports input

A control does not change the scene. It reports that the user operated it, and the server answers
with a replacement window whose contents already reflect the decision. Filtering, selection and
derived visibility live in the Julia half; the viewer renders what it is given.

Two things follow. *What* controls exist is declared over the wire — the payload carries a control
list and the `ui` module builds generic widgets from it — so adding a filter is a Julia-only change.
And the viewer keeps no visibility state: there is no per-family toggle mutating `.show`, no
per-line reveal, and nothing to reconcile after a window is replaced.

The same authority covers everything the viewer displays, not only what the globe draws. Titles and
legends are declared alongside controls in one overlay list (ADR-0004), tooltip content is authored
server-side (ADR-0010), and every colour in the scene is computed server-side from a colormap the
server also uses to declare the matching legend — so a bar cannot describe a ramp the entities were
not drawn with.

A widget kind beyond the built-in set ships as a module (ADR-0009) that registers the kind at setup,
under an owner-namespaced name. Markup delivered as strings is a supported path for **content**, not
for behaviour: a tooltip fragment carries markup and CSS, both of which apply under the VSCode
webview's content security policy, and `innerHTML` does not execute `<script>`. Anything that needs
to run is a module, imported dynamically and served same-origin.

This extends ADR-0004 rather than replacing it: the Core arbitrates overlay placement, and a
server-declared control is contributed through `ctx.overlay.addControl` like any other.

## Considered options

- **Server-authoritative, server-declared controls** (chosen).
- **Server-authoritative, viewer-declared controls.** The toggle set stays hardcoded and only its
  effect moves. Rejected: every new filter then needs a TypeScript edit and a rebuild, which
  forfeits the point — the filters that motivate this, such as restricting to one constellation
  shell or to satellites over a region, are exactly the ones nobody wants to hardcode.
- **Viewer-authoritative with per-entity class tags.** Ship classification over the wire and let the
  viewer filter locally. Rejected: it needs a tag encoding, a filter-composition rule and a
  derived-visibility pass in the viewer, and it still cannot express a filter that changes *derived*
  values — restricting the satellite set makes cells genuinely unserved, and no visibility mask
  expresses that.

## Consequences

Draw calls scale with what is **sent**, not with what is shown, which is the only thing that
actually helps: a hidden polyline still occupies its vertex buffer, its draw command and its vertex
transform, and only its fragments are skipped.

The click path reaches re-derivation and stops. It re-runs extraction and aggregation over retained
per-frame results, never the simulator, which bounds its latency to array work. It also means the
server retains each buffered frame's output, so buffer depth is bounded by memory and not only by
production rate.

**The clock is not held for the answer.** Playback runs on through the round trip and the scene
changes when the replacement window installs — a `replace`, which clears the buffer and re-bases the
clock on what it delivers. The viewer therefore renders the superseded state for the length of the
trip, which on loopback is a few milliseconds. The only thing that stops the clock is a buffer that
does not reach the current instant, which lifts as soon as a window covers it. Holding the clock for
a control round trip is a change to this consequence, not to the decision above it.

The viewer carries no per-family or per-line visibility toggling, no per-satellite link grouping,
and no visibility carry-over across link rebuilds. Their absence is the point: visibility with three
competing writers has no single owner.
