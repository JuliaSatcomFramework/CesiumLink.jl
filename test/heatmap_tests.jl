# A grid is coloured longitude-first and ascending in both axes, and the image it becomes has north
# at the top. The field these test items share puts its peak at 25°E 46°N and its trough at 5°W 14°N
# — see the `HeatmapField` snippet for why it is asymmetric in both axes.

@testitem "a baked grid puts the peak where the field put it" setup=[HeatmapField] begin
    using CesiumLink: rgba_grid, heatmap_index

    values = demand_field()
    values[5, 5] = 10.0                                    # 25°E 46°N, the highest texel
    values[2, 1] = -5.0                                    # 5°W 14°N, the lowest
    grid = rgba_grid(GRAY, values)

    @test size(grid) == (4, 6, 5)                          # 4 × W × H
    # Row 0 of the image is the north edge, so the northernmost latitude is the *first* index of the
    # latitude axis. The peak is at longitude index 5, and at latitude index 5 of 5.
    @test grid[:, 5, 1] == UInt8[0xff, 0xff, 0xff, 0xff]
    @test grid[:, 2, 5] == UInt8[0x00, 0x00, 0x00, 0xff]
    # And nowhere else: one wrong reshape, or one wrong flip, moves these.
    @test findall(==(0xff), grid[1, :, :]) == [CartesianIndex(5, 1)]
    @test findall(==(0x00), grid[1, :, :]) == [CartesianIndex(2, 5)]

    # The inverse lands on the cells the peak and the trough were built at.
    @test heatmap_index(EXTENT, (6, 5), 25.0, 46.0) == (5, 5)
    @test heatmap_index(EXTENT, (6, 5), -5.0, 14.0) == (2, 1)
    # The corners of the box, whose far edges belong to the last cell.
    @test heatmap_index(EXTENT, (6, 5), -20.0, 10.0) == (1, 1)
    @test heatmap_index(EXTENT, (6, 5), 40.0, 50.0) == (6, 5)
    # Outside the box there is no texel to name.
    @test heatmap_index(EXTENT, (6, 5), -20.1, 30.0) === nothing
    @test heatmap_index(EXTENT, (6, 5), 0.0, 9.9) === nothing
    @test heatmap_index(EXTENT, (6, 5), NaN, 30.0) === nothing
end

@testitem "a texel with no value draws nothing" setup=[HeatmapField] begin
    using CesiumLink: rgba_grid

    values = [1.0 2.0; NaN 4.0; 3.0 5.0]                   # 3 × 2, longitude then latitude
    grid = rgba_grid(GRAY, values)

    @test size(grid) == (4, 3, 2)
    @test grid[:, 2, 2] == UInt8[0x00, 0x00, 0x00, 0x00]   # the missing texel, fully transparent
    # The range covers the finite values only, so 1.0 is still the bottom of the ramp and 5.0 the
    # top. A range poisoned by the `NaN` would colour every texel the same.
    @test grid[:, 1, 2] == UInt8[0x00, 0x00, 0x00, 0xff]
    @test grid[:, 3, 1] == UInt8[0xff, 0xff, 0xff, 0xff]
end

@testitem "a field that moves shares one range" setup=[HeatmapField] begin
    using CesiumLink: rgba_grid

    values = zeros(3, 2, 2)                                # W × H × keyframes
    values[:, :, 1] = [1.0 2.0; 3.0 4.0; 5.0 6.0]
    values[:, :, 2] = [1.0 2.0; 3.0 4.0; 5.0 9.0]
    grid = rgba_grid(GRAY, values)

    @test size(grid) == (4, 3, 2, 2)                       # the keyframes are the trailing axis
    # One range over the whole array: 6.0 is the top of keyframe 1 and is not the top of the ramp,
    # because keyframe 2 reaches 9.0. A range computed per keyframe would draw both of them white.
    @test grid[1, 3, 1, 1] != 0xff
    @test grid[1, 3, 1, 2] == 0xff
    @test grid[1, 1, 2, 1] == 0x00                         # 1.0, the bottom, in both keyframes
    @test grid[1, 1, 2, 2] == 0x00
