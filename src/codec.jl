# The encoded-array codec — the whole of either side's payload knowledge.
#
# A numeric array anywhere in a payload, at any nesting depth, travels as
#   {"$wire": "f32", "shape": [3, 264], "off": 4096}
# so a decoder never needs the payload's schema, and nothing else about a payload's structure is
# interpreted anywhere. The bytes themselves sit in the frame's region — see `Frame` below.
#
# `shape` is row-major, the last dimension varying fastest, which is the reverse of Julia's
# column-major `size`. Stated that way the flat byte order is the same on both sides, so a browser
# typed array and the Julia array it came from agree on element order without a permutation. A flat
# array states `shape: [N]`.
#
# The dtype, the shape and the bytes stay three separate fields, so a reader takes the bytes as they
# are and never copies them to interpret them.
#
# Five dtypes travel. An element type with no tag of its own is converted to the tag that carries it
# without loss, and refused when no such tag exists — never narrowed, never wrapped around:
#
# | Julia eltype              | travels as | |
# |---------------------------|------------|---------------------------------------------------|
# | `Float32` `Float64`       | f32 f64    | |
# | `UInt8` `UInt32` `Int32`  | u8 u32 i32 | |
# | `Bool`                    | u8         | JS has no boolean typed array                     |
# | `Int8` `Int16` `Int64`    | i32        | every value must fit `Int32`, or it is an error   |
# | `UInt16` `UInt64`         | u32        | every value must fit `UInt32`, or it is an error  |
# | `Float16`                 | f32        | always exact                                      |
# | any other `<: Number`     | error      | `Complex`, `Rational`, `Int128` and the like      |
# | anything not `<: Number`  | JSON list  | strings, nested payload objects, `Array{Any}`     |

# One message and the array bytes behind it, before either is laid out for a transport.
#
# The builders in `messages.jl` return this rather than packed bytes, so a recording can store a
# readable header and `send_message` can still take hand-written JSON. `pack` is called only where a
# frame reaches a transport.

"""
    Frame(header, blobs = UInt8[])

One wire message: `header` is the JSON-RPC text, `blobs` is the region its encoded arrays point
into. A message with no arrays has an empty region.
"""
struct Frame
    header::String
    blobs::Vector{UInt8}
end
Frame(header::AbstractString) = Frame(String(header), UInt8[])

"""
    pack(f::Frame) -> Vector{UInt8}

The bytes one WebSocket binary message carries:

    [u32 headerLen][header][pad to 8][region]

All integers are little-endian, which every target platform is. The pad puts the region on a
multiple of 8, so a reader can take a `Float64Array` view over any array in it.
"""
function pack(f::Frame)
    h = codeunits(f.header)
    io = IOBuffer(; sizehint = 4 + length(h) + 8 + length(f.blobs))
    write(io, UInt32(length(h)))
    write(io, h)
    write(io, zeros(UInt8, region_pad(4 + length(h))))
    write(io, f.blobs)
    return take!(io)
end

"""
    unpack(bytes) -> Frame

The frame [`pack`](@ref) laid out, split back into its header and its region. Reads a frame captured
off the socket, and is what `replay` and the test clients use.
"""
function unpack(bytes::AbstractVector{UInt8})
    length(bytes) ≥ 4 || error("wire: a frame is at least 4 bytes; got $(length(bytes))")
    n = Int(only(reinterpret(UInt32, bytes[1:4])))
    4 + n ≤ length(bytes) ||
        error("wire: a header of $n bytes runs past a frame of $(length(bytes))")
    # A truncated frame leaves an empty region rather than an out-of-range index; the bounds check
    # in `decode_array` is what refuses the arrays that then point past it.
    start = min(4 + n + region_pad(4 + n), length(bytes))
    return Frame(String(bytes[5:(4 + n)]), bytes[(start + 1):end])
end

# Zero bytes to write after `n` bytes to reach the next multiple of 8.
region_pad(n::Integer) = (-n) & 7

const WIRE_TAG = Dict{DataType,String}(
    Float32 => "f32", Float64 => "f64", UInt8 => "u8", UInt32 => "u32", Int32 => "i32",
)
const WIRE_TYPE = Dict(tag => T for (T, tag) in WIRE_TAG)

# Element types carried by a tag other than their own, through a lossless conversion.
const WIRE_CONVERT = Dict{DataType,DataType}(
    Bool => UInt8,
    Int8 => Int32, Int16 => Int32, Int64 => Int32,
    UInt16 => UInt32, UInt64 => UInt32,
    Float16 => Float32,
)

