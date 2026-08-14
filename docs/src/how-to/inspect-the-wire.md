# Look at what the wire actually carried

The scene is wrong and the payload looks right. Read the frame. Every frame is binary, so
`less` and `jq` do not answer on their own.

## What a frame is

One WebSocket message carries one frame:

```
[u32 headerLen]   little-endian, at byte 0
[header]          headerLen bytes of UTF-8 JSON: the whole message
[pad]             zero bytes, up to the next multiple of 8
[region]          the array bytes the header points into
```

The header holds the message. Every numeric array in it becomes

```json
{ "$wire": "f32", "shape": [2, 3], "off": 0 }
```

and its bytes sit in the region. `off` counts from the start of the **region**, never from
the start of the frame, and is always a multiple of 8. The frame carries no length: it is
`prod(shape) × bytesPerElement`. A message with no arrays has an empty region.

## Decode a frame you have on disk

`tools/decode-frame.jl` prints the header as formatted JSON, then one line per array with
its dtype, shape, offset and a sample of its values.

```sh
julia --project=. tools/decode-frame.jl session.jsonl 2
julia --project=. tools/decode-frame.jl tools/baseline/golden-frame.bin
```

A `.jsonl` file is read as a recording: the first line is its header, and the trailing
argument names the frame, 1-based. Anything else is read as one packed frame.

The output ends with the part `jq` cannot give you:

```
region: 24 bytes, 1 array(s)
  params.payloads.demo.position  f32  shape [2, 3]  off 0  →  1.0, 3.0, 5.0, 2.0, 4.0, 6.0
```

The script decodes each array rather than reading it off the header, so a wrong offset or a
short region fails here instead of in the browser.

To capture frames, record the session. See
[Record and replay a session](record-replay.md).

## Check a payload from the REPL

`encode_arrays` returns the header value and writes the bytes into the region you give it. No
server is needed.

```@repl wire
using CesiumLink
region = IOBuffer();
CesiumLink.encode_arrays((; position = Float32[1 2; 3 4; 5 6], label = "north"), region)
position(region)                                      # bytes written into the region
```

Three things to read off that:

- `$wire` says whether the element type you hold travels as bytes. No `$wire` key means the
  value went into the header as JSON.
- `shape` is row-major, the reverse of Julia's `size`. A `3 × 2` reads `[2, 3]`.
- `off` is where the bytes start in the region, and is a multiple of 8.

To see a whole frame, build one and take it apart again:

```@repl wire
frame = CesiumLink.commands_message([Command("demo", "fixture", (; speed = Float32[1, 2, 3]))]);
bytes = CesiumLink.pack(frame);
length(bytes)
back = CesiumLink.unpack(bytes);
back.header
params = CesiumLink.JSON.parse(back.header)["params"];
CesiumLink.decode_arrays(params["commands"][1]["payload"], back.blobs)
```

`unpack` splits a frame captured off the socket into its header and its region.
`decode_arrays` replaces every encoded array, at any depth, with the array it carries.

## Read indices with the base in mind

**The wire is 0-based and the Julia API is 1-based.** A window you pushed with
`start_frame = 1` reads `"startFrame": 0`. An entity index in a pointer event reads one lower
than the number your listener was handed. Convert with [`CesiumLink.to_wire_index`](@ref) and
[`CesiumLink.from_wire_index`](@ref) rather than by hand.

## Watch the total

`npm run harness:check` reports **bytes on the wire per payload**, counted at the socket
before the viewer parses anything. It is exact, and it tells you when arrays went back into
the header.

## Next

- [Wire protocol](../reference/wire/protocol.md) for the normative contract.
- [Send large arrays](large-arrays.md) for what to do about what you find.
