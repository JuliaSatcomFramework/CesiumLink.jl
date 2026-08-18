```@raw html
---
layout: home

hero:
  name: "CesiumLink.jl"
  text: "A 3D globe you drive from Julia"
  tagline: Stream a time-dynamic Cesium scene to the browser over one WebSocket. The data, and every decision about what the scene shows, stay in Julia.
  actions:
    - theme: brand
      text: Your first scene
      link: /tutorials/first-scene
    - theme: alt
      text: How-to guides
      link: /how-to/
    - theme: alt
      text: Julia API
      link: /reference/

features:
  - title: Tutorials
    details: Five lessons in order, from an empty globe to a Julia package that ships its own viewer module.
    link: /tutorials/
  - title: How-to guides
    details: Short answers to a problem you already have. Draw a track, drape a field, record a session.
    link: /how-to/
  - title: Reference
    details: Every documented Julia symbol, plus the two normative contracts the browser side obeys.
    link: /reference/
  - title: Explanation
    details: Why the server decides, what a window guarantees, and how arrays reach the browser.
    link: /explanation/
  - title: Examples
    details: Whole runnable programs, each on a page with its live scene and its full source.
    link: /examples/
---
```

## What CesiumLink is

CesiumLink serves a Cesium globe to a browser and drives it from a Julia process. One
WebSocket carries the whole session: which modules the page loads, the scene data for a
run of keyframes, and the commands that answer what the user does.

The browser holds a small **Core**. It owns the transport, the clock, the keyframe buffer
and the loading of modules. It models no entities and never reads inside a module's
payload, so everything that decides what the scene contains stays in Julia.

A **module** is one ES module the Core loads because the server declared it. Four modules
ship inside the viewer:

- `primitives` draws points, polylines and ground footprints.
- `ui` owns the overlay, the floating boxes and the tooltip.
- `heatmap` drapes a field over the globe.
- `models` puts a glTF model on each entity of a family.

A time-dynamic scene therefore needs no JavaScript of your own.

```julia
using CesiumLink

server = start_server()
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:ui))

push_window(server, Dict(:primitives => primitives_payload(
                Nodes(:station; position = Float32[6.4e6 0 0; 0 6.4e6 0; 0 0 6.4e6], size = 12)));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```

The server can record a session to a file. The browser plays the recording on its own, with
no Julia process behind it, which is how [this page](how-to/record-replay.md#play-a-recording-in-a-web-page-with-no-julia-at-all)
puts a live scene in the documentation.

## Where to go

This documentation follows the [Diátaxis](https://diataxis.fr) framework: four sections for
four different needs, plus Examples beside them.

| You want to | Read |
|---|---|
| Learn the system by building something | [Tutorials](tutorials/index.md) |
| Solve a problem you already have | [How-to guides](how-to/index.md) |
| Look up a function, a type or a wire field | [Reference](reference/index.md) |
| Understand why the system is shaped this way | [Explanation](explanation/index.md) |
| See a whole program that works | [Examples](examples/index.md) |

A new reader starts with [Your first scene](tutorials/first-scene.md).

## Requirements

- Julia 1.10 or later.
- Somewhere to draw the globe, which is either of:
  - a browser with WebGL 2.0, or
  - VSCode 1.102 or later with the
    [CesiumLink extension](https://marketplace.visualstudio.com/items?itemName=disberd.cesiumlink),
    which draws the scene in an editor tab — see
    [Show a scene in a VSCode tab](how-to/vscode-tab.md).

Neither one needs extra software or a build step. The server serves the viewer's own assets,
and the extension reads the same tree off the disk.
