---
status: accepted
---

# A model family hangs off a node family

A node family is one draw command. `lib/primitives/src/nodes.ts` opens by saying so: one
billboard collection holds the whole family, and colour, size and visibility are attributes of its
batch. That is what makes several thousand entities usable, and the headless harness gates the count
because nothing else in the tree would notice if it changed.

A glTF model cannot join that batch. Cesium draws a model as its own primitive, through the entity
visualizers. A spike on the demo constellation measured the cost:

| camera | draw commands |
|---|---|
| inside the model's range | 5 for one model |
| outside it | 0 |

So a model is affordable, and only while the range says it is. The question this ADR answers is which
word an author writes to ask for one, because the word decides whether the cost is visible.

## Decision

**A model is its own family, in a vendored module of its own, and it carries no positions.**

```julia
Nodes(:sat;      position = pos, marker = :disc, size = 8)          # primitives
Models(:sat_body; of = :sat, uri = "assets/models/sat.glb",         # models
       range = (0, 2e6), frame = :enu, orientation = q, scale = 1e6)
```

`of` names the family the models stand on. The `models` module reads that family through the
read-only exports `primitives` publishes — its live position and its pick stamp — which is the
**anchor** of ADR-0023. Positions travel once. The marker and the model cannot disagree about where a
satellite is, because there is one array and both read it.

**`models` is a module, because `primitives` says it must be.** The charter at the head of
`lib/primitives/src/nodes.ts` states what that module refuses to draw: "custom shaders,
materials or textures … are what a module of your own is for." A glTF file carries its own materials
and textures. Nothing in `primitives` then touches the entity API or the `DataSourceDisplay`, and a
family there stays one draw command.

`models` is also the worked example. Whoever writes a sensor cone, a coverage ellipsoid or a swath
has a module in the tree that does the same thing, with the same anchor, at the same size.

**`range` is required.** It is the only thing between a modelled constellation and forty models
drawn at mission zoom. An author who must write it is an author who has thought about it.

**A frame and an orientation compose.** `frame` names the reference frame — `:enu`, `:velocity`,
`:nadir` or `:ecef` — and Cesium builds it from the position the family already has. `orientation` is
an optional quaternion knob, four numbers per entity per keyframe, and it turns the model inside that
frame. `frame = :ecef` with a quaternion is the fully explicit case. `frame = :velocity` with no
quaternion is the case that needs no attitude in Julia at all.

`axes` holds a fixed heading, pitch and roll correction for the model's own convention. Cesium takes
a model's +X as forward, and most files disagree.

**A model is picked as the node it stands on.** It carries the pick stamp `primitives` publishes for
the `of` family, so a click on the model and a click on the marker report the same entity — the
satellite, in the `primitives` namespace, as though no model existed. ADR-0023 holds that decision
and its cost.

**A model family has no colour.** What the model looks like is the file's business.

## Why not a keyword on `Nodes`

`Nodes(; model = "…")` needs no new family and no new word, and every other knob already means the
right thing. It also turns a family that costs one draw command into a family that costs one per
entity, and nothing in the vocabulary says so. The same objection answers `marker = Model("…")`: it
extends a field that is free today with a value that is not.

Two words for two costs is the point. An author reading a scene can see which families are cheap.

## Alternatives declined

**A model family with its own positions.** A family exactly parallel to the other three, and simpler
to explain. Pairing a model with a marker then means declaring the same positions twice, in two
places that drift.

**A fourth family inside `primitives`.** One package, one build entry, one namespace, and `of` stays
an internal map lookup instead of a call across modules. It puts the entity API and a `.glb`'s
materials inside the module whose charter excludes both, and it gives a third-party cone author no
example to copy — the one thing in the tree that draws an anchored primitive would be unreachable
inside a module they cannot extend.

**The whole entity API, rather than models.** Of the seventeen entity graphics, `billboard`, `point`,
`label`, `polyline`, `polygon` and `ellipse` are what `primitives` already draws. `cylinder`,
`ellipsoid`, `wall`, `corridor` and `polylineVolume` are real gaps — sensor cones and swaths — but
they are geometry, and geometry batches. They belong in families of their own, drawn the way `Areas`
is drawn, not one entity each. `path` samples a position property across time, which fights the
window buffer. `viewFrom` and `description` and `availability` repeat the camera authority of
ADR-0017, the float, and a keyframed `show`.

What is left that only the entity API gives is a glTF model with an orientation. That is the scope.

## Consequences

A scene that draws a model declares two modules, and `models` alone draws nothing: every family it
holds names a family in `primitives`. Which order they are declared in does not matter, because
ADR-0009 made declaration order non-binding and the loader imports every module before it runs any
`setup`.

`of` names a family, not a module. A model family therefore anchors to `primitives` and to nothing
else. That is a limit worth keeping until something needs otherwise: a module name on the wire is
easy to add and hard to remove.

Two model families may stand on one node family. A satellite body and an antenna that turns
independently are two `Models` over one `Nodes`, each with its own orientation. Cesium's
`Entity.parent` does not compose transforms, so nothing is lost by having no parent concept: whoever
draws such a pair composes the rotation in Julia either way.

`of` gives no offset. A model mounted away from the centre of the thing it rides needs its own node
family, carrying the offset positions from Julia.

An interactive attitude is a **Control**, and ADR-0007 answers a control with a replacement window.
Dragging an angle is therefore a round trip for every step, which is cheap on one machine and slow
over a wide-area link. A recording answers no control at all, so a recorded scene shows the attitude
it was recorded with.
