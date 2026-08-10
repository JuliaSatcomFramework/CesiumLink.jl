---
status: accepted
---

# Cross-module sharing is code reuse, not a Core mechanism

Modules that derive from the same simulation base share their **authoring code**, not their
**runtime state**. Take a constellation base package: an elevation-statistics heatmap needs only that
base, while a rain-fade heatmap and a capacity renderer each need a solver layered on top of it. So
the Core carries no generic cross-module machinery. Each module is an independent co-load.

The mechanism is `ctx.modules.get(id)`, which returns another module's **exports** — classes,
factories, functions — and nothing else. What crosses a module boundary is code by construction.

## The rule

**One owner per entity. Other modules get read-only accessors. Writes never cross a module
boundary.** A module may draw over what another draws; it may never restyle or mutate it. Anything
that should persist is data, and the server sends it.

"Code crosses, state does not" is the shorthand and not the rule, since a position accessor plainly
returns state. The owner publishes a one-way accessor — where an entity is, and the pick stamp that
says who it is — and a module drawing alongside reads it every frame.

The rule bounds what modules take from *each other*, not what the Core hands each of them.
`ctx.placement(index)` — which window carries an absolute keyframe, and the offset within it — is a
value the Core already computed to build that window, handed to every module alike. No module can
reach another's state through it, so it is not the generic cross-module machinery this record
declines. Three modules each rebuilding the same mapping, from the same windows, against three
copies of one retention bound, is the Core's own answer written down four times.

## The two kinds of sharing

- **Code reuse, in Julia and possibly in JavaScript.** Several modules' Julia halves extract
  entities and geometry from the same simulation base. This is a package-structure concern — a
  shared library — and it asks nothing of the Core.
- **Viewer-side runtime state sharing.** One loaded module reads another's live, per-tick state in
  the browser. This is served by the read-only accessor above, and by nothing more general.

## A heatmap is a vendored module

**A module is vendored when its vocabulary is domain-free.** A heatmap drapes a scalar field over
the globe. It does not know whether the scalar is an elevation angle or a rain fade, exactly as
`primitives` draws geometry without knowing that a node is a satellite. The test is what the module
must be told, not who wants it: a module that names a domain concept ships from the package that
owns that concept, and a module that names only a shape, a value or a colour is vendored.

By that test the heatmap belongs with `primitives`, `models` and `ui`, and a scene reaches it
through `vendored(:heatmap)`.

The independent-module case stands for a module that *is* domain-specific. What this record denies
is that "heatmap" names such a module. Two heatmaps over one simulation base share their Julia
extraction code and stream separate payloads into one vendored module — the shared JavaScript this
record anticipates turns out to be the vendored module itself.

## Considered options

- **Code reuse through shared packages** (chosen): the sharing that is real lives in Julia, and
  later JavaScript, libraries. The Core stays schema-agnostic.
- **Two generic Core hooks — publish-named-shared-state and `requires`.** Rejected: it has no
  consumer. A named registry's only reader is served by the read-only accessor above, and no module
  depends on another at load time, so `requires` guards nothing. It would grow the Core for modules
  that are, on the viewer side, mutually independent.
- **A base viewer module owning and publishing an entity registry, with every other module declaring
  `requires: base`.** Rejected: no module consumes another's viewer-side entity state. The generic
  renderer is the only entity renderer, and heatmaps drape their own rasters. The shared base is a
  Julia authoring dependency, not a viewer module.

## Consequences

The Core carries nothing for cross-module concerns beyond the read-only accessor pattern and
`ctx.modules.get`.

The shared-library structure — a common authoring module, and shared entity-rendering code — is
designed when a second real user appears, and not before.
