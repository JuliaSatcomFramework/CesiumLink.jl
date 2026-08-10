@testitem "codec: an encoded array describes itself" setup=[Wire] begin
    w, region = lowered(Float32[1.0, 2.5, -3.25])
    @test w["\$wire"] == "f32"
    @test w["shape"] == [3]              # a flat array states its shape too
    @test w["off"] == 0
    @test reinterpret(Float32, region) == Float32[1.0, 2.5, -3.25]

    m, region = lowered(Float32[1 3 5; 2 4 6])
    @test m["shape"] == [3, 2]           # row-major: the reverse of Julia's (2, 3)
    @test reinterpret(Float32, region) == Float32[1, 2, 3, 4, 5, 6]
end

@testitem "codec: arrays are found at any nesting depth" setup=[Wire] begin
    using CesiumLink: decode_arrays

    payload = Dict("frames" => [Dict("pos" => Float32[1, 2, 3], "label" => "sat 1")], "n" => 3)
    w, region = lowered(payload)
    @test w["frames"][1]["pos"]["\$wire"] == "f32"
    @test w["frames"][1]["label"] == "sat 1"
    @test w["n"] == 3

    back = decode_arrays(w, region)
    @test back["frames"][1]["pos"] == Float32[1, 2, 3]
    @test back["frames"][1]["label"] == "sat 1"
    @test back["n"] == 3
end

@testitem "codec: f32, f64, u8, u32 and i32 round-trip through a frame" setup=[Wire] begin
    using CesiumLink: decode_arrays

    roundtrip(a) = (w = lowered(a); decode_arrays(w[1], w[2]))

    for a in (Float32[1, -2.5, 3f30], Float64[1, -2.5, 1e300], UInt8[0, 1, 255],
              UInt32[0, 1, 4_000_000_000], Int32[-2_000_000_000, 0, 7])
        back = roundtrip(a)
        @test back == a
        @test eltype(back) === eltype(a)
    end

    @test roundtrip(Float32[]) == Float32[]
end

@testitem "codec: an eltype with no tag travels as the dtype that carries it" setup=[Wire] begin
    using CesiumLink: decode_arrays

    roundtrip(a) = (w = lowered(a); decode_arrays(w[1], w[2]))
    tag_of(a) = lowered(a)[1]["\$wire"]

    flags = [true, false, true]
    @test tag_of(flags) == "u8"
    @test lowered(flags)[2] == UInt8[1, 0, 1]
    @test roundtrip(flags) == UInt8[1, 0, 1]
    @test roundtrip(BitVector(flags)) == UInt8[1, 0, 1]

    for (a, tag, T) in ((Int64[-7, 0, 2_000_000_000], "i32", Int32),
                        (Int16[-7, 0, 300], "i32", Int32),
                        (Int8[-7, 0, 100], "i32", Int32),
                        (UInt64[0, 7, 4_000_000_000], "u32", UInt32),
                        (UInt16[0, 7, 65_535], "u32", UInt32),
                        (Float16[1, -2.5, 1024], "f32", Float32))
        @test tag_of(a) == tag
        back = roundtrip(a)
        @test eltype(back) === T
        @test back == a
    end

    # A converted array keeps the shape it had.
    m = lowered([1 3 5; 2 4 6])[1]
    @test m["\$wire"] == "i32"
    @test m["shape"] == [3, 2]
    @test roundtrip([1 3 5; 2 4 6]) == Int32[1 3 5; 2 4 6]

    @test roundtrip(Int64[]) == Int32[]
end

