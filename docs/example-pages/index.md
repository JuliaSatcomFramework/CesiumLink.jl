# Examples

Each example is a whole runnable program. The tutorials teach one lesson at a time and the how-to
guides answer one problem each, so both show fragments. An example shows everything a working scene
needs.

**Examples is not one of the four [Diátaxis](https://diataxis.fr) sections.** It shows the four
sections' material standing together.

The four examples form a ladder. The rung is which part of the API the author reaches for.

| Rung | What the author writes | Example |
|---|---|---|
| 1 | a script that calls [`push_window`](@ref) | [Solar elevation](solar-elevation.md) |
| 2 | a script that holds a scene and answers for it | [Satellite trails](satellites.md) |
| 3 | a package with a scene type and a [`serve_scene!`](@ref) method | [Constellation](constellation.md) |
| 4 | the same, plus a viewer module and its JavaScript | [Satellites over a region](region-count.md) |

A fifth example stands beside the ladder rather than on it.
[A line material of your own](pulse-edges.md) is small, and it shows the one thing the four rungs do
not: a module that adds to what a vendored module draws, instead of drawing something of its own.

The code of each one is on its page, and in the package under `examples/`. Every example runs during
the documentation build, and the scene on each page is a recording of that run, played in the
browser with no Julia behind it — see [Record and replay a session](../how-to/record-replay.md).

## Run an example

Clone the repository, load CesiumLink, and include the example file. The include sets up the
environment beside the example, starts the server, prints the address of the viewer, and gives the
server back.

```julia
using CesiumLink

server = include(joinpath(pkgdir(CesiumLink), "examples", "Satellites", "run.jl"))
```

Open the address it prints. Stop the server when you finish:

```julia
stop_server(server)
```

The other four take the same line with their own path: `examples/solar_elevation.jl`,
`examples/Constellation/run.jl`, `examples/RegionCount/run.jl` and `examples/PulseEdges/run.jl`.

Run one as a program instead, and it waits for Enter and then stops the server itself:

```sh
julia examples/Satellites/run.jl
```

The include makes the environment of the example the active one, so activate your own project again
afterwards. It also needs a clone: no registry holds CesiumLink, so each example finds the package
by path.

`examples/setup.jl` does that work, and every `run.jl` includes it. It says nothing about the scene,
so the lines that use it are marked `# hide` and each listing leaves them out.