"""
    encode_arrays(payload, region::IO)

Return `payload` with every numeric array inside it, at any depth, replaced by its encoded form, and
write the bytes of each into `region`. Dicts, named tuples, tuples and non-numeric arrays are walked;
everything else passes through. The caller takes the region and the returned value as one frame.

Every array is padded to an offset that is a multiple of 8, whatever its dtype: one rule instead of
a table, and a reader can then take a `Float64Array` view over any of them. The wasted bytes are at
most 7 per array.

**Build a mixed payload with a container that holds its element types apart.** A Julia array literal
promotes, and `promote_type(Vector{Float64}, Vector{UInt8})` is `Vector{Float64}` — so
`["a" => f64s, "b" => u8s]` silently converts the `UInt8` array to `Float64`. That is eight times
the bytes and the wrong dtype on the wire, with no error anywhere. Write `(; a = f64s, b = u8s)`, or
annotate the literal as `Pair{String,Any}[...]`.

A vector of structs whose fields share one type travels as `reinterpret(reshape, S, v)` with no
codec change — a bare `Vector{ECEF}` is not `<: Number` and would otherwise become JSON objects.

An array whose element type is not one of the five wire dtypes is converted to the dtype that
carries it without loss, and an array no dtype can carry is an error rather than a silent JSON list:

| Julia eltype | travels as | |
|---|---|---|
| `Float32`, `Float64` | `f32`, `f64` | |
| `UInt8`, `UInt32`, `Int32` | `u8`, `u32`, `i32` | |
| `Bool` | `u8` | JS has no boolean typed array; read a flag as `data[i] !== 0` |
| `Int8`, `Int16`, `Int64` | `i32` | error unless every value fits `Int32` |
| `UInt16`, `UInt64` | `u32` | error unless every value fits `UInt32` |
| `Float16` | `f32` | always exact |
| any other `<: Number` | error | `Complex`, `Rational`, `Int128` and the like |
| anything not `<: Number` | JSON list | strings, nested payload objects, `Array{Any}` |

An integer too large for its dtype is refused, never wrapped: convert it to `Float64`, which is
exact to `2^53`, or split the value.
"""
encode_arrays(x, region::IO) = x
encode_arrays(d::AbstractDict, region::IO) =
    Dict{String,Any}(string(k) => encode_arrays(v, region) for (k, v) in d)
encode_arrays(t::NamedTuple, region::IO) =
    Dict{String,Any}(string(k) => encode_arrays(v, region) for (k, v) in pairs(t))
encode_arrays(t::Tuple, region::IO) = Any[encode_arrays(v, region) for v in t]

function encode_arrays(a::AbstractArray, region::IO)
    tag = get(WIRE_TAG, eltype(a), nothing)
    if tag === nothing
        # An array of anything but numbers is a payload structure, not data: walk it element by
        # element, which is what carries strings and nested payload objects.
        eltype(a) <: Number || return Any[encode_arrays(v, region) for v in a]
        return encode_arrays(to_wire_eltype(a), region)
    end
    # Julia is little-endian on the target platforms, so a dense array's bytes are the wire bytes.
    flat = a isa Array ? vec(a) : vec(collect(a))
    write(region, zeros(UInt8, region_pad(position(region))))
    off = position(region)
    write(region, reinterpret(UInt8, flat))
    return Dict{String,Any}("\$wire" => tag, "shape" => reverse(collect(size(a))), "off" => off)
end

# The array `a` with the element type that carries it on the wire, so a conversion can only ever be
# exact. The range is checked ahead of the conversion for the message: the `InexactError` the
# conversion itself would raise names neither the dtype involved nor a way out.
function to_wire_eltype(a::AbstractArray)
    T = eltype(a)
    S = get(WIRE_CONVERT, T, nothing)
    S === nothing && error(
        "wire: no dtype carries $T arrays. Arrays travel as f32 f64 u8 u32 i32, and Bool, Int8, " *
        "Int16, Int64, UInt16, UInt64 and Float16 convert into one of those.")
    if S <: Integer && !isempty(a)
        lo, hi = extrema(a)
        typemin(S) <= lo && hi <= typemax(S) || error(
            "wire: $lo … $hi does not fit $S, which is what $T arrays travel as. Convert to " *
            "Float64, which is exact for |v| ≤ 2^53, or split the value.")
    end
    return Array{S}(a)
end

"""
    decode_arrays(payload, region = UInt8[])

Return `payload` with every encoded array inside it, at any depth, replaced by the array it carries,
reading the bytes out of `region`. Everything else — including a value that merely carries a `\$wire`
key — passes through.

An array is recognised by its `off`, which is where in `region` its bytes start.
"""
decode_arrays(x, region = UInt8[]) = x
decode_arrays(v::AbstractVector, region = UInt8[]) = Any[decode_arrays(x, region) for x in v]

function decode_arrays(d::AbstractDict, region = UInt8[])
    is_wire_array(d) && return decode_array(d, region)
    return Dict{String,Any}(string(k) => decode_arrays(v, region) for (k, v) in d)
end

# Anything but a known dtype tag alongside an offset into the region is an ordinary payload value
# that happens to have a `$wire` key.
function is_wire_array(d::AbstractDict)
    tag = get(d, "\$wire", nothing)
    tag isa AbstractString && haskey(WIRE_TYPE, tag) || return false
    return get(d, "off", nothing) isa Integer
end

function decode_array(d::AbstractDict, region = UInt8[])
    tag = d["\$wire"]
    T = WIRE_TYPE[tag]
    shape = get(d, "shape", nothing)
    # The length is derived rather than carried, so this bounds check is the whole of what stands
    # between a malformed frame and a read past the region.
    shape === nothing && error("wire: an array in a region must state its shape")
    dims = reverse(Int.(shape))
    off, n = Int(d["off"]), prod(dims) * sizeof(T)
    0 ≤ off && off + n ≤ length(region) || error(
        "wire: a $tag array of $n bytes at offset $off runs past a region of " *
        "$(length(region)) bytes")
    return reshape(collect(reinterpret(T, region[(off + 1):(off + n)])), dims...)
end

# The other thing that flips at the wire boundary, beside the row-major shape above: an index.

"""
    to_wire_index(i) -> Integer

A 1-based Julia index as the 0-based index the wire carries. Its inverse is
[`from_wire_index`](@ref). Broadcast it over an array of indices.
"""
to_wire_index(i::Integer) = i - one(i)

"""
    from_wire_index(i) -> Integer

A 0-based wire index as the 1-based index Julia carries. Its inverse is [`to_wire_index`](@ref).
"""
from_wire_index(i::Integer) = i + one(i)
