# Modules, vocabularies and glue

Three things in this system are easy to confuse, and the confusion is expensive because each lives
in a different place and has a different lifetime.

- A **module** is JavaScript. It renders. It runs in the browser.
- A **payload vocabulary** is Julia types. The payloads a module reads are built from them, and they
  live inside CesiumLink so that every caller can reach them.
- A **glue package** is a Julia package. It turns a simulation's own types into the messages a
  module understands.

The rest of this page states why each of them sits where it does.

## A module

One ES module, served same-origin, whose default export has a `setup(ctx)`. It is the unit that
renders or contributes to the scene, and it is the only place browser-side code is written.

The Core hands `setup` a single context object. Everything a module may use arrives that way: the
shared Cesium namespace, the scene, the clock, the window and frame callbacks, the pick stamp, the
overlay, the messaging pair, and the two functions that address a keyframe inside an array. Every
registration it makes returns a disposable, and the Core drains them on unload, so a module cannot
leave a listener behind in a shared service.

Most scenes need no module at all. Four modules are vendored: `primitives` draws points, polylines
and ground footprints from payloads built in Julia, `ui` owns the overlay and the tooltip, `heatmap`
drapes a grid of finished colour over a box of degrees, and `models` draws one glTF model per entity
of a node family. So a time-dynamic scene ships with no
JavaScript of its own. A module is worth writing at the edge of that: a shader-driven material, a
raster field, a sprite atlas whose glyph depends on entity state, a widget kind of your own. The
[module API](../reference/wire/module-api.md) is the normative contract, and
[Write a viewer module](../tutorials/first-module.md) is the walk-through.

A module may also draw **onto** what another module owns. A sensor cone, a coverage ellipsoid or a
swath stands on an entity `primitives` owns: the drawer asks that module where the entity is and
whether it is shown, every frame, and borrows its identity so that a click on the cone answers the
satellite. `lib/models/` is the example to read. What a borrowed identity costs is in
ADR-0023: a pick says which
entity was hit, and never which geometry.

## What is vendored, and what is a module away

The four vendored modules were chosen from satellite scenes. Nothing in the wire or in the Core
knows what a satellite is — a window of keyframes, a node with a position and a payload of bytes
serve a fleet of buoys or an air-traffic replay as well — but the vocabulary above them is points,
links, footprints and a draped colour grid because that is what a constellation is made of. What
follows from that is a real boundary, and it is better stated than discovered: what a satellite
scene needs is vendored, and the rest of what Cesium is famous for is reachable but not shipped.

Reachable, because a module is handed `ctx.Cesium` — the whole `@cesium/engine` namespace, the same
instance the Core built the scene with — together with the scene, the widget's entity collection and
its data sources. So the table below is a list of modules nobody has written yet, and not a list of
things the architecture refuses.

| Cesium feature | Vendored? | What it takes today |
|---|---|---|
| **3D Tiles** — photogrammetry, point clouds, OSM Buildings | no | A module: `Cesium3DTileset.fromUrl` onto `ctx.scene.primitives`. Serve the tileset from an `assets` mount, or name its origin in `trusted_origins` |
| **Terrain** (quantized-mesh providers) | no | A module can set `scene.globe.terrainProvider`, but the globe is ellipsoid terrain by declaration and `Areas` and `heatmap` are authored on the ellipsoid, so ground geometry does not clamp to it. Session-wide terrain wants a declaration knob beside `imagery` |
| **Extruded polygons, walls, corridors, cylinders and cones** — sensor volumes, swaths | no: `primitives` draws points, polylines and flat ground footprints | A module, which may stand its geometry on an entity `primitives` owns and borrow its identity, as `models` does |
| **CZML** | no | A module: `CzmlDataSource.load` into `ctx.viewer.dataSources`. It rides beside the window buffer rather than through it, because CZML carries its own clock, availability and document range, and the Core owns the clock and the declared range |
| **GeoJSON / KML / KMZ** | no | A module, the same way, and with no clock to argue about for a static overlay |
| **Cesium ion assets** — World Terrain, Bing imagery, Google Photorealistic 3D Tiles | no, deliberately: the viewer carries no token and works offline | A module that sets `Ion.defaultAccessToken` to your own token, and the ion origins in `trusted_origins` |
| **Imagery providers** past a `{z}/{x}/{y}` template or a folder of tiles — WMS, WMTS, TMS, ArcGIS | no | A module that pushes an `ImageryProvider` onto `scene.imageryLayers`, or a widened `Imagery` declaration |
| **Post-processing** — silhouettes, bloom, custom shaders | no | A module: `ctx.scene.postProcessStages` |

