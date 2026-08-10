# CesiumLink

**Show what your Julia code computed, on a 3D globe, without writing a browser application.**

Cesium is an excellent geospatial engine, and reaching it from Julia normally means becoming a web
developer first: writing JavaScript, serving it, opening a WebSocket, agreeing on a message format,
getting arrays across without turning megabytes into base64, and keeping a clock in the browser in
step with the data you are streaming to it. CesiumLink does all of that, so the part you write is
the part that is actually about your results.

You describe a time-dynamic scene in Julia — satellites, ground stations, links, footprints, a
scalar field over the globe — and CesiumLink streams it to a browser over one WebSocket. The browser
plays it back against its own clock and reports what the user does back to your Julia process.

```julia
using CesiumLink

server = start_server()                      # serves the viewer and opens a page
register_module!(server, vendored(:primitives))

push_window(server,
            Dict(:primitives => primitives_payload(Nodes("sat"; position)));
            start_frame = 1, count = size(position, 3), dt_seconds = 30,
            total_frames = size(position, 3))
```

The tutorials build that up from nothing:
[documentation](https://juliasatcomframework.github.io/CesiumLink.jl/).

## A long run does not have to exist before it plays

A fifty-thousand-keyframe mission does not have to be computed, held in memory, or sent before
anything appears on screen. You declare **how long the run is** and deliver whatever part of it you
have:

```julia
push_window(server, payload_for(1:200);
            start_frame = 1, count = 200, total_frames = 50_000, dt_seconds = 30)

on_event(server, "core", "need") do ev, _
    push_window(server, payload_for(ev.start_frame, ev.count);       # computed when asked
                start_frame = ev.start_frame, count = ev.count, mode = :append,
                total_frames = 50_000, dt_seconds = 30)
end
```

The viewer asks for more as playback approaches the end of what it holds, and your listener computes
those keyframes at that moment. So the simulation advances in step with the person watching it: the
clock, the ruler and scrubbing work across the whole declared run from the first window onward, while
the part nobody ever plays is never computed at all. A run too long to fit in memory, or too slow to
precompute, is an ordinary scene here rather than a special case.

## Easy for the common case, and not a ceiling

Most scenes need no JavaScript at all. Four modules ship in the box — points and lines, an overlay
panel, a draped heatmap, glTF models — and a scene is built by calling Julia constructors and pushing
payloads at them.

When a scene outgrows them, nothing has to be worked around. A **module** is one ES module that the
server declares over the wire, loaded from your own Julia package's assets folder and served
same-origin. It gets the same context every built-in module gets: the Cesium scene, the clock, the
window buffer, pick dispatch, overlay placement, and the array codec. So a custom shader, a sprite
atlas, or a widget kind of your own is an addition rather than a fork — and the plumbing underneath
it stays the framework's problem.

## What the framework handles for you

- **The transport.** One WebSocket, one message envelope, one reconnect story. You never open a
  socket or design a protocol.
- **Arrays as bytes.** A payload's arrays ride behind the JSON header as raw memory, not base64. A
  `Matrix{Float64}` of positions arrives in the browser as a typed array.
- **Time.** One clock, one declared range, and interpolation between keyframes done by the viewer.
  Asking for more keyframes, tracking what the browser holds, and evicting what it no longer needs
  are the framework's bookkeeping, not yours.
- **A scene your code decides.** A control on screen reports the user's input and changes nothing
  locally; your Julia code answers with the scene that follows. Nothing on screen can disagree with
  what your code believes.
- **Three places to put the scene.** A browser tab, a VSCode tab, or a recording that a static page
  replays with no Julia process anywhere.

## Two languages, one repository

| Path | What is in it |
|---|---|
| `src/`, `test/` | the Julia package |
| `lib/` | the viewer: the Core, the three hosts, the four vendored modules, and `build.mjs` |
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

```julia
using Pkg
Pkg.add("CesiumLink")
```

## License

MIT. See [LICENSE](LICENSE). The viewer artifact carries the CesiumJS runtime, which is Apache-2.0 —
see [NOTICE](NOTICE).
