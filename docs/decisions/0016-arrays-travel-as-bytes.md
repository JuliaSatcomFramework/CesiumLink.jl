---
status: accepted
---

# Arrays travel as bytes behind the message

Every array on the wire was base64 inside the JSON message. Measured against a recorded session of
a satellite scene, base64 was **95% of the file** — 224,496 of 236,274 bytes, carrying 168,372 bytes
of arrays — and cost about **0.9 ms and 33% of the wire per 168 KB**, on both sides together. That is roughly 190 MB/s, and it scales: 20 MB of arrays costs
107 ms and 6.8 MB of extra wire.

Three things made it worth removing. The target is a **remote host**, and this WebSocket has no
compression — `gzipped()` in `static.jl` serves HTTP assets only. The `heatmap` module drapes baked
RGBA, and a 1024x512 raster is 2 MB per keyframe per layer. And **a notebook host** encodes an
ordinary push as a serialisation, then base64, then JSON — so a JSON frame that already holds base64
arrays is encoded twice, about 1.78x expansion over five passes.

## Decision

**One WebSocket binary frame carries one message.**

```
[u32 headerLen][header][pad to 8][region]
```

An encoded array names `{"$wire", "shape", "off"}` and its bytes sit in the region. `off` counts
from the start of the **region**, is always a multiple of 8, and the length is derived as
`prod(shape) × bytesPerElement`. `docs/src/reference/wire/protocol.md` is the normative statement.

The browser reads each array as a **view** into the region. Julia's message builders return a
`Frame` — a header and its blobs — and `pack` is called only where a frame reaches a transport.

`PROTOCOL_VERSION` goes to 2, and the server now **closes the socket with a reason** on a mismatch
rather than warning and proceeding.

## Alternatives declined

**Two live encodings, negotiated or switched.** The bug is where they disagree, and the codec is
the whole payload contract — so a disagreement is silent and total. Debuggability is bought back
with `tools/decode-frame.jl` and with readable recording headers, not with a second wire format.

**A transport that substitutes bytes into payload internals, so the Core sees no change.** That
logic would be written once per transport instead of once in the codec, which is exactly the drift
this avoids. The transport splits the frame and passes both parts up; it never reads a payload.

**A dumb frame pipe, with message parsing moved into the Core.** It makes `Transport` smaller and
every host's job larger, and the JSON-RPC *shape* is not what this change spends — only the
encoding is.

**`len` carried beside `shape`, or a `buffers` table with `buf` indices.** `len` is redundant with
`shape` and `$wire`. The consistency check it enabled is traded for the bounds check that actually
protects a reader. A `buffers` table adds a level of indirection and a second thing to keep in
step, to describe what one offset already says.

**Copies instead of views.** Copying costs about 1 ms per megabyte — 20 ms on a 20 MB window —
which is most of what this change exists to save. The lifetime coupling is bounded:
`ctx.perWindow<T>()` is keyed on the `WindowInfo` object and `primitives` holds two windows across
a seam, so about twice a window is the ceiling. `docs/src/reference/wire/module-api.md` states it.

**Padding each array to its own element size.** A dtype table, for at most 7 bytes per array — 147
bytes across the recorded 21-array window. Eight is what a `Float64Array` view needs anyway.

**Packed bytes from the Julia builders instead of a `Frame`.** Packing early makes recordings
opaque and breaks `send_message(::AbstractString)`. A plain tuple was declined too: it crosses six
signatures and becomes a struct field type.

**A magic number or per-frame version byte.** Redundant with a handshake that has to exist, and it
cannot catch the failure it appears to catch — a viewer that does not know the format will not look
for the magic number either.

**MsgPack.** `docs/src/reference/wire/protocol.md` named it as the eventual binary transport. The
prediction that this contract would survive the move was right; the mechanism was not. MsgPack is a
dependency on each side plus hand-written extension handlers, to buy what a framed blob region gives
for nothing.

**Putting the header in a host's own metadata slot rather than carrying the packed frame.** A
notebook host caps its frame metadata at 64 KB (`[u16 metaLen]`), and `Nodes.label` is one string
per entity — so a labelled family of a few thousand entities is about 70 KB of header. That ceiling
has a realistic trigger and fires only in the least-tested host. Carrying the whole packed frame as
the array removes it and makes such a transport nearly identical to the WebSocket: both receive one
buffer and split it at the `u32`.

**Building the upward binary half now.** Zero arrays travel upward — pointer events, `core/need`,
control input and `core/ellipsoid` are all scalars — and ADR-0007 makes the server authoritative,
so bulk data flowing upward inverts the model rather than using it. The framing is symmetric and
the encoder is not built; a browser sends an empty region and refuses a typed array in an event
payload.

## What this does not move

ADR-0014 is unaffected. `blockAt` keys off `shape.length`, and the rule for which block a keyframe
addresses does not change — only where the bytes behind the array came from.

The row-major convention is unchanged: `shape` still has the last dimension varying fastest, and
Julia still reverses it at its own boundary.

## Consequences

Julia keeps `decode_arrays`, `is_wire_array` and `decode_array`: an event arriving from the viewer is
split into a header and a region the same way, and those are what read it.

Julia only builds frames and the browser only reads them, so neither side can round-trip against
itself and nothing in either suite would catch the two drifting apart.
`tools/baseline/golden-frame.bin` is the pin: `tools/golden-frame.jl` writes it, the Julia suite
asserts the bytes, and `lib/core/src/golden-frame.test.ts` decodes it. Its payload needs a pad
of 5, then 7, then 4 — a frame of same-dtype arrays exercises no padding at all, because every
offset lands 8-aligned by luck and the test still looks green.

Measured on the harness scene: **the draw-command count per frame is unchanged**, and the wire falls
from 239,275 to 183,520 bytes — 23% less.
