# Send large arrays without paying for them

A window carries positions, colours and masks for thousands of entities. Those arrays travel as raw
bytes behind the message, and the browser reads each one as a view. Keep your payload on that path.

## Send an element type that travels as bytes

Five dtypes travel: `f32`, `f64`, `u8`, `u32` and `i32`. An array of one of these element
types is written into the frame's region as it stands.

| You hold | It travels as | |
|---|---|---|
| `Float32`, `Float64` | `f32`, `f64` | |
| `UInt8`, `UInt32`, `Int32` | `u8`, `u32`, `i32` | |
| `Bool` (and `BitVector`) | `u8` | a module reads a flag as `data[i] !== 0` |
| `Int8`, `Int16`, `Int64` | `i32` | error unless every value fits `Int32` |
| `UInt16`, `UInt64` | `u32` | error unless every value fits `UInt32` |
| `Float16` | `f32` | always exact |
| any other `<: Number` | error | `Complex`, `Rational`, `Int128` and the like |
| anything not `<: Number` | a JSON list | strings, nested payload objects, `Array{Any}` |

The server converts before it sends. Every conversion is exact, and a value the target dtype cannot
hold is an error rather than a wrap-around. An `Int64` past `Int32` travels only as `Float64`, which
is exact to `2^53`.

**The last row is the one that costs.** An array of anything that is not a number goes element by
element into the JSON header. The browser parses that text rather than viewing it, and nothing
raises. A `Vector` of a coordinate struct hits this. See [Work in map coordinates](coordinates.md)
for the `reinterpret(reshape, ...)` fix.

## Hold positions as `Float32`

`Float32` spacing at the Earth's surface is about 0.5 m, under a pixel at any camera range where a
satellite or a ground cell is one, and it halves the bytes against `Float64`.

[`Nodes`](@ref) converts `position` to `Float32` for you. A module of your own gets whatever you
hold, so build the array as `Float32`:

```julia
position = Float32.(ecef(lons, lats, alts; ellipsoid = server))
```

Use `Float64` where precision is the point: a time series, a physical quantity a tooltip prints. Use
`UInt8` for colours, which is what [`rgba`](@ref) and [`rgba_grid`](@ref) give you.

## State the shape, and read it reversed

`shape` is mandatory on the wire, and it is **row-major**: the last dimension varies fastest, the
reverse of Julia's `size`. Neither side permutes anything, and the flat byte order is the same on
both.

```@repl arrays
using CesiumLink
region = IOBuffer();
CesiumLink.encode_arrays((; position = reshape(Float32.(1:12), 3, 2, 2)), region)
```

A Julia `3 × 2 × 2` reads `[2, 2, 3]` on the wire. A flat vector states `shape: [N]`.

## Put the keyframe axis last

A module knows the **base rank** of the form it expects: 1 for a value per entity, 2 for the
`3 × N` positions of a family, 3 for an `[H, W, 4]` raster.

- An array **at or below** the base rank holds one value for the whole window. Every keyframe
  reads all of it.
- An array **one rank above** it carries a keyframe axis. In Julia that axis is the
  **trailing** one, because the wire shape is the reverse and the wire wants the keyframe block
  leading and contiguous.

So `3 × N` stands still through the window, and `3 × N × count` is interpolated across it. A colour
is `4 × N`, or `4 × N × count`. A raster is `4 × W × H`, or `4 × W × H × count`.

The leading axis must equal the window's `count`. A payload that claims seven keyframes inside a
window of five throws in the browser.

**This is the largest saving available.** An array that does not change across the window costs one
keyframe instead of `count`. Send a fixed constellation's colours once.

## Trap: an array literal promotes and nothing raises

`promote_type(Vector{Float64}, Vector{UInt8})` is `Vector{Float64}`. A literal that holds arrays of
two element types silently converts one of them.

```@repl arrays
mixed = Dict(["color" => UInt8[1, 2, 3], "speed" => Float64[1.0]]);
eltype(mixed["color"])
```

The colours are now `Float64`: eight times the bytes, the wrong dtype, and no error. Build a mixed
payload with a container that keeps element types apart:

```julia
(; color = UInt8[1, 2, 3], speed = Float64[1.0])     # a NamedTuple, or
Pair{String,Any}["color" => UInt8[1, 2, 3], "speed" => Float64[1.0]]
```

## Use the cheap knobs to vary a scene

A mask is a `BitVector`, which travels as one byte per entity. Masking is how the drawn set varies
inside a window, and it costs one batch-table write.

Prefer one fixed `pairs` under a mask to one `pairs` per keyframe. On [`Edges`](@ref), a line is
built from `pairs`, `color` and `style`, so a family that varies any of them per keyframe is rebuilt
at every crossing. `width` and `show` are written in place.

## Check what you sent

Read the frame. `tools/decode-frame.jl` prints one array per line, with its dtype, shape and offset.
See [Look at what the wire carried](inspect-the-wire.md).

## Next

- [Arrays on the wire](../explanation/arrays.md) for why the wire is shaped this way.
- [Wire protocol](../reference/wire/protocol.md) for the normative statement.
