# CesiumLink

[![CI](https://img.shields.io/github/actions/workflow/status/JuliaSatcomFramework/CesiumLink.jl/CI.yml?style=flat-square&logo=githubactions&logoColor=white&labelColor=475569&label=CI)](https://github.com/JuliaSatcomFramework/CesiumLink.jl/actions/workflows/CI.yml)
[![Codecov](https://img.shields.io/codecov/c/github/JuliaSatcomFramework/CesiumLink.jl?style=flat-square&logo=codecov&logoColor=white&labelColor=475569)](https://codecov.io/gh/JuliaSatcomFramework/CesiumLink.jl)
[![docs-stable](https://img.shields.io/badge/docs-stable-16A34A?style=flat-square&logo=gitbook&logoColor=white&labelColor=475569)](https://juliasatcomframework.github.io/CesiumLink.jl/stable/)
[![docs-dev](https://img.shields.io/badge/docs-dev-D97706?style=flat-square&logo=gitbook&logoColor=white&labelColor=475569)](https://juliasatcomframework.github.io/CesiumLink.jl/dev/)
[![License](https://img.shields.io/github/license/JuliaSatcomFramework/CesiumLink.jl?style=flat-square&logo=readme&logoColor=white&labelColor=475569&color=0284C7)](https://github.com/JuliaSatcomFramework/CesiumLink.jl/blob/main/LICENSE)

**Draw what your Julia code computes on a globe, in 3D or 2D. Most scenes need no JavaScript.**

CesiumJS is a geospatial engine that runs in a browser. To reach it from Julia you normally write
JavaScript, serve it, open a WebSocket, agree on a message format, get arrays across without base64,
and keep the browser clock in step with the data. CesiumLink does all of that for you.

You describe a time-dynamic scene in Julia: satellites, ground stations, links, footprints, or a
scalar field over the globe. CesiumLink streams the scene to a browser over one WebSocket. The
browser plays the scene against its own clock, and reports the actions of the user back to your Julia
process.

```julia
using CesiumLink

server = start_server()                      # serves the viewer and opens a page
register_module!(server, vendored(:primitives))

push_window(server,
            Dict(:primitives => primitives_payload(Nodes("sat"; position)));
            start_frame = 1, count = size(position, 3), dt_seconds = 30,
            total_frames = size(position, 3))
```

The tutorials build this example from nothing:
[documentation](https://juliasatcomframework.github.io/CesiumLink.jl/).

## Windows arrive on demand

A run of fifty thousand keyframes does not have to be computed, held in memory, or sent before the
first frame appears. Declare the length of the run, then deliver the part of the run that you have:

```julia
push_window(server, payload_for(1:200);
            start_frame = 1, count = 200, total_frames = 50_000, dt_seconds = 30)

on_event(server, "core", "need") do ev, _
    push_window(server, payload_for(ev.start_frame, ev.count);       # computed when asked
                start_frame = ev.start_frame, count = ev.count, mode = :append,
                total_frames = 50_000, dt_seconds = 30)
end
```

The viewer asks for more keyframes when playback approaches the end of what it holds. Your listener
computes those keyframes at that moment. The clock, the timeline and the scrub control cover the
whole declared run from the first window onward. The frames that nobody plays are never computed. A
run that is too long for memory, or too slow to precompute, is an ordinary scene here.

## Modules

Four modules ship in the package: points and lines, an overlay panel, a draped heatmap, and glTF
models. A scene that uses only those modules needs no JavaScript. To build such a scene, call the
Julia constructors and push payloads at them.

A module is one ES module. The Julia server names the module to the browser, and the browser loads it
same-origin from the assets folder of your own Julia package. A module of your own gets the same
context that a vendored module gets: the Cesium scene, the clock, the buffer of keyframes, the
dispatch of a click to the object under it, the placement of the on-screen controls, and the codec
that unpacks the arrays. A custom shader, a sprite atlas or a new kind of widget is therefore an
addition and not a fork.

## Scope

Neither the viewer nor the Julia API knows what a satellite is. The primitives are a window of
keyframes, a node with a position, an edge between two nodes, and a payload of raw bytes. Those
primitives are equally good for a fleet of buoys, an air-traffic replay or a scalar field over a
country. The package contains no orbit propagator.

The primitives are generic, but satellite scenes decided what is built on them:

- Lazy window delivery exists because a propagated mission is long and expensive to compute up front.
- The vendored vocabulary is `Nodes`, `Edges` and `Areas` because a constellation is points, links
  and footprints.
- `heatmap` drapes a finished colour grid, because Julia computes coverage and link-budget maps and a
  shader does not.
- The camera rides an entity, because the useful viewpoint is usually a spacecraft.
- The ellipsoid is declarable, because the globe is not always Earth.

The scope is therefore this: what a satellite scene needs is vendored and first-class, and the other
features of Cesium are reachable but not shipped. A module gets `ctx.Cesium`, which is the full
`@cesium/engine` namespace and the same instance that built the scene. A module also gets the scene,
the entity collection of the widget, and its data sources. Almost every feature in the table below is
one module away, and none of them needs a fork.

| Cesium feature | Vendored? | What it takes today |
|---|---|---|
| **3D Tiles** — photogrammetry, point clouds, OSM Buildings | no | A module. It calls `Cesium3DTileset.fromUrl` and adds the tileset to `ctx.scene.primitives`. Serve the tileset from an `assets` mount, or name its origin in `trusted_origins` |
| **Terrain** (quantized-mesh providers) | no | A module can set `scene.globe.terrainProvider`. The globe is ellipsoid terrain by declaration, and `Areas` and `heatmap` are authored on the ellipsoid, so ground geometry does not clamp to the terrain. Session-wide terrain needs a declaration knob beside `imagery` |
| **Extruded polygons, walls, corridors, cylinders and cones** — sensor volumes, swaths | no: `primitives` draws points, polylines and flat ground footprints | A module. It can stand its geometry on an entity that `primitives` owns and borrow that identity, so a click on the cone answers with the satellite. `models` is the worked example |
| **CZML** | no | A module. It calls `CzmlDataSource.load` into `ctx.viewer.dataSources`. The data source rides beside the streamed keyframes and not through them, because CZML carries its own clock and its own time range, and CesiumLink owns the clock |
| **GeoJSON / KML / KMZ** | no | A module, in the same way. A static overlay carries no clock |
| **Cesium ion assets** — World Terrain, Bing imagery, Google Photorealistic 3D Tiles | no, deliberately: the viewer carries no token and works offline | A module that sets `Ion.defaultAccessToken` to your own token, plus the ion origins in `trusted_origins` |
| **Imagery providers** past a `{z}/{x}/{y}` template or a folder of tiles — WMS, WMTS, TMS, ArcGIS | no | A module that pushes an `ImageryProvider` onto `scene.imageryLayers`, or a wider `Imagery` declaration |
| **Post-processing** — silhouettes, bloom, custom shaders | no | A module: `ctx.scene.postProcessStages` |

No item in the table needs a change to CesiumLink itself. The package keeps four things that a module
cannot take over: the clock and the declared range, the buffer of keyframes and the requests that
fill it, the dispatch of a click to the object under it, and the placement of the on-screen controls.
A change to the package itself is necessary only for work that must own time or delivery. Examples:
CZML as a second delivery path, a scene with two clocks, or terrain that belongs to the session
instead of to one module.

## What the framework does for you

- **The transport.** One WebSocket, one message envelope, one reconnect procedure. You open no socket
  and design no protocol.
- **Arrays as bytes.** The arrays of a payload ride behind the JSON header as raw memory, not base64.
  A `Matrix{Float64}` of positions arrives in the browser as a typed array.
- **Time.** One clock and one declared range, and the viewer interpolates between keyframes. The
  framework asks for more keyframes, tracks what the browser holds, and evicts what the browser no
  longer needs.
- **A scene that your code decides.** A control on screen reports the input of the user and changes
  nothing locally. Your Julia code answers with the scene that follows, so the screen cannot disagree
  with the state that your code holds.
- **Four places to put the scene.** A browser tab, a VSCode tab, a KaimonSlate notebook cell, or a
  recording. A static page replays the recording with no Julia process anywhere.

## Two languages, one repository

| Path | What is in it |
|---|---|
| `src/`, `test/` | the Julia package |
| `lib/` | the viewer: its core, the four hosts, the four vendored modules, and `build.mjs` |
| `extension/` | the VSCode extension |
| `examples/` | runnable examples, which the documentation build runs on every build |
| `tools/` | the regression harness and the fixture generators |
| `docs/` | the documentation site and the decision records |

The built viewer is **not committed**. An installed package downloads it once, as a lazy Julia
artifact. To build it yourself:

```sh
cd lib && npm ci && npm run build     # writes lib/dist, which the package prefers when it exists
```

## Install

CesiumLink is not in the General registry. It will be submitted for registration when a period of use
shows that the API is stable. Until then, add it from this repository:

```julia
using Pkg
Pkg.add(url = "https://github.com/JuliaSatcomFramework/CesiumLink.jl")
```

`Pkg.update` then follows the `main` branch of the repository.

## License

MIT. See [LICENSE](LICENSE). The viewer artifact carries the CesiumJS runtime, which is Apache-2.0 —
see [NOTICE](NOTICE).
