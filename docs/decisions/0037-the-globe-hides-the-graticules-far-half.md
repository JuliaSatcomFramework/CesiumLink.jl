---
status: accepted
---

# The globe hides the graticule's far half

The Core drew no meridians and parallels, so every scene that wanted them built them itself. One
downstream package built them twice — once as imagery bands baked into a raster, once as polylines
through the `primitives` vocabulary. The question that decides whether a graticule reads is **what
happens to the half of it that is behind the globe.**

With `Globe.depthTestAgainstTerrain` off, which is Cesium's default, Cesium clears the globe's depth
and then draws a depth plane in 3-D: an invisible quad across the limb disc, written to the depth
buffer only. A line or a point behind the globe is behind that plane, so it is hidden. A label is
different. It is a billboard, a flat picture that faces the camera, and the part of it that sticks
out past the edge of the disc has no depth plane in front of it. A label anchored behind the limb
shows its letters in the black beside the globe.

## Decision

**The graticule is a Core declaration. The viewer draws its lines whole and hides its labels by the
limb test.**

**It is the Core's, not a module's.** `declare_graticule` sits beside `declare_furniture` and
`declare_regions`: a retained `core/graticule` command, restated whole on every call, replayed to a
browser that connects later. Nothing about meridians and parallels is domain vocabulary, and a
graticule must exist in a session that declares no modules at all — the same test that puts the
furniture and the annotation layers in the Core (ADR-0036). **Off is a state, not an absence**: a
session that never declared a graticule and one whose reader turned it off differ, because the
second is retained and comes back.

**The lines are drawn whole, and the globe hides their far half.** Each line is one polyline, cut
into vertices at 3° of arc scaled by the square root of the cosine of its latitude, so the chord
error is the same on every line. The viewer builds them once per declaration and does not touch
them when the camera moves. In 3-D the depth plane hides the far half with the depth setting off,
and the globe's own tiles hide it with the setting on.

**A label is hidden by the limb test.** Before each frame the viewer evaluates
`behindGlobe(lon, lat, eye)`, the test `annotations.ts` uses for the place names, at each label
anchor, and hides the labels behind the globe. A graticule has a few dozen labels, so the test runs
on every frame with no threshold. 2-D and Columbus view have no far side and show every label.

**The depth setting is exposed separately, for the scenes that need it for their own primitives.**
`declare_globe_depth` is its own retained declaration. The graticule does not need it.

## Consequences

A scene gets a graticule in one call and needs no browser module of its own for it.

With `declare_globe_depth` on, Cesium draws no depth plane and the globe's tiles do the hiding, so a
line over a tile that has not loaded yet shows through until the tile arrives. This is most visible
right after a scene-mode morph, which redraws every tile.

`declare_globe_depth` restores the value the widget was built with when a scene turns it off, and
the Core asserts the flag again before each frame: Cesium's own base-layer picker writes it whenever
a terrain provider is chosen, and a morph rebuilds enough of the scene to be worth distrusting.

## Alternatives declined

**Cutting each line to the runs on the camera's side, on each camera move.** This duplicates the
depth plane: a headless Chrome check draws the same frame with the cut and without it. It also
needs a pool of polylines, because a Cesium `Polyline` destroys its material as it leaves its
collection, and a camera threshold to limit how often the lines are rebuilt.

**Ground polylines.** `GroundPolylinePrimitive` is draped and screen-space wide, which is both halves
of what a graticule wants. It builds in a geometry worker that first fetches
`Assets/approximateTerrainHeights.json`, and that worker keeps a failed fetch for good: every later
line fails with it, and the failure is a bare object thrown from the render loop, which stops the
globe. A VSCode webview answers that fetch with 408 when its resource pipe is slow. ADR-0036 already
records the country borders being moved off ground polylines for exactly this.

**Imagery.** Hidden on the far side for free and wrong for the rest: ground-space width that
thickens on zoom, and labels painted at the resolution of the texels.

**One primitive per segment.** What the downstream polyline implementation did, through the `Edges`
vocabulary, because an edge is a pair. It is 2,718 primitives for a 20°/10° graticule and 7,620 for
5°/5°, against 35 and 107 for one polyline per line, and it made the scene answer the camera more
slowly.
