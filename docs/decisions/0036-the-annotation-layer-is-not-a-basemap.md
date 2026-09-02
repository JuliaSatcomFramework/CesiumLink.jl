---
status: accepted
---

# The annotation layer is a layer that is not a basemap

ADR-0034 gave the reader a set of basemaps to pick within. Every basemap of that set is a picture of
the ground and none of them says what a reader is looking at. The catalogue held one that did:
`blue_marble_labeled` painted OpenStreetMap place names into the JPEG. That is why it went. A name
painted into a tile belongs to one basemap, no other basemap can borrow it, and no reader can turn
it off.

## Decision

**The viewer draws two annotation layers above the basemap: place names and country borders. The
session owns them, not the pick.**

Both are ordinary Cesium objects rather than imagery: the names are a `LabelCollection` on
`scene.primitives`, the borders a `GeoJsonDataSource` on `widget.dataSources`. The Core adds them
once, when it builds the scene.

**The picker cannot take them off, by construction.** It removes the base layers it counted from the
entry that is on the globe, and it counts imagery layers. An annotation layer is not an imagery
layer at all, so a switch never reaches it. Nothing had to be added to the picker, and nothing there
has to be remembered by whoever changes it next.

**The names and the country borders are independent.** Either may be off while the other is on. A
reader who wants the borders without the names, or the names without the borders, gets both answers
from two flags.

**They carry no credit and open no origin.** Every file ships inside the viewer, so nothing reaches
the network. The data is Natural Earth, which is public domain. ADR-0034's rule stands unamended:
the credit line names the basemap the reader picked, and these layers add nothing to it.

## Why a paging pass and not a tile pyramid

A transparent label pyramid was built first and shot against three basemaps. It reads well on the
sphere. It fails on depth: a raster name is fixed to its level, so below the deepest level Cesium
upsamples the tile and every name swells into a blurred banner. At 900 km against a pyramid that
stops at level 4, "Bern" is 40 pixels tall and soft.

| | The pyramid, levels 0 to 4 | The two files |
|---|---|---|
| Bytes | 3.9 MB | 0.78 MB of names, 0.76 MB of boundaries |
| Files | 682 | 2 |
| Depth | blurs below level 4 | sharp at every camera height |
| Deeper levels | 100 MB and 40,000 more files | nothing to add |

Reaching the depth the basemaps reach means rendering to geographic level 7, which is about 100 MB
and 40,000 files. That is a pyramid somebody has to host and version forever, and no such pyramid
exists to point at. Cesium draws vector text from a font atlas at screen resolution, so the same
name stays sharp at every height with nothing to host.

**What it costs instead is a paging pass.** A `LabelCollection` builds one billboard per glyph, so
the whole pool of 7,897 names is about 280,000 billboards and the median frame goes to 8.5 seconds.
`distanceDisplayCondition` hides a label; it does not stop Cesium paying for it. So the collection
holds only what the camera can see: filter the pool to the level the camera height reads as and to
the view rectangle, rank what is left, cap it near 400, and rebuild. Filtering costs 0.2 ms and
rebuilding 2.8 ms.

**The pass drops what the reader cannot see, then declutters what is left.** At globe range the
view rectangle covers the whole world, so it keeps the hemisphere behind the Earth. A name just
past the limb then writes its letters into the black beside the disc, and the far side spends
slots from the cap. One dot product per row answers this: a place's own surface normal and the
direction from the camera to that place agree only on the far side. What survives is ranked, and
the pass walks that order and keeps a name only when its text box misses every box already kept.
The rank must come before the walk. Rome and Vatican City are two kilometres apart and both are
capitals, so without a rank the order of the file decides which one the reader sees.

**The rank reads standing inside a kind, not `importance` itself.** That number mixes units:
population for a city, a capital and a country, area for a continent, an ocean and a sea. Sorted
raw, an ocean reads about 10,000 against a city's population of millions. Over Europe at level 5
all 31 water names in view then fall past the cap and none of them is drawn.

**The rebuild runs on `camera.changed` as well as on `moveEnd`.** `moveEnd` fires only once the
camera has settled. Over a five second flight from 14,000 km to 200 km it gave zero rebuilds, and
all 22 sampled frames drew the level the camera had left. With both events and
`camera.percentageChanged = 0.1` the same flight rebuilds 14 times and 2 frames of 18 are stale,
which is the render latency and not the trigger. Cesium's own default for that property is 0.5,
half the view, which is far too coarse here. Going finer than 0.1 fires the same 14 times.

## Why the boundaries are lines

**A country polygon draws no outline on terrain.** Cesium disables entity geometry outlines there
and says nothing about it: the data source loads, the entities exist, `polygon.outline` reads true,
and the globe is bare. So the boundaries arrive as LineString features, which draw as polylines. The
generator writes Natural Earth's boundary-lines file and not its countries file for this one reason.

**And not as ground polylines.** A ground polyline is built in a worker that first fetches
`Assets/approximateTerrainHeights.json` for itself, and the worker keeps a failed fetch for good:
every later line fails with it, and the failure is a bare object the primitive throws from the
render loop, which stops the globe. A VSCode webview answers that fetch with 408 when its resource
pipe is slow. This globe has no terrain, so a plain polyline at height zero lies on the surface, and
`depthTestAgainstTerrain` is off, so the globe never hides one.

The boundary scale is the expensive half. Names cost little and lines cost the frame: 1:110m and
1:50m boundaries are indistinguishable on frame time, and 1:10m roughly doubles it. So the pair is
Natural Earth 1:10m names with 1:50m country boundaries. 1:110m would be free on the same measurement, but
its outlines cut corners: at 900 km the Swiss border is a chunky polygon and Lake Geneva has lost
its shape.

## Consequences

`CesiumWidget` carries `dataSources`, so this needs no full `Viewer`.

Nothing about the annotation layers travels upward, for the reason ADR-0034 gives about the pick:
what is on screen is the viewer's own business.

The trusted origins and the content policy are unchanged. A session that declares nothing still
opens one host, and that host serves tiles.

## Alternatives declined

**A raster label pyramid.** Measured and shot before this record was written. It is legible, and it
is the more expensive way to answer the same question: 100 MB, 40,000 files and a repository to host
them, against two files that are sharper.

**Every name added once, hidden by distance.** This is the obvious shape and it does not work. The
median frame goes to 8.5 seconds, and the screenshot step timed out at 30 seconds against it.

**Names painted into the basemap.** `blue_marble_labeled` was exactly this. One basemap owns the
names, no other basemap can wear them, and the reader cannot turn them off.
