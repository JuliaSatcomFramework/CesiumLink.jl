---
status: accepted
---

# An anchored primitive borrows its anchor's identity

A module can already follow what another module draws. The Core's own node-position registry is
retired, and ADR-0006 records what replaced it: a module publishes read-only accessors through its
exports, and a peer reads them through `ctx.modules.get(id)`. `positionOf(kind, idx)` in `primitives` is the one instance
today, and a **float** already anchors to "an entity some module owns and can be asked the position
of".

Position is not enough for anything the pointer can hit. A sensor cone drawn over a satellite by a
module of its own is either unpickable, or it reports an identity no server listener knows about.
`ctx.pickId` closes over the calling module's own id, so a cone cannot say "this is satellite 12"
even though that is exactly what it is.

The cost of leaving it there falls on the wrong person. Whoever writes a cone has to write picking,
and whoever writes the Julia listener has to learn a second kind that means the same satellite.

## Decision

**A module that owns entities publishes their pick stamps, and a module that draws something
anchored uses the stamp it is given.**

```ts
// lib/primitives/src/index.ts, beside positionOf
export function pickIdOf(kind: string, idx: number): object | undefined
```

The stamp is opaque. A peer sets it as its primitive's `id` and does nothing else. The Core keeps
the hit, because the object it is handed is the stamp the Core minted. The drill stack removes a
repeated `module|kind|idx`, so the cone and the satellite's own marker collapse into one entity —
the same code path that already makes an area's fill and its outline count once.

**A hit reports the anchor, not the drawer.** A click on the cone answers
`{module: "primitives", kind: "sat", idx: 12}`. A listener written for the satellite fires, and it
never learns that a cone exists.

**Anchoring is voluntary and one-way.** The owner publishes an identity; nobody writes to anybody's
scene. A module that wants an identity of its own keeps calling `ctx.pickId`, which is unchanged. The
choice is per family, made by whoever draws.

**The Core reads a stamp through one extra step, for primitives drawn as entities.** Cesium's
visualizers set an entity's primitives' `id` to the `Entity`, so a stamp cannot be the `id` there. The
Core therefore also accepts a stamp carried on a known property of the `id`. The `instanceof` check
stays first, so a primitive carrying no stamp is still decoration and never masks a pickable
underneath it.

## Why not a registry in the Core

ADR-0006 rejected generic cross-module machinery — "publish-named-shared-state" hooks and a
`requires` graph — and chose exports. The node-position registry was the one Core seam of this kind,
and it was retired for having a single publisher and a single reader.

An anchor export costs the Core one fallthrough in `pickAt` and nothing else. A registry would put
the ownership graph back in the Core, where nothing needs it, and would let a module claim an
identity its owner never offered.

## Alternatives declined

**Let a module mint a stamp for any `(module, kind, idx)`.** Three lines, and no export needed on
either side. It also lets any module speak for any other's entities with no consent, which is the
difference between borrowing and impersonation. Nothing detects it, and the module being spoken for
cannot stop it.

**Report both entities in the stack.** The pointer event carries the drawer's entity and the
anchor's, and a listener reconciles them. It is honest about which geometry was hit. It also puts the
work back on every listener, which is what this decision exists to remove, and a listener that
forgets to reconcile looks correct until a cone appears.

**Anchor by position, and let the Core work out what was hit.** No export, no stamp. It cannot
distinguish two entities at one point, and it makes every pick a spatial search.

## Consequences

A pick says which entity was hit and not which primitive drew it. That is the point,
and it is a loss: a scene that wants a click on the cone to differ from a click on the satellite must
give the cone its own identity, and then reconcile the two in the listener. Both are available; the
anchored one is the default because it is what a cone author wants.

The anchor surface grows by what an anchored primitive needs, and each addition is a read-only export
on the module that owns the entities: where it is, whether it is shown, and which way it points. None
of it belongs in the Core.

An anchor that is gone answers `undefined`, the way `positionOf` already does for a kind no family
owns and an index a family does not have. A module that draws over another's entities must handle
that on every frame, because a window can prune the family it anchors to.

This is what makes a **model family** a module of its own rather than a fourth family in
`primitives`. See ADR-0022.
