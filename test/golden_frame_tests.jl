@testitem "the golden frame still packs to the bytes that are checked in" begin
    using CesiumLink: pack, unpack, decode_arrays
    using JSON

    include(joinpath(pkgdir(CesiumLink), "tools", "golden-frame.jl"))

    f = unpack(read(GOLDEN_PATH))
    built = golden_frame()

    # The region is asserted byte for byte: it is where the offsets, the pads and the element order
    # all show. The header is asserted by parsing it, because Julia's `Dict` fixes no key order and
    # the browser parses it as JSON anyway.
    @test f.blobs == built.blobs
    @test length(f.blobs) == 88

    p = only(JSON.parse(f.header)["params"]["commands"])["payload"]
    @test JSON.parse(built.header) == JSON.parse(f.header)

    # Every array lands on a multiple of 8, and the pads between them are 5, then 7, then 4.
    @test [p[k]["off"] for k in ("flags", "scale", "one", "speed", "depth", "grid")] ==
          [0, 8, 24, 32, 48, 56]
    @test p["nested"]["ids"]["off"] == 80

    # Row-major on the wire, the reverse of Julia's `size`, and the flat byte order is the same on
    # both sides.
    @test p["grid"]["shape"] == [3, 2]
    @test decode_arrays(p["grid"], f.blobs) == Int32[1 3 5; 2 4 6]
    @test f.blobs[57:80] == reinterpret(UInt8, Int32[1, 2, 3, 4, 5, 6])

    # A flat array states its shape too, and a plain value keeps travelling in the header.
    @test p["one"]["shape"] == [1]
    @test p["label"] == "north"
    @test p["nested"]["count"] == 3

    for (k, v) in ("flags" => UInt8[1, 2, 3], "scale" => Float64[1.5, -2.5], "one" => UInt8[7],
                   "speed" => Float32[1, 2, 3], "depth" => Float64[9.25])
        @test decode_arrays(p[k], f.blobs) == v
    end
    @test decode_arrays(p["nested"]["ids"], f.blobs) == UInt32[10, 20]
end