@testitem "codec: a value no dtype can carry is refused, never narrowed" begin
    import CesiumLink
    # A refused array never reaches a region, so where its bytes would go does not matter here.
    encode_arrays(x) = CesiumLink.encode_arrays(x, IOBuffer())

    @test_throws "does not fit Int32" encode_arrays([1, 2, 3_000_000_000])
    @test_throws "Float64" encode_arrays([1, 2, 3_000_000_000])
    @test_throws "does not fit Int32" encode_arrays([-3_000_000_000, 0])
    @test_throws "does not fit UInt32" encode_arrays(UInt64[0, typemax(UInt64)])
    @test_throws "no dtype carries ComplexF64 arrays" encode_arrays([1.0 + 2im])
    @test_throws "no dtype carries Int128 arrays" encode_arrays(Int128[1, 2])
    @test_throws "no dtype carries Rational{Int64} arrays" encode_arrays([1 // 2])

    # Only numbers are converted. Everything else stays a walked JSON list, whatever it holds.
    @test encode_arrays(["a", "b"]) == ["a", "b"]
    @test encode_arrays(Any[1, "a"]) == Any[1, "a"]
    @test encode_arrays(Any[1, 2]) == Any[1, 2]
end

@testitem "codec: a multi-dimensional array keeps its shape and element order" setup=[Wire] begin
    using CesiumLink: decode_arrays

    a = reshape(Float64.(1:24), 2, 3, 4)
    w, region = lowered(a)
    back = decode_arrays(w, region)
    @test size(back) == (2, 3, 4)
    @test back == a
    @test vec(back) == Float64.(1:24)    # column-major order, unpermuted
end

@testitem "codec: non-array values pass through untouched" setup=[Wire] begin
    using CesiumLink: decode_arrays

    payload = Dict("html" => "<b>hi</b>", "idx" => 11, "on" => false, "missing" => nothing)
    @test lowered(payload) == (payload, UInt8[])
    @test decode_arrays(payload) == payload

    # Objects that merely look like the marker are ordinary payload values.
    for lookalike in (Dict("\$wire" => "not-a-dtype", "off" => 0),
                      Dict("\$wire" => "f32"),
                      Dict("\$wire" => 32, "off" => 0),
                      Dict("shape" => [1], "off" => 0),
                      Dict("\$wire" => "f32", "off" => "0"))
        @test decode_arrays(lookalike) == lookalike
    end
end

@testitem "codec: a shape that disagrees with the data is an error" begin
    using CesiumLink: decode_arrays

    # In a region the length is derived from the shape, so the bound is the region itself. This is
    # the whole of what stands between a malformed frame and a read past the bytes that arrived.
    @test_throws "runs past a region" decode_arrays(
        Dict("\$wire" => "f64", "shape" => [3], "off" => 0), zeros(UInt8, 16))
    @test_throws "runs past a region" decode_arrays(
        Dict("\$wire" => "f64", "shape" => [1], "off" => 16), zeros(UInt8, 16))
    @test_throws "must state its shape" decode_arrays(
        Dict("\$wire" => "f64", "off" => 0), zeros(UInt8, 16))
end

@testitem "codec: an index round-trips, and a broadcast keeps its element type" begin
    using CesiumLink: to_wire_index, from_wire_index

    # Both directions, over the integer types the conversion sites carry.
    for T in (Int, Int32, Int64, UInt32), i in T.((1, 2, 7))
        @test from_wire_index(to_wire_index(i)) == i
        @test to_wire_index(i) == i - 1
    end
    @test to_wire_index(1) == 0

    # `primitives.jl` broadcasts it over a 2 × M block of UInt32 pairs; the wire dtype must survive.
    m = UInt32[1 3 5; 2 4 6]
    @test eltype(to_wire_index.(m)) === UInt32
    @test to_wire_index.(m) == UInt32[0 2 4; 1 3 5]
end

@testitem "frame: every array lands 8-aligned, whatever its dtype" setup=[Wire] begin
    # Same-dtype arrays land 8-aligned by luck and exercise no padding at all, so this payload is
    # built to need a pad of 5, then 7, then 4. A NamedTuple both fixes the order the arrays are
    # written in and keeps their element types apart: `["a" => f64s, "b" => u8s]` would promote the
    # UInt8 array to Float64 with no error.
    w, region = lowered((; a = UInt8[1, 2, 3], b = Float64[1.5], c = UInt8[9],
                         d = Float32[1, 2], e = Float64[2.5]))
    @test [w[k]["off"] for k in ("a", "b", "c", "d", "e")] == [0, 8, 16, 24, 32]
    @test all(w[k]["off"] % 8 == 0 for k in keys(w))
    @test length(region) == 40
    # The pad is zeroed, not left as whatever the buffer held.
    @test region[4:8] == zeros(UInt8, 5)
end

@testitem "frame: a packed frame is a length, a header, a pad and the region" begin
    using CesiumLink: Frame, pack, unpack

    f = Frame("{\"method\":\"x\"}", UInt8[1, 2, 3, 4])
    bytes = pack(f)
    @test only(reinterpret(UInt32, bytes[1:4])) == UInt32(length(f.header))
    @test String(bytes[5:18]) == f.header
    @test length(bytes) % 8 == 4                      # 14-byte header, pad to 24, then 4 blob bytes
    @test bytes[19:24] == zeros(UInt8, 6)             # the pad is zeroed
    @test bytes[25:end] == f.blobs

    # Split back apart, for every header length across one alignment cycle.
    for n in 1:16
        g = unpack(pack(Frame("x"^n, UInt8[7, 7])))
        @test g.header == "x"^n
        @test g.blobs == UInt8[7, 7]
    end

    # A message with no arrays is a frame with an empty region.
    @test unpack(pack(Frame("{}"))).blobs == UInt8[]
    @test_throws "at least 4 bytes" unpack(UInt8[1, 2])
    @test_throws "runs past a frame" unpack(pack(Frame("hello"))[1:6])
end
