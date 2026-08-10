---
status: accepted
---

# The Core's own on-screen items are one declared set

The Core builds a clock, a ruler, a keyframe readout and two buttons before any module loads. The
server could address none of them. Two of them also painted under whatever a module contributed to
the same corner, because a region host carries `z-index:5` and these cells carried none.

Naming the class is most of the decision, because the repo already has three words for
neighbouring things. `chrome` means the border and background a `ui` panel wears. `widget` means a
kind the `ui` module registers. `vendored` means shipped inside the core dist. None of them
describes an item the Core places itself.

## Decision

**The class is called furniture, and the defining property is placement authority.** A control
names its own region per item, carries a declared value, reports the user's input, and needs a
module to exist. Furniture does none of that: the Core places it, and the server states only which
pieces are on screen. The name is by role and not by provenance, because the set is not uniformly
Cesium's — the keyframe readout is a plain `<button>` written here, and it is the item this change
moves.

**One retained command carries the whole set.** `core/furniture` states every item every time.
Retention holds one message per `(module, topic)`, so a stream of partial patches would replay only
its last frame to a reconnecting client. The Julia call takes keyword arguments with defaults, which
is how a whole statement is written when the item set is fixed and known. Two calls do not
accumulate. This is what `declare_overlay` already means.

**An item that is off by default is not constructed.** `CesiumInspector` is a panel with its own
view models, and a session that never asks for it must not pay for it. A declaration that turns one
on builds it; one that drops it destroys it. The three default-on additions cost nothing measurable
and stay eager.

**The keyframe readout stays in the Core.** It is furniture, so it must work in a session that
declares no `ui` module — which is exactly the session a bare Core is meant to serve. Making it a
`ui` widget kind would have removed the Core's one opinion about presentation, and taken the readout
away from every scene that does not load `ui` to get it.

**`timeless` is retired into this.** A window field said its one keyframe named no instant, and the
viewer hid the ruler, the clock and the readout from it. That is a second mechanism writing one
element's visibility, and the pair cannot be reasoned about locally: whichever setter runs last
wins, so a furniture declaration arriving after a timeless window would silently re-show a ruler for
a scene with nothing to scrub. A server now states a timeless scene by declaring no time furniture.

**The ruler is guarded by a warning rather than by a refusal.** Hiding the ruler on a range of more
than one keyframe strands frames 2..N, because scrubbing is the only way to reach them. The viewer
warns on exactly that condition and then obeys the declaration: an operator who hides a ruler on a
long range has been told, and it is their call.

**One layout pass owns every number that depends on the set.** Four constants described one layout
across two files, each commented to point at the other. Three of them are wrong the moment furniture
toggles: a hidden ruler leaves the `bottom-right` region floating over an empty band, and a hidden
clock leaves the ruler starting 180px from an edge with nothing before it. The pass writes them all,
and reaches the overlay through `setBottomInset`.

## Alternatives declined

**Keep `timeless` and let it win over the declaration.** `visible = declared && !timeless` is six
lines and preserves work that had just landed. Declined because it keeps two sources of truth for
one property, and it is correct only while both setters route through one apply step — a
correctness that is invisible at each call site and survives exactly until someone adds a third
setter.

**Keep `timeless` as the thing that sets the defaults.** The data informs, the operator decides.
Declined because it makes `declare_furniture(server)` mean different things before and after a
timeless window arrives, which is a trap given a declaration is defined as a whole statement.

**Name the class by provenance — Cesium widgets, or vendored widgets.** Declined on a fact: the
keyframe readout is not one, and `vendored` already means shipped in the dist. A name that is false
for the item under change is worse than a new word.

**Per-item regions, so each button names its own.** It would make furniture behave exactly like a
control. Declined because it dissolves the group: six regions to lay out, six disposals, and the
shared style and tighter gap lose their meaning. The group travels whole and names one region.

**Build every item and toggle only `display`.** One code path, no construct-and-destroy lifecycle.
Declined for the inspector alone, and because a hidden element measures 0 — the trap the animation
widget already needs a re-measure on reveal to work around, which lazy construction sidesteps for
everything that starts off.

## Consequences

Furniture stops painting under a module's controls, because the group is contributed through
`addControl` like anything else and inherits the region's stacking rather than fighting it.

`top-right` becomes a row, so a colorbar sits beside the buttons rather than under them. This is the
direction-aware stacking ADR-0004 deferred until a real layout demanded it. In live code that region
only ever holds one legend, so no existing declaration changes shape.

The `window` message loses a field one commit after gaining it. That is cheap here and would not be
elsewhere: this tree has no back-compat burden and the wire restarts at v1.

`clock-ui.ts` gains its first test, indirectly. The layout arithmetic and the placement-property
filter move into a pure module that needs no DOM, no Cesium and no browser. Cesium construction
stays untested, which is what it was.

The set gains `cameraFollow`: the item that says who is moving the camera, and offers the way back
to the track (ADR-0017). It is on by default and hides itself until a viewpoint applies, so a
session that sends none never renders it. It is also the first item whose declaration governs
display only — the camera authority behind it runs whether or not the item is on screen, so a page
that declares it off still ignores viewpoints after the user takes the camera.

A future change that adds an item touches one map and one default table. A future change that
proposes moving the keyframe readout into `ui`, or re-deriving furniture visibility from the data,
should read this first.
