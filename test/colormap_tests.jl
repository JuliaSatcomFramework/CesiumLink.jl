@testitem "a colour is a ColorTypes value, a hex string or a byte tuple" begin
    using CesiumLink: rgba8
    using ColorTypes

    @test rgba8(RGB(1.0, 0.0, 0.5)) == (0xff, 0x00, 0x80, 0xff)
    @test rgba8(RGBA(0.0, 1.0, 0.0, 0.5)) == (0x00, 0xff, 0x00, 0x80)
    @test rgba8("#33e0ff") == (0x33, 0xe0, 0xff, 0xff)
    @test rgba8("#33e0ff80") == (0x33, 0xe0, 0xff, 0x80)
    @test rgba8("#f0a") == (0xff, 0x00, 0xaa, 0xff)      # the shorthand doubles each digit
    @test rgba8((60, 190, 255)) == (60, 190, 255, 255)
    @test rgba8((60, 190, 255, 128)) == (60, 190, 255, 128)

    @test_throws "#rgb, #rrggbb or #rrggbbaa" rgba8("#12345")
    @test_throws "#rgb, #rrggbb or #rrggbbaa" rgba8("not a colour")
    @test_throws "(r, g, b) or (r, g, b, a)" rgba8((1, 2))
    @test_throws "integers in 0..255" rgba8((0, 0, 300))
end

@testitem "a colormap is an ordinary Julia value, in one of three forms" begin
    using CesiumLink: sample_rgba, colormap_stops

    # A vector of colours is spread evenly from 0 to 1.
    even = ["#000000", "#ff0000", "#ffffff"]
    @test colormap_stops(even)[1] == [0.0, 0.5, 1.0]
    @test sample_rgba(even, 0.0) == (0x00, 0x00, 0x00, 0xff)
    @test sample_rgba(even, 0.5) == (0xff, 0x00, 0x00, 0xff)
    @test sample_rgba(even, 0.25) == (0x80, 0x00, 0x00, 0xff)   # blended between its stops

    # A vector of pairs places the stops itself, and their order does not matter.
    placed = [1.0 => "#ffffff", 0.0 => "#000000", 0.9 => "#ff0000"]
    @test colormap_stops(placed)[1] == [0.0, 0.9, 1.0]
    @test sample_rgba(placed, 0.45) == (0x80, 0x00, 0x00, 0xff)

    # Anything answering `get(cmap, t)` samples as its own package defines it — which is what makes
    # a ColorSchemes.jl scheme work without CesiumLink knowing it exists.
    struct Ramp end
    Base.get(::Ramp, t::Real) = (round(Int, 255t), 0, 0)
    @test sample_rgba(Ramp(), 0.5) == (128, 0, 0, 255)

    # Outside [0, 1] the ends stand rather than extrapolating.
    @test sample_rgba(even, -3) == sample_rgba(even, 0)
    @test sample_rgba(even, 7) == sample_rgba(even, 1)
    @test sample_rgba(["#123456"], 0.7) == (0x12, 0x34, 0x56, 0xff)

    @test_throws "at least one colour" colormap_stops(String[])
    @test_throws "lie in [0, 1]" colormap_stops([2.0 => "#000000"])
end

@testitem "rgba maps values onto the byte matrix the three families take" begin
    using CesiumLink: rgba

    cmap = ["#000000", "#ffffff"]
    m = rgba(cmap, [0.0, 5.0, 10.0]; range = (0, 10))
    @test size(m) == (4, 3)
    @test m[:, 1] == UInt8[0, 0, 0, 255]
    @test m[:, 2] == UInt8[128, 128, 128, 255]
    @test m[:, 3] == UInt8[255, 255, 255, 255]

    # `range` clamps rather than extrapolating, so an out-of-range value takes an end colour.
    @test rgba(cmap, [-4.0, 40.0]; range = (0, 10)) == UInt8[0 255; 0 255; 0 255; 255 255]

    # The default range is what the values themselves span.
    @test rgba(cmap, [2.0, 4.0])[:, 1] == UInt8[0, 0, 0, 255]

    # alpha is a scalar or one value per entity — how a dimmed idle entity is expressed.
    @test rgba(cmap, [10.0]; range = (0, 10), alpha = 0.5)[4, 1] == 128
    @test rgba(cmap, [0.0, 10.0]; alpha = [0.1, 1.0])[4, :] == UInt8[26, 255]
    # An alpha the colormap itself carries is kept, and the argument multiplies into it.
    @test rgba(["#00000080"], [1.0]; alpha = 0.5)[4, 1] == 64

    # A range with no span has nothing to spread values over.
    @test rgba(cmap, [3.0, 3.0])[:, 2] == UInt8[0, 0, 0, 255]

    @test_throws "alpha has 3 values for 2 entities" rgba(cmap, [1.0, 2.0]; alpha = [1.0, 1.0, 1.0])
end

@testitem "a value that is NaN draws nothing" begin
    using CesiumLink: rgba

    cmap = ["#000000", "#ffffff"]

    # The missing entry takes alpha 0, and the others are coloured over 1.0 … 3.0 as if it were absent.
    m = rgba(cmap, [1.0, NaN, 3.0])
    @test size(m) == (4, 3)
    @test m[4, :] == UInt8[255, 0, 255]
    @test m[:, 1] == UInt8[0, 0, 0, 255]
    @test m[:, 3] == UInt8[255, 255, 255, 255]

    # The convention belongs to the value, not to how the range was obtained.
    @test rgba(cmap, [1.0, NaN, 3.0]; range = (1, 3)) == m
    # It also beats whatever `alpha` asks for.
    @test rgba(cmap, [1.0, NaN]; range = (0, 1), alpha = 1.0)[4, 2] == 0
    @test rgba(cmap, [1.0, NaN]; range = (0, 1), alpha = [1.0, 1.0])[4, 2] == 0

    # An infinite value has a colour: it clamps to an end like any out-of-range value.
    @test rgba(cmap, [Inf, -Inf]; range = (0, 10))[4, :] == UInt8[255, 255]

    @test_throws "the range cannot be computed" rgba(cmap, [NaN, NaN])
end
