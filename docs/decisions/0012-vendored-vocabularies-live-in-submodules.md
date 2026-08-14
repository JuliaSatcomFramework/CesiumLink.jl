---
status: accepted
---

# The vendored vocabularies live in submodules

Each vendored browser module's payload vocabulary is a submodule: `CesiumLink.Primitives`,
`CesiumLink.UI`, `CesiumLink.Heatmap` and `CesiumLink.ModelFamilies`. The wire-and-server half of the
package — `codec.jl`, `messages.jl`, `server.jl` and the six files the server was split into,
`events.jl`, `recorder.jl`, `camera.jl`, `furniture.jl`, `colormap.jl` and `geodesy.jl` — stays flat
at package top level.

**CesiumLink re-exports the vocabularies.** `using CesiumLink` alone supplies `Nodes`, `Title` and
the rest, so a consumer writes one line and no scene, test or script carries an import of its own.

## Why a namespace, when a file boundary already exists

ADR-0011 draws the boundary as a rule about which file may name what, checkable by reading and by one
grep. A namespace turns each vocabulary's dependency on the rest of the package into a declared list
in its header:

```julia
module Primitives
    using ..CesiumLink: rgba8
end

module UI
    using ..CesiumLink: Server, Reply, send_command, legend_stops
end
```

A dozen scattered references become a handful of names a reader sees before reading anything else.
That is the gain: a header that answers "what does this 500-line vocabulary need from the rest of the
package" without a search.

## Why the compiler does not enforce the boundary

Re-export and compiler enforcement are alternatives, not companions. Julia resolves a function body's
names at call time against the enclosing module, so once `CesiumLink` does `using .UI`, a function
defined in a file included *before* the submodule can call `Title` with no import and no error:

```julia
module Pkg
    core_uses_vocab() = Title("leak")    # defined first, in a flat file
    module UI
        export Title
        Title(s) = "UI.Title($s)"
    end
    using .UI                            # the re-export
end

Pkg.core_uses_vocab()   # "UI.Title(leak)" — resolves fine
```

Remove the `using .UI` and the same call is an `UndefVarError`. Include order buys nothing: only
top-level and struct-definition-time references are caught, and those are the minority.

The trade goes to re-export, because the enforcement is not free and is not needed. Its price is one
`using` line in every consuming scope — every `@testitem` block, every script under `tools/`, every
scene. Against that, the boundary it guards is one a reader can check: a vocabulary-to-vocabulary
edge can only appear as a `using ..Primitives` line in a header, where it is visible. The declared
header is what a reader actually uses, and re-export does not touch it.

The reverse edge is real rather than hypothetical: `start_server` calls `watch_float_rects!`, which
the `ui` vocabulary defines. Under compiler enforcement that call names a symbol the flat half
cannot see, and the package does not load. Re-export is what lets it stand.

**A blanket `using` carries nothing a submodule keeps to itself.** `using .UI` gives the parent no
binding for an unexported name, so the names a downstream author implements are listed one by one:

```julia
using .Primitives, .ModelFamilies, .Heatmap, .UI
using .UI: kind, payload, watch_float_rects!
```

The documented extension interface is therefore `CesiumLink.kind` and `CesiumLink.payload`: a
downstream control subtypes `CesiumLink.AbstractControl` and adds methods to those, exactly as the
`AbstractControl` docstring shows.

## What stays flat, and why

`colormap.jl` is consumed by a vocabulary and by consumer scenes alike — the `primitives` vocabulary
calls `rgba8` and scenes call `rgba`. Putting it inside a vocabulary would create the one edge this
boundary exists to prevent, one vocabulary importing from another.

`geodesy.jl` stays flat for two reasons of its own. **A submodule is earned by a vendored browser
module**, and file, submodule and wire id agree three ways; geodesy has no wire id and no browser
counterpart, so `CesiumLink.Geodesy` would be the one submodule that means something else. And **the
file is not a leaf**: its one CesiumLink-shaped part is `ecef(…; ellipsoid = server)`, a method on
the parent's `Server`, so a declared header would record that reach back rather than remove it. Note
that no file in the package calls `ecef` or `geodetic` — both are a convenience for consumer scenes,
so that neither a scene nor the package needs a geodesy dependency to place a point.

There is no `Core` submodule. `Core` already names the payload-opaque browser runtime, and a second
meaning inside CesiumLink would collide with it. The flat half needs no namespace to be protected in
any case: a submodule's names do not leak into its parent.

## A submodule may also be a namespace of constants

`Ellipsoids` is a table of reference ellipsoids — `WGS84`, `MOON` and `MARS`, each an `(; a, b)` pair
of radii in metres. It is the one submodule that is not a vocabulary, and the one the package does
not re-export.

A vendored module earns a submodule when someone writes vocabulary for it. That says which vendored
modules get one; it does not say a submodule must be a vocabulary. A namespace of constants earns one
for the same reason: it groups names that belong to one concept, and its header declares what it
needs from the rest of the package, which for a table of constants is nothing.

**It is not re-exported.** A vocabulary is called throughout a scene, so one `using` line per scope
is a real cost and re-export removes it. A table of bodies is read once per scene, at `start_server`,
so the cost is one qualification on one line — and the qualification is what tells a reader the name
is a body:

```julia
start_server(; ellipsoid = Ellipsoids.MOON)
```

A bare `MOON` in a scene reads as a variable the scene defined itself. `WGS84` lives in the submodule
and stays off the `export` list for the same reason: one home for the concept, and no body special.

The namespace itself is exported, so `using CesiumLink` supplies `Ellipsoids`. That carries no
constant up with it — `using CesiumLink; WGS84` is an `UndefVarError` — and `Ellipsoids` exports its
three names for a consumer who wants them bare through `using CesiumLink.Ellipsoids`.

## Naming

File, submodule and wire id agree three ways:

    src/primitives/  →  module Primitives  →  :primitives
    src/ui.jl        →  module UI          →  :ui
    src/heatmap.jl   →  module Heatmap     →  :heatmap

`models.jl` is the one exception, and a language rule rather than a choice: a module and a type
inside it cannot share a name, so `CesiumLink.Models` would resolve to the namespace and leave the
`Models` family unreachable. The submodule is `ModelFamilies` and the wire id is `:models`.

The naming rule does not reach `Ellipsoids`: file and submodule agree two ways,
`src/ellipsoids.jl` → `module Ellipsoids`, and there is no wire id to agree with.
