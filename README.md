# CesiumLink

Drive a Cesium 3D globe from Julia. You describe a time-dynamic scene in Julia — satellites, ground
stations, links, footprints, a scalar field over the globe — and CesiumLink streams it to a browser
over one WebSocket. The browser plays it back against its own clock, and reports what the user does
back to your Julia process.

```julia
using CesiumLink

server = start_server()                      # serves the viewer and opens a page
register_module!(server, vendored(:primitives))

push_window(server,
            Dict(:primitives => primitives_payload(Nodes(:sat, position))),
            start_frame = 1, count = size(position, 3), dt_seconds = 30,
            total_frames = size(position, 3))
```

The tutorials build that up from nothing: [documentation](https://juliasatcomframework.github.io/CesiumLink.jl/).

## What it is for

- **A scene the server decides.** A control on screen reports the user's input and changes nothing
  locally. Your Julia code answers with the scene that follows. Nothing on screen can disagree with
  what your code believes.
- **Long missions, delivered lazily.** The server states the whole timeline up front and sends the
  keyframes in windows as playback approaches them.
- **Arrays that travel as bytes.** A payload's arrays ride behind the JSON header as raw memory, not
  base64. A `Matrix{Float64}` of positions reaches the browser as a typed array.
- **Three places to put the scene.** A browser tab, a VSCode tab, or a recording that a static page
  replays with no Julia process anywhere.
- **Your own JavaScript, when you need it.** A module is one ES module the server declares over the
  wire. Four ship in the box — points and lines, an overlay panel, a draped heatmap, glTF models —
  and most scenes need none of their own.

## Two languages, one repository

| Path | What is in it |
|---|---|
| `src/`, `test/` | the Julia package |
| `lib/` | the viewer: the Core, the three hosts, the four vendored modules, and `build.mjs` |
| `extension/` | the VSCode extension |
| `examples/` | runnable examples, which the documentation build runs on every build |
| `tools/` | the regression harness and the fixture generators |
| `docs/` | the documentation site, the glossary and the decision records |

The built viewer is **not committed**. An installed package downloads it once, as a lazy Julia
artifact. To build it yourself:

```sh
cd lib && npm ci && npm run build     # writes lib/dist, which the package prefers when it exists
```

## Install

```julia
using Pkg
Pkg.add("CesiumLink")
```

## License

MIT. See [LICENSE](LICENSE). The viewer artifact carries the CesiumJS runtime, which is Apache-2.0 —
see [NOTICE](NOTICE).
