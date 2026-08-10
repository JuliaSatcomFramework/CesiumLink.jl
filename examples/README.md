# Examples

Four whole runnable programs. Each one shows everything a working scene needs, and nothing it does
not. The documentation site gives every example a page, with the code on it and a recording of the
scene it draws: see
[Examples](https://juliasatcomframework.github.io/CesiumLink.jl/dev/examples/).

| Example | What it draws | What its author reaches for |
|---|---|---|
| [`solar_elevation.jl`](solar_elevation.jl) | the height of the sun over the whole globe, at one instant | a script that calls `push_window` |
| [`Satellites/`](Satellites/run.jl) | sixty real low-orbit satellites, each with a glowing trail | a script that holds a scene and answers for it |
| [`Constellation/`](Constellation/run.jl) | forty satellites, their ground cells, gateways and links | a package with a scene type and a `serve_scene!` method |
| [`RegionCount/`](RegionCount/run.jl) | satellites over Europe and Africa, and a chart beside the globe | the same, plus a viewer module and its JavaScript |

## Run one from a session

Load CesiumLink, then include the example. One line does the rest: it sets up the environment beside
the example, starts the server, prints the address of the viewer, and gives the server back.

```julia
using CesiumLink

server = include(joinpath(pkgdir(CesiumLink), "examples", "Satellites", "run.jl"))
```

Open the address it prints. Stop the server when you finish:

```julia
stop_server(server)
```

The other three examples take the same line with their own path:

```julia
include(joinpath(pkgdir(CesiumLink), "examples", "solar_elevation.jl"))
include(joinpath(pkgdir(CesiumLink), "examples", "Constellation", "run.jl"))
include(joinpath(pkgdir(CesiumLink), "examples", "RegionCount", "run.jl"))
```

Two things to know. The include makes the environment of the example the active one, so activate
your own project again when you go back to your own work. And it needs a clone: CesiumLink is on no
registry, so each example is told where the package is by path.

## Run one as a program

```sh
julia examples/Satellites/run.jl
```

A program has no session to give the server to, so it waits for Enter and then stops the server.

## `setup.jl`

[`setup.jl`](setup.jl) is what makes both of those work: it activates the environment beside the
example, tells that environment where this checkout is, and starts or hands over the server. It is
machinery and says nothing about the scene, so the three lines that use it carry a `# hide` marker
and the listing on the documentation page leaves them out.
