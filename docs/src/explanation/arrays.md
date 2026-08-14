# Arrays on the wire

A scene is mostly numbers. Positions, colours, link endpoints and raster grids are all arrays, and
they dominate every message the server sends. How they travel is the wire's main design question,
and the answer changed once (ADR-0016).

## What base64 cost

Arrays used to travel as base64 strings inside the JSON message. Measured against a recorded
end-to-end session, base64 was **95% of the whole session**: 224,496 bytes of a 236,274-byte
recording, carrying 168,372 bytes of actual arrays. Encoding and decoding together cost about
**0.9 ms and 33% of the wire per 168 KB**, which is roughly 190 MB/s. It scales linearly, so 20 MB
of arrays costs 107 ms and 6.8 MB of extra wire.

Three things made that worth removing.

- **The target is a remote host**, and this WebSocket has no compression. Asset serving is gzipped;
  the socket is not.
- **The `heatmap` module drapes baked RGBA.** A 1024×512 raster is 2 MB per keyframe per layer.
- **A notebook host encodes an ordinary push twice.** A JSON frame that already holds base64 arrays
  goes through serialisation, base64 and JSON again — about 1.78× expansion over five passes.

On the same scene, the change took the wire from 239,275 to 183,520 bytes, 23% less, with 31 draw
commands per frame unchanged.

## The frame

One WebSocket binary frame carries one message:

```
[u32 headerLen]   little-endian, at byte 0
[header]          headerLen bytes of UTF-8 JSON: the whole message
[pad]             zero bytes, up to the next multiple of 8
[region]          the array bytes the header points into
```

The header is the message, and the **region** is the array bytes behind it. A message with no arrays
has an empty region, and the framing is identical either way, so there is one code path rather than
two. An encoded array in the header is a self-describing triple:

```json
{ "$wire": "f32", "shape": [3, 264], "off": 4096 }
```

**The offset counts from the start of the region, never from the start of the frame.** Some hosts
hand the region over on their own; a notebook host carries the whole packed frame as one array. A
frame-relative offset would need a fixup on that transport and not on the other, where
region-relative offsets let both receive one buffer and split it at the `u32`.

**The offset is always a multiple of 8, whatever the dtype.** One rule instead of a table per dtype.
The waste is at most 7 bytes per array — 147 bytes across a recorded 21-array window — and 8 is what
a `Float64Array` view needs anyway.

## Why `shape` is mandatory and the length is not carried

The length is derived: `prod(shape) × bytesPerElement`. A length field beside the shape is redundant
with `shape` and the dtype tag, and a redundant field is one more thing to keep in step. What stands
in its place is a bounds check, `off + length ≤ region.byteLength`, refusing the frame when it does
not hold: that one line stands between a malformed frame and a view over bytes that never arrived.

A separate `buffers` table with index references was declined for the same reason at one remove. It
adds indirection to describe what one offset already says.

## Every array is a view

The browser reads each array as a **view** into the region. `data.buffer` is the whole received
frame, and `data.byteOffset` is where that array sits in it. The bytes are never copied.

Copying costs about 1 ms per megabyte, 20 ms on a 20 MB window, and that is most of what this design
saves. It costs a lifetime coupling: a module that keeps a slice past its window keeps the whole
frame alive with it. The coupling is bounded, because a module's per-window store is keyed on the
window object and `primitives` holds two windows across a seam. A module that wants a detached copy
makes one explicitly.

## The row-major label reversal

`shape` is row-major, with the last dimension varying fastest. Julia is column-major, and it
**reverses the label** at its own boundary. The label changes and no bytes move. Readers often mistake
the reversal for a transpose.

Consider a Julia array of size `(3, N)`, three components for each of `N` entities. Its flat byte
order is component-major: the three components of entity 1, then the three of entity 2, and so on.
The wire states `shape: [N, 3]`, and a browser reading that shape row-major walks the same bytes in
the same order — `N` rows of 3. Both sides land on their own idiom, and a `Vector{ECEF}` travels
correctly as a reinterpretation with no codec change at all.

The dtype table is small on purpose. Five types travel — `f32`, `f64`, `u8`, `u32`, `i32` — and any
other numeric element type is converted to the one that carries it without loss, or refused. A value
the target dtype cannot hold is an error rather than a wrap-around, so the bytes on the wire always
mean what the sender held. There is no 64-bit integer dtype: an `Int64` past `Int32` travels only
as `Float64`, exact up to 2^53. Anything that is not a number becomes an ordinary JSON list, which
is what makes a list of label strings work.

## Why there are no requests

The header is JSON-RPC-2.0-shaped without the `jsonrpc` field, and a message with an `id` would be a
request expecting a result. **The protocol uses none.** Everything is a notification in one
direction or the other.

No answer here fits the request shape. Every answer is either a command batch or a window, and both
may arrive later than the thing that prompted them, more than once, or not at all. A pointer event
may be answered by nothing, because no listener had anything to say; a control may be answered by a
window and then by a re-declaration of the overlay.

Correlation lives in the payload rather than in the transport. An event carries a sequence number,
and the command batch that answers it echoes that number, so a module that cares about staleness has
what it needs and the transport stays a one-directional pipe.

## Only the downward half exists

The framing is symmetric, and **only the downward array encoder is built**. Nothing puts an array in
an upward payload today: pointer events, buffer requests, control input and the ellipsoid
confirmation are all scalars. A browser sends an empty region and refuses a typed array in an event
payload, naming the conversion that would fix it. The server is authoritative, so bulk data flowing
upward inverts the model, and building the upward half later writes an encoder against a contract
that already describes it.

## What was declined, and why

- **Two live encodings, negotiated or switched.** The codec is the whole payload contract, so a
  disagreement between two encodings is silent and total. A frame-decoding tool and readable
  recording headers buy the debuggability back instead.
- **A transport that substitutes bytes into payload internals**, so that the Core sees no change.
  That logic would be written once per transport instead of once in the codec. A transport splits
  the frame and passes both parts up; it never reads a payload.
- **MsgPack.** An earlier version of the protocol named it as the eventual binary transport. The
  contract did survive the move, but MsgPack is a dependency on each side plus hand-written
  extension handlers, to buy what a framed blob region gives for nothing.
- **A magic number or a per-frame version byte.** Redundant with a handshake that has to exist, and
  a viewer that does not know the format will not look for the magic number either. The handshake is
  the only place the disagreement can be named, which is why a version mismatch closes the socket
  with a reason.

## One consequence worth knowing

**Julia only builds frames and the browser only reads them.** Neither side can round-trip against
itself, so nothing in either test suite would catch the two drifting apart. A golden frame on disk
is the pin: a Julia script writes it, the Julia suite asserts the bytes, and a browser-side test
decodes it. Its payload is chosen so that the offsets need a pad of 5, then 7, then 4, because a
frame of same-dtype arrays lands 8-aligned throughout and exercises no padding at all.

The normative statement of the frame and the dtype table is in the
[wire protocol](../reference/wire/protocol.md); the Julia side of the codec is in the
[codec reference](../reference/codec.md), and
[Send large arrays](../how-to/large-arrays.md) is the practical guide.
