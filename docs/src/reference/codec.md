```@meta
CurrentModule = CesiumLink
```

# Wire codec

**These names are internal.** CesiumLink exports none of them, and they may change without notice.
The normative statement of the frame layout and the encoded-array form is the
[wire protocol](wire/protocol.md) page. This page describes the Julia side of it.

A numeric array anywhere in a payload, at any depth, travels as a self-describing triple of marker,
shape and offset. The bytes sit in the frame's region behind the header. A decoder therefore needs
no schema for the payload, and nothing else in a payload is interpreted.

`shape` is row-major, the last dimension varying fastest, which is the reverse of Julia's
column-major `size`. The flat byte order is then the same on both sides, so a browser typed array
and the Julia array it came from agree on element order without a permutation.

## The frame

```@docs
CesiumLink.Frame
CesiumLink.pack
CesiumLink.unpack
```

## Arrays

```@docs
CesiumLink.encode_arrays
CesiumLink.decode_arrays
```

## Indices

The wire is 0-based and the Julia API is 1-based. Every site that crosses the boundary calls one of
these two.

```@docs
CesiumLink.to_wire_index
CesiumLink.from_wire_index
```
