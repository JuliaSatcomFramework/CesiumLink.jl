# Windows, keyframes and identity

Time-varying scene data reaches the browser in one shape: a **window**, a contiguous run of
keyframes carrying every module's payload for those frames. There is no second carrier. A static
scene is a window of one frame.

## The declared range and the delivered buffer

Two ranges exist at once. Do not confuse them.

- The **declared range** is the whole run: an epoch, a keyframe step, and a total count. Every
  window message states it. The range is finite and known even when almost none of it is delivered,
  and the clock, the timeline ruler and scrubbing work against it.
- The **delivered buffer** is the subset of keyframes the viewer holds. Interpolation works against
  nothing else.

The separation lets a long run start immediately: a 240-keyframe mission declares 240 frames in its
first window, delivers two, and the ruler already spans the right dates. A range derived from the
frames delivered so far makes the ruler grow under the user's hand. An open-ended stream with no
declared end takes the meaning out of the ruler and out of scrubbing and makes a loop impossible,
for a flexibility the domain does not need (ADR-0008).

An instant the buffer does not cover is not an error. The clock stops there, the last delivered
frame stays on screen, and the Core asks for the window that covers it, so starvation shows as a
pause. The hold clears the clock's `canAnimate` and never its `shouldAnimate`, so a pause the user
pressed during a hold survives the release.

Dragging the ruler writes `shouldAnimate` false, exactly as the play button does, because moving the
clock by hand is a deliberate pause. The Core still asks for the window the scrub lands outside of,
and still installs it, but the clock stays where the user put it until the user presses play.

## What an index means

Inside one window, index `i` addresses the same object in every frame of that window. That is the
whole identity guarantee, and it is sufficient, because interpolation only brackets two frames of
the same window.

Per-tick interpolation blends the position at index `i` in one keyframe into the position at index
`i` in the next, so an index that means different objects in consecutive frames teleports every
entity on every step. An index space fixed for the whole session is the other extreme: the payload
can never shrink, and a filter becomes a visibility mask, which cannot express a filter that changes
derived values.

One consequence is structural: **every module's payload for the same frames arrives in one message
and installs together**. Separate delivery leaves a span of one frame in which the scene and an
overlay drawn over it disagree about what index `i` addresses.

## The two push kinds

Between windows, *why* the window was pushed sets the rule.

A **streaming advance** tops up the buffer as playback approaches its end. The user asked for
nothing, so nothing may visibly move at the seam, and the advance **must** preserve the previous
window's index space. It travels as `mode: append` and repeats the window identity it extends.

A **control re-push** replaces the buffer in answer to an event. The user asked for a visible
change, so the window **may** re-index freely. It travels as `mode: replace` and mints a new window
identity.

The buffer has exactly two operations: extend, and clear and refill. They map one to one onto the
two push kinds, which makes the identity rule structural. There is no third mode and no way to
express one.

The Core checks the label rather than trusting it. An `append` extends the buffer only if it
continues it at either end: its first frame is one past the last frame held, or its last frame is
one before the first. A clock running backwards consumes the buffer downwards and gets windows that
extend it that way. An `append` that leaves a gap or overlaps cannot be interpolated across, so it
clears the buffer and re-bases on itself, whatever its mode field says.

The buffer is bounded, and the bound travels with the clock: an extension past the bound drops
frames from the end playback is moving away from, so the frames held follow the clock whichever way
it runs. Only an extension is bounded, so a server that delivers a whole run in one window gives
none of it up. A dropped frame is asked for again if the clock returns to it.

## Why interpolation never crosses a window

Two frames from different windows may carry different index spaces, so blending between them blends
two different sets of objects, and the Core never offers such a pair. A module reads its arrays
through the **placement** of an absolute keyframe: which window carries it, and the offset within
that window. Two placements from one window are safe to blend; two from different windows are two
separate draws.

A module's store of window payloads is keyed on the **window object**, never on the start frame,
because a `replace` gives the same absolute indices to a different window and a number-keyed map
then addresses the wrong payload across the seam. Keying on the object also spares the store a
retention bound: a value becomes unreachable exactly when the Core stops naming its window.

## Keyframes and base rank

Inside a payload, a value may vary per keyframe or stand still for the whole window. The rule that
decides which is the **base rank**, and the Core owns it (ADR-0014).

A module knows the rank of the form it expects: 1 for one value per entity, 3 for an `[H, W, 4]`
raster. An array at or below that rank holds one value for the whole window, and every keyframe
reads all of it. An array one rank above it carries a leading keyframe axis, and keyframe `k` reads
the contiguous block at `k × block`. Any higher rank is an error.

The rule sits in the Core because it says nothing about what the values mean, and four modules that
decided it separately reached four conventions. The Core states it once, as `blockAt`, and checks
it: an array whose leading axis disagrees with the window it rode in on throws instead of reading a
short block.

Meaning stays with the module. The components an entity takes, the four RGBA bytes of a texel, and a
stride of zero that covers a whole family are entity semantics, and a Core that knew any of them
would have to model an entity. Two designs were declined for that reason. A full slicer in the Core
would absorb the raster contract and the notion of a family. A `payloadAt(index)` accessor answers
three of the four modules and makes the Core retain payloads nobody reads: `primitives` keeps
derived state rather than the raw payload, and reads two placements at once across a seam.

## Where the requests come from

No module asks for a window. The Core watches the clock against the coverage it holds, and asks when
playback nears the edge it is heading for, or when the clock is scrubbed past coverage. The request
names an absolute start index and a frame count: one frame where the window continues the buffer at
either end, and two where it lands somewhere new, because interpolation needs a neighbour to blend
toward.

The count travels with the request, so the server needs no memory of what it already sent. Its
answer is a pure function of the request and its own data, which lets a recorded session replay and
a late client catch up.

The Julia side is in the [windows reference](../reference/windows.md), and the wire fields are in
the [protocol](../reference/wire/protocol.md). To answer those requests in a program, read
[Deliver a long mission a piece at a time](../how-to/lazy-delivery.md).
