---
status: accepted
---

# An addressed box raises its own pointer events

The `ui` module puts boxes on screen: the overlay rows, the group boxes, and the floats. A toggle
and a select report the value the user chose, on the `ui` module's `control` topic. Nothing else
about a box travels upward. A click on a title reaches no listener, and neither does the pointer
entering or leaving a float.

The Core already dispatches pointer events, in `lib/core/src/picking.ts`. It reads one pixel with
`drillPick`, resolves every owned hit to the module that stamped it, and forwards the event upward
when the subscription asks for it. That path serves entities drawn into WebGL. A box is DOM above
the canvas, so `drillPick` never returns one.

## Decision

**The `ui` module raises pointer events for its own boxes, on the `ui/pointer` topic.** ADR-0003
says a module installs no `ScreenSpaceEventHandler` of its own, and that rule stands here. A
`ScreenSpaceEventHandler` reads the canvas. The `ui` module listens on the DOM elements it built and
already holds. The two paths never see one gesture: a box takes the pointer off the canvas, so the
Core raises nothing while the cursor is over one.

**An id is the address, and a box that carries one is an addressed box.** `Title`, `Legend` and
`Group` gain an optional `id`, which `Toggle`, `Select` and a float already carry. It is the same id
space a window's `per_keyframe` entries address, so one name reaches a box for both jobs. A box with
no id raises nothing.

**A box raises three types: `:click`, `:enter` and `:leave`.** A box has edges, so entering it and
leaving it happen once each. There is no debounce, no timer, and no interval to configure. The
globe's `:hover` needs an interval because it reports a position over a surface that has no edges.

The two DOM events are `mouseenter` and `mouseleave`, which do not bubble. One box therefore raises
one crossing, whatever its children are.

**The modifiers are the set held at the moment of the crossing.** A `MouseEvent` carries `altKey`,
`ctrlKey` and `shiftKey`, and the module reads them off the event. A key pressed after the pointer
is already inside a box raises nothing, because the browser fires no event for it. Live reaction to
a key belongs to a module of your own: `defineWidget` hands your factory the element, and the
factory closes over your module's `ctx`, so it listens for the key, restyles itself, and reports on
its own topic with no wire round trip.

**The subscription is derived from the registered listeners, and it narrows by id.** The server
unions every `on_ui_pointer` listener into one `ui/subscribe` command and re-declares it whenever
the set changes, the way `core/subscribe` works. An entry names an id, a type and a modifier set,
and a null in any of the three matches anything. Narrowing by id matters most for `:enter` and
`:leave`: sweeping the pointer across a panel of six boxes would otherwise cost twelve round trips
that nobody asked for.

**Removing a box while the pointer is inside it raises a synthetic `:leave`.** The browser fires no
`mouseleave` when an element leaves the document, so a float that a re-declaration drops would
strand a listener that had seen its `:enter`. The module holds one flag per box and raises the
`:leave` from the remover it already returns. Every `:enter` is answered by one `:leave`.

**A click on a toggle raises both `ui/control` and `ui/pointer`.** The two say different things, and
a listener asked for both. Their order is not guaranteed, because they travel as two events. A
toggle shows the declared value again after every click, so a server that acts on the click and
declines the value change leaves a correct box with no extra work.

**The payload is flattened onto the event, as `core/pointer` is.** A listener reads `ev.type`,
`ev.id`, `ev.mods` and `ev.screen`. `wants` in `src/events.jl` reads `ev.type` and `ev.mods` at the
top level as `Symbol`s, so the same modifier filter serves both pointer paths with no change.
`ev.screen` is measured against the viewer container, which is the space a `Screen` anchor places a
float in.

## Alternatives declined

**Ride `core/pointer` with a synthetic pick entity.** A box would arrive as a `PickEntity` of
`{module: "ui", kind: "title", idx: n}`. A box has no index, `drillPick` never returns one, and the
Core would gain a DOM path beside its WebGL one. The Core would then own two kinds of picking, and
the seam ADR-0003 draws would be harder to state, not easier.

**A field on the declaration, such as `Title("x"; id = "t", events = [:click])`.** It reads as an
opt-in where the box is declared. It also drifts from the listeners: a declaration listing events
with no listener behind it pays for traffic nobody reads, and a listener with no flag on the
declaration never fires and says nothing. The Subscription rule in the glossary exists to make that
pair impossible.

**`:hover` with a debounce, matching the globe's vocabulary.** One vocabulary across the globe and
the overlay is worth something. It costs a timer in the `ui` module, a `debounce_ms` keyword, and an
encoding for "the pointer left every box" as a hover with no box in it. Crossings give the same
answers with none of that.

**Re-raise a crossing when a modifier key goes down or up.** It would make `alt = true` on `:enter`
mean "alt held while inside the box". It needs a key listener on the window, a record of which box
the pointer is in, and a rule for what a `:leave` means when only a key was released. A custom
widget covers the case that wants it.

## Consequences

`PROTOCOL_VERSION` stays 2, and this record is part of what 2 means. ADR-0034 moved the number from
1 to 2 for the 0.2.0 release, and that release is not out: `main` still declares 1. Shipping the two
topics inside the same release makes every viewer that speaks 2 speak them.

**This has to land before 0.2.0 ships.** Landing it afterwards costs a move to 3. A released viewer
at 2 would route a `ui/subscribe` command by `(module, topic)`, find no handler, and ignore it. The
listener would then never fire, with no message anywhere.

`RECORDING_VERSION` stays 2. A recording carries declarations and windows. A subscription is derived
from the listeners of a live server, so it is never recorded.

**A listener answering `:enter` runs on the listener chain and delays every other contribution to
that event.** The rule the glossary states for a hover listener applies here: do not re-derive.

**`Title` and `Legend` stop being purely passive.** Their widget factories still receive no `report`
callback, so they still cannot send a value upward. What changed is that the module now watches
their elements.
