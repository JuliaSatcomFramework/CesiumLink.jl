# Modules, vocabularies and glue

Three things in this system are easy to confuse. Each lives in a different place and has a different
lifetime.

- A **module** is JavaScript. It renders. It runs in the browser.
- A **payload vocabulary** is Julia types. The payloads a module reads are built from them. Each
  vendored module's vocabulary lives inside CesiumLink, so that every caller can reach it. A module
  you ship yourself carries its own.
- A **glue package** is a Julia package. It turns a simulation's own types into the messages a
  module understands.

## A module

One ES module, served same-origin, whose default export has a `setup(ctx)`. It renders or
contributes to the scene, and it is the only place browser-side code is written. The Core hands
`setup` one context object holding every capability a module may use. Every registration returns a
disposable, and the Core drains them on unload, so a module cannot leave a listener behind in a
shared service.

Most scenes need no module at all. Four modules are vendored: `primitives` draws points, polylines
and ground footprints from payloads built in Julia, `ui` owns the overlay and the tooltip, `heatmap`
drapes a grid of finished colour over a box of degrees, and `models` draws one glTF model per entity
of a node family. A module is worth writing at the edge of those: a shader-driven material, a raster
field, a widget kind of your own. The [module API](../reference/wire/module-api.md) is the normative
contract, and [Write a viewer module](../tutorials/first-module.md) is the walk-through.

A module may also draw **onto** what another module owns. A sensor cone stands on an entity
`primitives` owns: the drawer asks that module where the entity is and whether it is shown, every
frame, and borrows its identity, so a click on the cone answers the satellite. `lib/models/` is the
example to read. A borrowed identity costs what
ADR-0023 states: a pick says which
entity was hit, and never which geometry.

## What is vendored, and what is a module away

The four vendored modules were chosen from satellite scenes. Nothing in the wire or in the Core
knows what a satellite is; the vocabulary above them is points, links, footprints and a draped
colour grid because that is what a constellation is made of. What a satellite scene needs is
vendored, and the rest of what Cesium draws is reachable but not shipped.

Reachable, because a module is handed `ctx.Cesium` — the whole `@cesium/engine` namespace, the same
instance the Core built the scene with — together with the scene, the widget's entity collection and
its data sources. Each row below is a module nobody has written yet.

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

None of that needs a change to the Core, which owns four things a module cannot take over: the clock
and the declared range, the window buffer and the requests that fill it, pick dispatch, and overlay
placement. Work lands *in* the Core when it wants to own time or delivery: streaming CZML as a
second delivery path, a scene with two clocks, or terrain and an external tileset as part of the
session declaration.

## A payload vocabulary

`Nodes`, `Edges` and `Areas` are the vocabulary of `primitives`. The controls, the floats and the
tooltip are the vocabulary of `ui`. `Models` is the vocabulary of `models`. `Raster` and the colour
grid are the vocabulary of `heatmap`.

The vendored modules' vocabularies live inside CesiumLink rather than in a package of their own
(ADR-0011). Roughly a thousand lines
of the package are the vocabulary of the vendored modules, and a split was declined on two grounds.
The consumer count was too low for the seam to be real. And a split would turn the module API
version into a compatibility axis, when that version is forwarded to the viewer and checked nowhere
on the Julia side: a mismatch surfaces as one console line in the browser, a process away from the
`[compat]` bound that would have caught it.

Each vendored module's vocabulary is a submodule — `CesiumLink.Primitives`, `CesiumLink.UI`,
`CesiumLink.Heatmap` — and the file, the submodule and the wire id agree three ways
(ADR-0012). A reader then sees what a
500-line vocabulary file needs from the rest of the package before reading any of it.

A module that ships from a package of your own carries its vocabulary in that package, beside the
module and the entry that declares it. See
[Ship a module from a Julia package](../tutorials/package-with-module.md).

`models` is the one exception, forced by a language rule: a module and a type inside it cannot share
a name, because a `module Models` holding a `struct Models` makes the module binding win in the
parent and leaves the constructor unreachable. Its submodule is `CesiumLink.ModelFamilies`, the file
and the wire id still read `models`, and `using CesiumLink` supplies `Models` as it supplies
`Nodes`.

The submodules **are** re-exported, so `using CesiumLink` alone supplies `Nodes` and `Title`. A
refusal to re-export makes the compiler enforce the boundary, because Julia resolves a function
body's names at call time. But it guards a rule that is almost never broken, and charges one import
line to every consuming scope: roughly 37 test blocks in the package, 16 more in the end-to-end
suite, two tool scripts and the extension. Reading and one grep check the boundary instead, and a
vocabulary-to-vocabulary edge still appears only as a `using ..Primitives` line in a header.

