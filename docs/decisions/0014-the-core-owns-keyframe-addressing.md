---
status: accepted
---

# The Core owns keyframe addressing, and nothing about entities

A payload is opaque to the Core. Two things about it are not: which bytes keyframe `k` reads, and
which window a value belongs to. Both were decided in every module separately — the first in four
implementations with four conventions, the second in a class and three copies of the same three
lines. Neither is a domain question, and neither can be answered twice without the answers drifting.

## Decision

**The Core states the rank rule and implements it once.** An encoded array at or below its form's
base rank holds one value for the whole window. One rank above it carries a leading keyframe axis,
and keyframe `k` is the contiguous block at `k × block`. `blockAt(a, k, baseRank, count)` in
`codec.ts` is that rule, and `docs/src/reference/wire/module-api.md` § Payloads is its normative
statement. The function sits beside `decodeArrays`, which already owns what an encoded array is.

**`blockAt` takes the window's keyframe count as an argument, so it stays pure.** A payload whose
leading axis disagrees with the window it rode in on is caught there. Purity is what lets
`ctx.blockAt` be a one-line re-export, so a module that builds from this tree may import the function
directly and a module that cannot reaches the same function through its context.

**`ctx` is the documented route, for `isNdArray` as well as `blockAt`.** A module must recognise an
encoded array before it can slice one, so half the pair on the context serves nobody. A module served
from another package's assets folder has no source to import; the context is what it has, and the
`apiVersion` gate already covers it.

**Entity semantics stay in `primitives`.** `Slice`, `at(s, i, j)` and the four forms `knob()` accepts
do not move. A `stride` of 0 means one value covers a whole family, and a family is an entity
concept. The Core models no entities, and a rule that made it model one to slice an array would trade
the whole payload-opacity property for six lines.

**The per-window store is a Core-provided mechanism, not a payload accessor.** `ctx.perWindow<T>()`
hands back a store keyed on the `WindowInfo` object. A module puts in whatever it needs to address by
window: a cast payload, or state it built from one. Because the module decides what goes in, the Core
retains nothing it was not handed, and per-window payload retention never becomes its concern.

## Alternatives declined

**A full slicer in the Core, with `knob()` reduced to form validation.** It was the larger deletion,
and it fails for the reason above: the Core would learn what an entity family is. It would also
absorb the raster contract, since `gridAt` validates that the last axis is four RGBA bytes.

**`ctx.payloadAt(index)`, returning the module's payload for the window covering that keyframe.** It
answers three of the four modules. `primitives` keeps derived state rather than the raw payload, and
reads `latest` and two placements at once for interpolation across a window seam, so it would keep
its own store and the Core would retain payloads nobody reads. The store answers both cases and
retains less.

**A `payload` field on `Placement`.** The same objection, plus it puts a value on every placement
lookup for the benefit of the callers that want one. `primitives` calls `placement` most and wants it
least.

**Serving the codec at a stable URL, so any module imports it.**
`docs/src/reference/wire/module-api.md` already records that a URL import bypasses the `apiVersion`
gate, because the browser resolves it and the Core never sees it. A module built against a later
`blockAt` and loaded by an earlier Core would fail at runtime instead of being refused at the gate.
That route stays narrow.

**Nesting the context keys into namespaces while a breaking change is still free.** The context is
wide but its weight is unreachable keys, not the count: `zoomTimeline` and the transport's `request`
cost a reader attention and cost implementation nothing. Nesting reorganises that documentation
without shrinking it, and a partly nested bag reads more arbitrary than a flat one. Revisit after the
unreachable surface goes.

## Consequences

The context carries 22 keys. `apiVersion` does not move for this: a bump is batched with the next
breaking change rather than spent here.

Two checks are strict where a looser reading would pass. A rank-4 raster whose leading axis disagrees
with its window throws rather than reading a short block, and a `ui` track's shape is checked rather
than ignored. Neither failure is silent.

No slicer is deleted. `knob()`, `gridAt()`, `atKeyframe()` and `valueAt()` each keep their domain and
lose their arithmetic, so each file still explains what it does with the rule — the base rank it uses
and why — while the rule itself is stated in one place.

The keyframe slicer lives in the Core rather than in the `primitives` module: promoted, not
absorbed. Its interface is unchanged by the move, which is the evidence that it was the right
abstraction in the wrong package.

A module author has one way to hold state per window and one way to address a keyframe inside it.
A future review that proposes moving `Slice` up, or replacing the store with a payload accessor,
should read this first.

## The context carries no unreachable surface

`zoomTimeline` does not sit on the context, and `Transport` declares no `request`. Nesting the
context's keys into namespaces is not proposed: the weight a reader would have had to skip is simply
absent.

The Core zooms its own timeline. What it does not do is forward that to a module.
