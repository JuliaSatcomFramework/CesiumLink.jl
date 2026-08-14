---
status: accepted
---

# The vendored modules' payload vocabulary stays in CesiumLink

Roughly a thousand of CesiumLink's `src/` lines are neither the wire nor the server: they are the
**payload vocabulary** of the vendored browser modules. `primitives/` authors `primitives` payloads,
`ui.jl` authors `ui` payloads including the tooltip, `heatmap.jl` authors `heatmap` payloads and
`models.jl` authors `models` payloads. The glossary calls the thing that authors a module's messages
a *glue package*, and in Julia there is no such package: CesiumLink holds both roles.

Splitting the vocabulary into its own package is declined.

## Why the split is declined

**The vocabulary is what every glue package calls.** A glue package is the *translator* from a
simulation's own types into `Nodes`, `Edges` and `Areas`. The constructors themselves have to live
somewhere every translator can reach, and that is CesiumLink. Each example in this repository is
such a translator, and they all call the same constructors.

**The version gate is not enforced on the Julia side.** `MODULE_API_VERSION` is forwarded to the
viewer and checked in the browser, before the import. A separately versioned vocabulary package
would create a compatibility axis that nothing on the Julia side validates: a mismatch surfaces one
process away, as a module the Core skips with a console line, rather than as a resolver error. Fix
the gate before splitting, not after.

## The boundary that holds instead

There is no package boundary. There is a namespace boundary, checkable by reading:

- `events.jl`, `server.jl`, `static.jl`, `discovery.jl`, `editor.jl`, `imagery.jl`, `messages.jl`,
  `codec.jl`, `recorder.jl` and `geodesy.jl` name no module but `core` itself. The one exception is
  `vendored` in `artifacts.jl`, whose whole job is resolving a vendored module id to a path, so
  naming the shipped set is what it is for.
- Each vocabulary submodule names only its own module id.
- `colormap.jl` names no module id at all. It is neither vocabulary, and it sits at package top
  level where every vocabulary can reach it.
- A module's commands are authored in that module's vocabulary, including the ones built on a
  generic mechanism. `tooltip!` is `command!` addressed at `ui/tooltip`: the mechanism belongs to the
  event chain and the address belongs to the `ui` vocabulary.
- The sampling policy for a colorbar sits with the sampler, not with the widget that displays one.

The submodules re-export, so the line is held by reading and by one grep rather than by the
compiler. ADR-0012 states why re-export and compiler enforcement cannot coexist, and why the trade
goes this way. A vocabulary-to-vocabulary edge can only appear as a `using ..Primitives` line in a
submodule's header, where a reader sees it.

## Consequences

A reader answering "what does a `primitives` payload look like" reads one submodule, and one grep
says whether the boundary still holds.

CesiumLink is larger than its name suggests. A glue consumer outside this repository, wanting the
vocabulary without the server, is the point at which the seam stops being hypothetical and this
decision is worth reopening.