The colour map and the geodesy helpers stay outside both vocabularies, because both vocabularies and
scenes reach them directly and either one inside a vocabulary would create the single edge the
boundary prevents. A submodule is earned by a vendored browser module, and neither has one.

## A glue package

The Julia package that authors a module's messages, by turning a simulation's own types into the
payloads a module reads. A package that draws its own constellation through the vendored
`primitives` module is one, and a glue package that targets only vendored modules ships no
JavaScript, no module folder and no build step.

Take `Nodes(...)`. The call is the vocabulary, and the glue is the function that knows a
constellation has satellites and turns them into that call. Every glue package that targets
`primitives` makes the same call, so `Nodes` sits in CesiumLink. Each glue package knows one domain,
so the glue stays in the package that owns that domain.

A glue package that ships a module of its own holds that module's vocabulary too. What lives in
CesiumLink is the vocabulary of the modules CesiumLink vendors.

## What may cross between two modules

Modules that derive from the same simulation base share their **authoring code**, not their
**runtime state** (ADR-0006). Two heatmaps
over one constellation share the Julia extraction that produces their fields and stream separate
payloads into one vendored module.

The browser-side mechanism is narrow. `ctx.modules.get(id)` returns another declared module's
**exports** — classes, factories, functions — and nothing else, so what crosses a module boundary is
code by construction. A module that owns entities and wants them anchorable exports the anchor
surface: `positionOf`, `countOf`, `pickIdOf`, `showOf`, `edgeEndpoints` and `pairsOf`. `ui` calls
`positionOf` on the module a float's anchor names, and `models` calls four of the six on
`primitives` every frame.

The rule is: **one owner per entity; other modules get read-only accessors; writes never cross a
module boundary.** A module may draw over what another draws, and may never restyle or mutate it: a
viewer-side mutation has no author on the server, so the next window silently overwrites it, and the
bug is invisible until a window arrives.

## Declared over the wire

The server tells the viewer which modules to load. A declaration carries an id, a URL and an API
version, and travels as part of establishing the connection
(ADR-0009).

A declaration is authored in Julia by naming a **file on disk**. The server mounts that file's
directory under a URL segment derived from the module id, and serves it same-origin, so sibling
chunks, workers and images resolve normally and any Julia package ships a bundle by naming its own
module folder.

The design this replaced was a static manifest file per module folder, discovered from a
server-provided list. It made a folder a self-contained drop-in unit, but the unit that travels is a
**Julia package**, which already has a name, a version and a place to put assets. The manifest
duplicated all three into a file the Core had to fetch and validate first, and it cost two round
trips at startup, for a version gate that is one field in a message the connection already sends.

The `apiVersion` gate survives, and it is checked **before** the import, so a module written against
a different contract never has its code run. A mismatch is warned about and skipped, and the rest of
the declaration still loads.

## What declaration order decides

**Order carries one meaning: draw order and overlay stacking.** That is an authorial choice about
what is drawn over what. It says nothing about reachability, and every module reaches every other
module the same declaration named, wherever each one sits in the list.

The Core loads a declaration in three passes. It imports every module concurrently and runs no
`setup`. It then runs each `setup`, in declaration order. It then replays the retained commands.

So one entry in the list is enough for a module that both **feeds** `ui`, with a float mount or a
`positionOf` an anchor names, and **extends** it with a widget kind. There is no dependency
declaration, because nothing needs one.

Three costs come with it.

- **A module's `setup` must not call a peer's functions.** Every module's exports exist by then, but
  an accessor reading state the peer builds in its own `setup` answers `undefined`. The Core warns
  and names both modules, and still hands back the exports.
- **The exports view is live**, so unloading a provider drops it out from under a consumer that kept
  the id. Nothing on the wire unloads a single module, so this is recorded rather than guarded.
- **A hanging import delays every module's `setup`.** The same server serves the modules and sent
  the declaration, so there is no timeout and no retry.

## The one hard rule: one Cesium

A module must not import Cesium at run time. It imports the types, which are erased at build, and
reaches the live namespace through its context.

Two live copies of Cesium in one page is the dual-package hazard: a primitive built by one cannot be
added to the other's scene, and a `Cartesian3` from one fails an `instanceof` in the other. The
failures surface as blank geometry, nothing in the browser reports them, and a module author looking
at an empty globe has no reason to suspect the loader. The scene, the clock, the pointer handler and
the overlay arrive through the context for the same reason.

One route around the gate is legitimate. A bundle may mark a dependency `external` and alias it to
`/modules/<id>/<file>.js`; the browser keys module instances by resolved URL, so both modules share
one live instance. That import resolves in the browser, so the Core never sees it and cannot
version-gate it. The route exists to stop a second copy of a third-party library a sibling module
already bundles, and not to reach another module's exports: `ctx.modules` does that, and is gated.