None of the rendering above needs the Core changed, which is the point of the boundary the rest of
this page draws. The Core owns four things a module cannot take over: the clock and the declared
range, the window buffer and the requests that fill it, pick dispatch, and overlay placement. So the
work that lands *in* the Core is the work that wants to own time or delivery — streaming CZML as a
second delivery path, a scene with two clocks, or making terrain and an external tileset part of the
session declaration rather than something one module knows about privately.

## A payload vocabulary

`Nodes`, `Edges` and `Areas` are the vocabulary of `primitives`. The controls, the floats and the
tooltip are the vocabulary of `ui`. `Models` is the vocabulary of `models`. `Raster` and the colour
grid are the vocabulary of `heatmap`. They are what a caller *calls*, and not what a caller *is*.

The vocabularies live inside CesiumLink rather than in a package of their own, and that was a
decision rather than an accident (ADR-0011).
Roughly a thousand lines of the package are neither the wire nor the server: they are the vocabulary
of the vendored modules. A split into a package of its own was declined on two grounds. The consumer
count was too low for the seam to be real. And a split would turn the module API version into a
compatibility axis, when that version is forwarded to the viewer and checked nowhere on the Julia
side. A mismatch then surfaces in the browser rather than as a resolver error: the Core gates the
module before importing it, so the module never runs, and the report is one console line naming the
module and both versions. That is a diagnosable failure and not a silent one, but it lands a
process away from the `[compat]` bound that would have caught it.

Each vendored module's vocabulary is a submodule — `CesiumLink.Primitives`, `CesiumLink.UI`,
`CesiumLink.Heatmap` — and the file, the submodule and the wire id agree three ways
(ADR-0012). The gain is a declared
header: a reader sees what a 500-line vocabulary file needs from the rest of the package before
reading any of it, rather than searching for the answer.

The `models` vocabulary is the one exception, and a language rule rather than a choice. Its
submodule is `CesiumLink.ModelFamilies`, because a module and a type inside it cannot share a name:
a `module Models` holding a `struct Models` makes the module binding win in the parent, and the
constructor is then unreachable. The file and the wire id still read `models`, and `using
CesiumLink` supplies `Models` as it supplies `Nodes`.

The submodules **are** re-exported, so `using CesiumLink` alone supplies `Nodes` and `Title`. That
half of the original decision was reversed after the cost was counted. A refusal to re-export makes
the compiler enforce the boundary. Julia resolves a function body's names at call time, so a flat
file can reach a vocabulary name the moment the parent does `using .UI`, and the enforcement stops
that. But it guards a rule that is almost never broken, and it charges one import line to every
consuming scope. That is roughly 37 test blocks in the package, 16 more in the end-to-end suite, two
tool scripts and the extension. The boundary is checked by reading and by one grep instead. A
vocabulary-to-vocabulary edge can still only appear as a `using ..Primitives` line in a header,
where a reader sees it.

Two files stay outside both vocabularies. The colour map and the geodesy helpers are reached by both
vocabularies and by scenes directly. Either of them inside one vocabulary would create the single
edge the boundary exists to prevent. Neither has a wire id or a browser counterpart, and a submodule
is earned by a vendored browser module.

## A glue package

The Julia package that authors a module's messages, by turning a simulation's own types into the
payloads a module reads. A package that draws its own constellation through the vendored
`primitives` module is one. A glue package that targets only vendored modules ships no JavaScript,
no module folder and no build step: it is Julia code that calls a vocabulary.

The distinction from a vocabulary is worth holding on to. The vocabulary is `Nodes(...)`. The glue
is the function that knows a constellation has satellites and turns them into that call. The
vocabulary must be reachable by every glue package, which is why it is in CesiumLink; the glue knows
one domain, which is why it is not.

## What may cross between two modules

Modules that derive from the same simulation base share their **authoring code**, not their
**runtime state** (ADR-0006). Two heatmaps
over one constellation share the Julia extraction that produces their fields and stream separate
payloads into one vendored module. Nothing about that requires a browser-side mechanism.

The mechanism that does exist is narrow. `ctx.modules.get(id)` returns another declared module's
**exports** — classes, factories, functions — and nothing else, so what crosses a module boundary is
code by construction. Where a module genuinely needs a value from another, it gets a read-only
accessor and never a setter. A module that owns entities and wants them anchorable exports the
anchor surface — `positionOf`, `countOf`, `pickIdOf`, `showOf`, `edgeEndpoints` and `pairsOf`. `ui`
calls `positionOf` on the module a float's anchor names, and `models` calls four of the six on
`primitives` every frame.

