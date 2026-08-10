---
status: accepted
---

# Picking is one unified handler list

The Core dispatches picking through a single ordered handler list. Per pointer move it does one
`scene.pick` and walks the hits under the cursor, keeping every one a module stamped with an id of
its own. Each kept hit is namespaced to its owning module as `{module, kind, idx}`. The pointer
event carries the whole stack, nearest first, with the nearest also offered as `entity`.

One mechanism serves both kinds of consumer: entity-ownership consumers, such as the generic
renderer and path highlighting, read `entity`; coordinate-sample consumers, such as the heatmap
module, ignore `entity` and read the globe coordinate to sample a field of their own.

The globe raycast is a flag on the subscription rather than a lazy accessor. "Is anyone going to
want this coordinate?" is answered once, by whether a registered listener asked for it, rather than
per move by whether a handler happened to call it. Within one event the coordinate is computed at
most once and memoised.

The dispatch carries no tooltip semantics. There is no content return value and no bail on first
content: every local handler sees every event. Tooltips are authored in Julia and delivered as
commands (ADR-0010), so the viewer has nothing to arbitrate. A local handler exists for a reaction
that must not round-trip — anchoring the tooltip box, tracking the cursor — and a handler that
*decides* something belongs on the server.

Choosing among the stack belongs to the listener. Knowing which of several coincident entities a
gesture was about means knowing what those kinds mean, which is the server's knowledge and never the
Core's: a highlight drawn over the shape it belongs to is nearest, and is rarely what the user
aimed at.

## Considered options

- **One handler list, with the coordinate asked for by subscription** (chosen).
- **Two channels** (`onEntityPick` and `onCoordinatePick`, the coordinate on an entity miss).
  Rejected: a module wanting *both* entity and coordinate cannot get the coordinate when an entity
  is hit. That forces either always-fire-both, with a cross-channel rule for which answer wins, or
  merging the coordinate into the entity channel, which rebuilds the unified handler. The apparent
  flexibility collapses on the first consumer that wants both.
- **An entity-only Core, with the heatmap faking a globe-covering pickable.** Rejected: an invisible
  globe-sized primitive shadows real picks and fights depth ordering.

## Consequences

Performance is bounded by the one unavoidable `scene.pick`. The coordinate raycast runs at most once
per move and only when a listener asked for it, so hovering an entity, or running with no heatmap,
costs nothing extra.

A module never installs its own `ScreenSpaceEventHandler`.

An id-less overlay drawn coincident with something pickable does not mask it. That is what makes
decorating by overdrawing work: one module draws alongside another's entities without hiding them
from a pick.