end

@testitem "a raster travels as an image with north at the top" setup=[HeatmapField, Wire] begin
    using CesiumLink: Raster, rgba_grid, heatmap_payload, decode_arrays

    values = demand_field()
    values[5, 5] = 10.0
    grid = rgba_grid(GRAY, values)
    p, region = lowered(heatmap_payload(Raster(:coverage; extent = EXTENT, rgba = grid)))
    p = p["heatmaps"][1]

    @test p["kind"] == "coverage"
    # Four plain numbers, not an encoded array: the module reads them straight.
    @test p["extent"] == [-20.0, 10.0, 40.0, 50.0]
    # Row-major H × W × 4, the reverse of Julia's 4 × W × H, so neither side permutes anything.
    @test p["rgba"]["shape"] == [5, 6, 4]

    # The bytes as they arrive, and the peak still where the wire shape says it is.
    arrived = decode_arrays(p["rgba"], region)
    @test arrived == grid
    @test arrived[:, 5, 1] == UInt8[0xff, 0xff, 0xff, 0xff]

    # A field that moves carries the keyframe as the leading wire axis, so each keyframe is one
    # contiguous H × W × 4 block.
    moving = rgba_grid(GRAY, cat(values, values .+ 1; dims = 3))
    q = first(lowered(heatmap_payload(Raster(:coverage; extent = EXTENT,
                                              rgba = moving))))["heatmaps"][1]
    @test q["rgba"]["shape"] == [2, 5, 6, 4]

    # The order the rasters are passed in is the order they stack.
    two = heatmap_payload(Raster(:globe; extent = (-180, -90, 180, 90), rgba = grid),
                          Raster(:coverage; extent = EXTENT, rgba = grid))
    @test [h.kind for h in two.heatmaps] == ["globe", "coverage"]
end

@testitem "a raster names itself when it refuses what it is given" setup=[HeatmapField] begin
    using CesiumLink: Raster, rgba_grid, heatmap_index, heatmap_payload

    grid = rgba_grid(GRAY, demand_field())

    @test_throws "coverage: an extent is (west, south, east, north)" Raster(
        :coverage; extent = (-20.0, 10.0, 40.0), rgba = grid)
    @test_throws "coverage: an extent has a coordinate that is not finite" Raster(
        :coverage; extent = (-20.0, 10.0, NaN, 50.0), rgba = grid)
    # A box that wraps the meridian is ambiguous, and the message says how to declare it instead.
    @test_throws "two rasters, one each side of it" Raster(
        :coverage; extent = (170.0, 10.0, -170.0, 50.0), rgba = grid)
    @test_throws "coverage: an extent runs south to north" Raster(
        :coverage; extent = (-20.0, 50.0, 40.0, 10.0), rgba = grid)
    @test_throws "coverage: an extent lies between -90° and 90°" Raster(
        :coverage; extent = (-20.0, 10.0, 40.0, 95.0), rgba = grid)

    # A grid of anything but bytes is a caller error: the wire carries UInt8, and a Float64 grid is
    # four times the size for nothing.
    @test_throws "coverage.rgba is a UInt8 array" Raster(
        :coverage; extent = EXTENT, rgba = Float64.(grid))
    @test_throws "coverage.rgba is 4 × W × H" Raster(
        :coverage; extent = EXTENT, rgba = grid[:, :, 1])
    @test_throws "coverage.rgba is 4 × W × H" Raster(
        :coverage; extent = EXTENT, rgba = rand(UInt8, 3, 6, 5))

    @test_throws "W × H of longitude then latitude" rgba_grid(GRAY, [1.0, 2.0, 3.0])
    @test_throws "heatmap_index: an extent runs west to east" heatmap_index(
        (40.0, 10.0, -20.0, 50.0), (6, 5), 0.0, 30.0)

    @test_throws "two heatmaps are both named \"coverage\"" heatmap_payload(
        Raster(:coverage; extent = EXTENT, rgba = grid),
        Raster(:coverage; extent = EXTENT, rgba = grid))
end
