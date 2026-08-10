---
status: accepted
---

# A float's rect is user state, held by CesiumLink

Everything on screen today is a function of what Julia declared. A float's position is
not even stored: `reposition()` recomputes it every frame from the float's anchor, and
its size is whatever its content and `style` come to. Letting the user drag and resize
a float introduces the first piece of viewer state whose author is the user rather than
the scene, and the question is where that state lives and who may overrule it.

## Decision

**A drag re-anchors the float.** On pointer release the box's top-left becomes a
`Screen` anchor, replacing whatever the float was declared with, and its size becomes
CSS `width`/`height` merged into the float's existing `style`. The anchor union already
expresses exactly what a dragged float is, and `applyStyle` already writes width and
height, so the only new field on the wire in either direction is the `adjustable` flag
itself. A float pinned to a satellite therefore stops following that satellite the
moment it is nudged — the cost of having one placement concept instead of an anchor
plus an offset.

**A declared rect is an initial condition, not a binding.** It is applied when a box is
created and ignored for a box already on screen. This is a deliberate exception to the
overlay's rule that a widget always shows the value it was declared with, and the
exception holds because a rect is not scene state: nothing is filtered by where a box
sits, so a viewer showing one rect while the server believes another misleads nobody.
What it buys is that a declaration already in flight when the mouse is released cannot
snap the box back — a race whose window is a full round trip, and this viewer has been
measured at a p95 of 1.4 s over a WAN hop.

**CesiumLink holds the override.** It registers its own listener on the `ui` module's
`rect` topic, records `{x, y, w, h}` per float id, and stamps it onto every outgoing
`declare_floating`. On each event it re-sends the last declared set immediately, so the
copy the server retains for a late client is current rather than one scene declaration
behind. An override is forgotten when a declaration omits that id, and the whole store
is cleared when a scene is replaced. `adjustable = true` therefore needs no scene code:
this is the same reasoning that put `closable` in the declaration rather than leaving
every scene to reimplement dismissal.

**A `Screen` anchor means the box's top-left, exactly.** No gap, no flip, clamped only
so the box stays inside the container; `Entity` and `World` anchors keep the existing
14 px offset and edge flip, which is what naming a thing to sit *beside* wants. Without
this the two halves of a round trip disagree and a dragged float drifts 14 px further
down-right on every reload.

## Alternatives declined

**Keeping the rect in the browser only.** Reconciliation already leaves an untouched
float's element alone, so a per-id map in `floating.ts` would survive re-declaration for
roughly fifteen lines and no wire change at all. It cannot survive a reload: the
retained declaration replays the float but not where the user put it, and persistence
is the point.

**Binding declarations, like every other declared field.** One rule for the whole
overlay, and Julia could reposition a live box. It reopens the race above, and the
suppression that would close it — per-id pending state and sequence numbers in
`floating.ts` — is more machinery than the exception costs.

**The scene owning the override.** CesiumLink stays a pass-through and all state sits
in the scene, matching how the `close` topic works. But `close` changes *which floats
exist*, which is the scene's business, while a rect changes only where a box sits,
which the scene does not model. Left to the scene, every one of them writes the same
listener and the one that forgets silently loses the rect on its next declaration.

**An offset from the anchor instead of re-anchoring.** A dragged float would keep
following its entity at a new distance. It is the better behaviour for a pin and it was
declined anyway: it means a second placement concept beside the anchor, and a
precedence rule between them, for floats that are mostly screen-anchored already.

**Vendoring interact.js.** Mature, MIT, and does drag and resize on every edge. It
bundles to 96 KB minified against a `ui` module that is currently 19 KB and loads in
every scene, and it would still leave the translation into this model to be written.
The interaction it replaces is the browser's own `resize: both` plus about twenty lines
of pointer capture.

## Consequences

A scene cannot reposition a float the user has touched. A reset means dropping the
float from the declared set and declaring it again. The exception is scoped to the browser that made
the drag: a box holds its own rect against a later declaration, and a box no one touched
here is placed by that declaration as usual. So a second live browser follows the first's
drag as soon as the stamped set is re-sent, which is the wanted end state — one scene,
one thing on every screen. The race the exception closes is unaffected, because the
declaration that could snap a box back can only be racing the drag that box just had.
CesiumLink gains mutable per-server state keyed by float id and
starts interpreting an incoming payload rather than passing it up, which is a short list
it now joins, and its built-in listener moves the listener-count baseline by one.

The resize corner is marked by a wedge the box draws as its own `::after` while the
pointer is on it, not by `::-webkit-resizer`: Blink repaints a resizer only when
something else invalidates the element, so a `:hover` rule on it matches and draws
nothing. The wedge takes no pointer, so the browser's own resize corner still receives
the drag, and being ordinary CSS it reaches Firefox as well.

The scrollbar is shaped through `::-webkit-scrollbar`, which Gecko does not know, and
Firefox draws its stock bar there. Each of those rules must stand alone rather than in a
selector list, since one unknown selector invalidates the whole list.
