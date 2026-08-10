---
status: accepted
---

# Entity identity holds within a window, and the buffer is sparser than the range

Keyframes arrive as **windows**: contiguous runs pushed together. Index `i` addresses the same
object in every frame of one window. That is the whole guarantee, and it is sufficient, because
interpolation only ever brackets two frames of the same window.

Between windows the rule is set by *why* the window was pushed. A **streaming advance** tops up the
buffer during playback and preserves the previous window's index space — the user asked for nothing,
so nothing may visibly move at the seam. A **control re-push** replaces the buffer in response to
input and may re-index freely, because it is delivering a change the user requested. The buffer has
exactly two operations, append and clear-and-refill, and they correspond one to one with these two
cases, so the rule is enforced by the data structure rather than by remembering it.

A window is a **Core-level** concept rather than one module's message. One `window` message carries
the declared range, the window's placement, its identity and its join mode, plus a payload per
module, dispatched together. The Core owns the buffer, the coverage bookkeeping and the eviction; a
module owns only its own arrays and the interpolation over them. A static scene is a window of one
frame, so there is one clock and one declared range, declared by the window.

Identity is what makes that atomic dispatch necessary: index `i` means the same object across a
window, so every module's payload for a window installs together, or two modules disagree about what
index `i` addresses for the span of one frame.

Area geometry is the one thing built once rather than per window. It is tessellated and then
recoloured in place, and an entity that stops being drawn is masked by `show` rather than dropped —
which keeps the index space stable and, unlike an alpha of zero, also removes the entity from
picking.

The mission timeline is **finite and known**: the server declares epoch, keyframe step and total
count up front, and delivers frames lazily. The clock, the ruler and scrubbing operate on this
declared range; interpolation operates on the delivered buffer. Scrubbing to an instant the buffer
does not cover is a window request, not an error.

## Considered options

- **Per-window index space, finite declared range** (chosen).
- **Index space fixed for the whole scene.** Arrays keep full length forever and filtering is a
  visibility mask. Rejected: the payload can then never shrink, and a mask cannot express a filter
  that changes derived values.
- **Per-frame index space.** Rejected: interpolation blends position `i` of one frame into position
  `i` of the next, so an index that means different objects in consecutive frames teleports every
  entity on every step.
- **Open-ended stream, no declared end.** Rejected: the ruler and scrubbing lose meaning and looping
  becomes impossible, in exchange for flexibility the domain does not need — the runs being viewed
  are finite and of known length.

## Consequences

The playback range is declared rather than derived from the frame count a payload happens to carry,
and the frame lookup is buffer-backed. The Cesium clock, the `Timeline` ruler and scrubbing all work
unchanged, which is the reason this shape was chosen over an unbounded stream.

Identity is positional, `(kind, idx)`. What this record fixes is the *interval over which that
position is meaningful*: a window, not a session. Anything answered against one window and applied
against its successor addresses the wrong entity, so anything that can outlive a control re-push
carries the window it was computed against.

The identity guard is needed in one case: an addition made **mid-window**. Content for keyframes the
viewer already holds cannot ride the window that delivered them, so it arrives as a command batch
carrying the window identity it was computed against. Everything delivered by a window is guarded
structurally instead, because a window's payloads install together.

The protocol version is **1**. Revision numbers for a format no consumer has seen carry no
information a reader can act on, so the number starts where the published history starts.
