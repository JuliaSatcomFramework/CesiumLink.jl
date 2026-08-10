# Windows, keyframes and identity

Time-varying scene data reaches the browser in exactly one shape: a **window**, a contiguous run of
keyframes carrying every module's payload for those frames. There is no second carrier. A static
scene is a window of one frame.

This page states what a window promises, what it does not, and why the promise is attached to the
window rather than to the session.

## The declared range and the delivered buffer

Two ranges exist at once, and confusing them is the commonest way to misread the system.

The **declared range** is the whole run: an epoch, a keyframe step, and a total count, stated up
front by every window message. It is finite and known even when almost none of it has been
delivered. The clock, the timeline ruler and scrubbing all work against it.

The **delivered buffer** is the subset of keyframes the viewer currently holds. Interpolation works
against it, and against nothing else.

The separation is what lets a long run start immediately. A 240-keyframe mission declares 240 frames
in its first window and delivers two, and the ruler already spans the right dates. The alternative
designs both fail on something concrete. A range derived from the frames delivered so far makes the
ruler grow under the user's hand. An open-ended stream with no declared end takes the meaning out of
the ruler and out of scrubbing, and makes a loop impossible. What it buys is a flexibility the
domain does not need, since the runs on screen are finite and of known length
(ADR-0008).

An instant the buffer does not cover is not an error. The clock stops there, the last delivered
frame stays on screen, and the Core asks for the window that covers it. Starvation therefore reads
as a pause rather than as a stutter or as a wrong frame. The hold clears the clock's `canAnimate`
and never its `shouldAnimate`, so a pause the user pressed during a hold survives the release.

## What an index means

Inside one window, index `i` addresses the same object in every frame of that window. That is the
whole identity guarantee, and it is sufficient, because interpolation only ever brackets two frames
of the same window.

The guarantee is attached to the window because of what it has to serve. Per-tick interpolation
blends the position at index `i` in one keyframe into the position at index `i` in the next. An
index that means different objects in consecutive frames teleports every entity on every step. At
the other extreme, an index space fixed for the whole session means the payload can never shrink.
It also forces a filter to become a visibility mask, and a mask cannot express a filter that
changes derived values.

One consequence is structural rather than conventional: **every module's payload for the same frames
arrives in one message and installs together**. If two modules received their payloads separately,
there would be a span of one frame in which the scene and an overlay drawn over it disagree about
what index `i` addresses. A window is atomic because identity is per window.

## The two push kinds

Between windows, the rule is set by *why* the window was pushed.

A **streaming advance** tops up the buffer as playback approaches its end. The user asked for
nothing, so nothing may visibly move at the seam, and the advance **must** preserve the previous
window's index space. It travels as `mode: append` and repeats the window identity it extends.

A **control re-push** replaces the buffer in answer to an event. The user asked for a visible
change, so the window **may** re-index freely. It travels as `mode: replace` and mints a new window
identity.

The buffer has exactly two operations: extend, and clear and refill. They correspond one to one with
the two push kinds, which is what makes this a structure rather than a convention. There is no third
mode and no way to express one. A rule the data structure enforces does not have to be remembered.

The Core applies the rule strictly rather than trusting the label. An `append` extends the buffer
only if it genuinely continues it, at either end: its first frame is one past the last frame held,
or its last frame is one before the first. A clock running backwards consumes the buffer downwards
and is served windows that extend it that way. An `append` that leaves a gap or overlaps cannot be
interpolated across, so it clears the buffer and re-bases on itself, whatever its mode field says.
A server may therefore mark a window `append` even when it lands far from anything already sent. The
mode states the intent, and the viewer never claims coverage of frames it does not hold.

The buffer is bounded, and the bound travels with the clock. An extension past the bound drops
frames from the end playback is moving away from. The frames held therefore follow the clock
whichever way it runs, and a reversal moves nothing until an edge is approached. Only an extension
is bounded: a server that delivers a whole run in one window is not made to give any of it up. A
dropped frame is simply asked for again if the clock returns to it.

## Why interpolation never crosses a window

Two frames from different windows may carry different index spaces, so blending between them is
blending between two different sets of objects. The Core never offers such a pair. A module reads
its arrays through the **placement** of an absolute keyframe: which window carries it, and the
offset within that window. Two placements from one window are safe to blend; two from different
windows are two separate draws.

The same reasoning explains a rule that surprises module authors. The store a module keeps its
window payloads in is keyed on the **window object**, never on the start frame. A `replace` gives
the same absolute indices to a different window, so a number-keyed map addresses the wrong payload
across the seam. Keying on the object is also why the store needs no retention bound of its own: a
value becomes unreachable exactly when the Core stops naming its window.

## Keyframes and base rank

Inside a payload, a value may vary per keyframe or stand still for the whole window. The rule that
decides which is called the **base rank**, and the Core owns it
(ADR-0014).

A module knows the rank of the form it expects: 1 for one value per entity, 3 for an `[H, W, 4]`
raster. An array at or below that rank holds one value for the whole window, and every keyframe
reads all of it. An array one rank above it carries a leading keyframe axis, and keyframe `k` reads
the contiguous block at `k × block`. Any higher rank is an error.

The rule sits in the Core for a reason worth stating. It was previously decided in each module
separately, in four implementations with four conventions. It is not a domain question — it says
nothing about what the values mean — and it cannot be answered twice without the two answers
drifting apart. So the Core states it once, as `blockAt`, and checks it: an array whose leading axis
disagrees with the window it rode in on now throws instead of reading a short block.

What stays with the module is everything about meaning. The components an entity takes, the four
RGBA bytes of a texel, and a stride of zero that covers a whole family are all entity semantics. A
Core that knew any of it would have to model an entity. The line between the two is the line the
rest of the architecture draws: the Core owns arithmetic over arrays, and the module owns what the
numbers are.

Two candidate designs were declined for the same reason. A full slicer in the Core would absorb the
raster contract and the notion of a family. A `payloadAt(index)` accessor answers three of the four
modules and makes the Core retain payloads nobody reads. `primitives` keeps derived state rather
than the raw payload, and reads two placements at once across a seam.

## Where the requests come from

No module asks for a window. The Core watches the clock against the coverage it holds, and asks when
playback nears the edge it is heading for, or when the clock is scrubbed past coverage. The request
names an absolute start index and how many frames are wanted. It asks for one frame where the
window continues the buffer at either end, and two where it lands somewhere new, because
interpolation needs a neighbour to blend toward.

The count travels with the request, so the server needs no memory of what it has already sent. That
matters more than it looks. It makes a server's answer a pure function of the request and the
server's own data, which is what lets a recorded session replay and a late client catch up.

The Julia side of all this is in the [windows reference](../reference/windows.md), and the wire
fields are in the [protocol](../reference/wire/protocol.md). To answer those requests in a program,
read [Deliver a long mission a piece at a time](../how-to/lazy-delivery.md).
