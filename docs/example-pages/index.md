# Examples

Each example is a whole runnable program. The tutorials teach the system a lesson at a time and the
how-to guides answer one problem each, so both show you fragments. An example shows you everything a
working scene needs, and nothing it does not.

**Examples is not one of the four [Diátaxis](https://diataxis.fr) sections.** It answers no need of
its own. It shows the four sections' material standing together, which is the one thing none of them
does.

The four examples form a ladder. The rung is not how many files an example has — it is which part
of the API its author reaches for.

| Rung | What the author writes | Example |
|---|---|---|
| 1 | a script that calls [`push_window`](@ref) | [Solar elevation](solar-elevation.md) |
| 2 | a script that holds a scene and answers for it | [Satellite trails](satellites.md) |
| 3 | a package with a scene type and a [`serve_scene!`](@ref) method | [Constellation](constellation.md) |
| 4 | the same, plus a viewer module and its JavaScript | [Satellites over a region](region-count.md) |

The code of each one is on its page. It also sits in the package, under `examples/`, so a clone
carries it and you can run it where you read it.

Every example runs during the documentation build. The scene on each page is a recording of that
run, played in the browser with no Julia behind it — see
[Record and replay a session](../how-to/record-replay.md).

## Run an example

Each example is one `include` away from a running server. Clone the repository, load CesiumLink, and
include the file: the include sets up the environment beside the example, starts the server, prints
the address of the viewer, and gives the server back.

```julia
using CesiumLink

server = include(joinpath(pkgdir(CesiumLink), "examples", "Satellites", "run.jl"))
```

Open the address it prints. Stop the server when you finish:

```julia
stop_server(server)
```

The other three take the same line with their own path: `examples/solar_elevation.jl`,
`examples/Constellation/run.jl` and `examples/RegionCount/run.jl`.

Run one as a program instead, and it waits for Enter and then stops the server itself:

```sh
julia examples/Satellites/run.jl
```

Two things to know. The include makes the environment of the example the active one, so activate
your own project again when you go back to your own work. And it needs a clone: no registry holds
CesiumLink, so each example is told where the package is by path.

What does the work is `examples/setup.jl`, which every `run.jl` includes. It is machinery: it says
nothing about the scene, so the three lines that use it are marked `# hide` and the listing on each
page leaves them out.
