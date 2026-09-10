---
status: accepted
---

# A graticule hides its own far half

The Core drew no meridians and parallels, so every scene that wanted them built them itself. One
downstream package built them twice — once as imagery bands baked into a raster, once as polylines
through the `primitives` vocabulary — and neither could answer the question that decides whether a
graticule reads: **what happens to the half of it the globe stands in front of.**

Cesium leaves `Globe.depthTestAgainstTerrain` off, so a primitive over the globe is drawn whether the
Earth is between it and the camera or not. A scene drawing a graticule as geometry therefore draws
the far side of every line and every label through the planet: a reader looking at Europe reads
`40°W` written across Asia. Nothing in the Julia API reached the setting, so the downstream package
shipped a browser module of its own whose whole content was flipping one boolean.

The imagery route avoids that — a texture draped on the globe is occluded by construction — and pays
for it twice over: the lines take a width on the ground rather than on the screen, so they thicken as
the camera comes in, and the labels are painted into the picture at whatever size the texels give.

## Decision

**The graticule is a Core declaration, and it hides its own far half.**

Two parts, and the second is the one worth recording.

**It is the Core's, not a module's.** `declare_graticule` sits beside `declare_furniture` and
`declare_regions`: a retained `core/graticule` command, restated whole on every call, replayed to a
browser that connects later. Nothing about meridians and parallels is domain vocabulary, and a
graticule must exist in a session that declares no modules at all — the same test that puts the
furniture and the annotation layers in the Core (ADR-0036). **Off is a state, not an absence**: a
session that never declared a graticule and one whose reader turned it off differ, because the second
is retained and comes back.

**Occlusion is the graticule's own, by the limb test rather than by the depth buffer.** Every line is
cut into vertices — at 3° of arc, scaled by the square root of the cosine of its latitude, so a
parallel near a pole spends fewer vertices than the equator for the same chord error. On each camera
step the viewer evaluates `behindGlobe(lon, lat, eye)` at every vertex, the test `annotations.ts`
already uses to keep a place name off the far side, and draws one polyline per contiguous run that
passes. A label is hidden by the same test.

The lines and their labels therefore stop at the limb whatever the depth setting says, and the answer
is a property of geometry rather than of what the GPU happens to have drawn. Only a globe has a far
side, so 2-D and Columbus view get the whole graticule, which is what a flat map should show.

**The depth setting is exposed separately, for the scenes that need it for their own primitives.**
`declare_globe_depth` is its own retained declaration. A scene drawing a network of nodes and edges
above the globe still wants it; the graticule does not, and does not ask for it.

## Consequences

A scene gets a graticule in one call and needs no browser module of its own for it. The downstream
package's `globe-depth.js` and both of its graticule builders are replaceable.

A graticule is correct the moment the camera moves. It does not wait for a tile: with
`depthTestAgainstTerrain` on, Cesium draws no depth plane, so occlusion comes from the globe tiles
actually drawn and a line over a tile still loading shows through until it arrives — most visible
right after a scene-mode morph, which redraws every tile.

The cut costs one dot product per vertex per camera step, guarded so it runs only when the camera has
turned a quarter degree or changed range by a hundredth. A 20°/10° graticule is 35 lines and about
2,700 vertices; 5°/5° is 107 lines and about 7,600. Both are a fraction of a millisecond, and neither
touches the GPU unless the runs changed.

The polylines are written over rather than replaced. A Cesium `Polyline` destroys its own material as
it leaves the collection, so a cut that cleared the collection could not share one material between
lines — and a material per run per camera step is the alternative cost. The pool keeps whatever the
widest view needed and hides the surplus.

`declare_globe_depth` restores the value the widget was built with when a scene turns it off, and the
Core asserts the flag again before each frame: Cesium's own terrain picker writes it whenever a
terrain provider is chosen, and a morph rebuilds enough of the scene to be worth distrusting.

## Alternatives declined

**The scene-wide depth setting alone.** It is one boolean against a per-line test, so it looked like
the lazier answer, and it is worse on three counts. It is bypassed in 2-D by design, so a flat map
would need the graticule to know about it anyway. It ties occlusion to tile load state. And it is
scene-wide: a scene that draws a footprint sagging below the ellipsoid, or a marker sitting on it,
cannot have the graticule occluded without losing those too.

**Ground polylines.** `GroundPolylinePrimitive` is draped and screen-space wide, which is both halves
of what a graticule wants. It builds in a geometry worker that first fetches
`Assets/approximateTerrainHeights.json`, and that worker keeps a failed fetch for good: every later
line fails with it, and the failure is a bare object thrown from the render loop, which stops the
globe. A VSCode webview answers that fetch with 408 when its resource pipe is slow. ADR-0036 already
records the country borders being moved off ground polylines for exactly this.

**Imagery.** Occluded for free and wrong for the rest: ground-space width that thickens on zoom, and
labels painted at the resolution of the texels.

**One primitive per segment.** What the downstream polyline implementation did, through the `Edges`
vocabulary, because an edge is a pair. It is 2,718 primitives for a 20°/10° graticule and 7,620 for
5°/5°, against 35 and 107 for one polyline per visible run, and it made the scene answer the camera
more slowly.