The rule is: **one owner per entity; other modules get read-only accessors; writes never cross a
module boundary.** A module may draw over what another draws. It may never restyle or mutate it. The
reason is not tidiness. A viewer-side mutation has no author on the server, so the next window
silently overwrites it, and the bug is invisible until a window happens to arrive.

The earlier design — a Core-owned registry that one module published positions into and another read
— is retired. It had one publisher and one reader, and neither remains: the scene is drawn by
`primitives`, and route highlighting turned out to be three edge families inside that same module's
payload.

## Declared over the wire

The server tells the viewer which modules to load. A declaration carries an id, a URL and an API
version, and travels as part of establishing the connection
(ADR-0009).

A declaration is authored in Julia by naming a **file on disk**. The server mounts that file's
directory under a URL segment derived from the module id, and serves it same-origin. Sibling
chunks, workers and images therefore resolve normally, and any Julia package ships a bundle by
naming its own module folder.

The design this replaced was a static manifest file per module folder, discovered from a
server-provided list. It was adopted for a good reason and dropped for the same reason inverted. The
manifest's value was that it made a folder a self-contained drop-in unit. But the unit that actually
travels is a **Julia package**, which already has a name, a version and a place to put assets. The
manifest duplicated all three into a file the Core had to fetch and validate before it could do
anything. The version gate it existed for is one field in a message the connection already sends.
Two round trips left startup with it.

The `apiVersion` gate survives, and it is checked **before** the import, so a module written against
a different contract never has its code run. A mismatch is warned about and skipped, and the rest of
the declaration still loads.

## Why declaration order stopped being binding

Order used to decide reachability: a module could only reach one declared before it. That broke on a
real case. One module both **feeds** `ui`, with a float mount or a `positionOf` an anchor names, and
**extends** it with a widget kind. Such a module had to be declared both before and after `ui`, so
it was unwritable as one entry. A split into two entries did not work either. `ui` applies its own
retained declaration during its `setup`, so a widget kind registered by a later module arrived too
late and the row was never built.

The Core now loads a declaration in three passes. It imports every module first, concurrently,
running no `setup`. Then it runs each `setup`, in declaration order. Then it replays the retained
commands, once every `setup` has returned.

**Order keeps one meaning: draw order and overlay stacking.** That is an authorial choice about what
is drawn over what, and it is the one thing an author should still be choosing. A dependency
declaration was considered and stays unbuilt, and removing the ordering constraint outright is
precisely why it is unnecessary rather than overdue.

Three consequences were accepted rather than designed around.

- **A module's `setup` must not call a peer's functions.** Every module's exports exist by then, but
  an accessor reading state the peer builds in its own `setup` answers `undefined` until that setup
  runs. The Core warns, names both modules, and still hands back the exports, so the warning changes
  no behaviour.
- **The exports view is live**, so unloading a provider drops it out from under a consumer that kept
  the id. Nothing on the wire unloads a single module, so this is recorded rather than guarded.
- **A hanging import delays every module's `setup`**, where a serial loader delayed only the modules
  behind it. The modules are served by the same server that sent the declaration, and the
  last-declared module already carried that risk, so there is no timeout and no retry.

## The one hard rule: one Cesium

A module must not import Cesium at run time. It imports the types, which are erased at build, and
reaches the live namespace through its context.

Two live copies of Cesium in one page is the dual-package hazard. A primitive built by one cannot be
added to the other's scene, and a `Cartesian3` from one fails an `instanceof` in the other. The
failures surface as blank geometry rather than as an error. Nothing in the browser reports it, and a
module author who looks at an empty globe has no reason to suspect the loader.

The same applies to everything else the Core owns. The scene, the clock, the pointer handler and the
overlay all arrive through the context, and a module constructs none of them. That is why the
context is a wide options bag rather than a set of imports: it is the mechanism that makes the rule
hold by default instead of by discipline.

There is one route around the gate, and it is legitimate for one purpose. A bundle may mark a
dependency `external` and alias it to `/modules/<id>/<file>.js`. The browser keys module instances
by resolved URL, so both modules then share one live instance. That import resolves in the browser,
so the Core never sees it and cannot version-gate it. The route exists to stop a second copy of a
third-party library a sibling module already bundles. It is not the way to reach another module's
exports, because `ctx.modules` does that and is already gated.
