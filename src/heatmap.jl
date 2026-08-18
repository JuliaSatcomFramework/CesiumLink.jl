# The payload vocabulary of the vendored `heatmap` module: a continuous field, already coloured,
# draped over a box of longitude and latitude. What the field measures stays in whatever package
# owns it.
#
# Julia bakes the colour. Nothing in the browser reads a value and picks a shade from it, so a
# colorbar and the texels it describes cannot drift apart.
#
# One raster covers one rectangle, and there is one code path for every rectangle. The whole globe
# is the box `(-180, -90, 180, 90)`. A field that is not a rectangle gives the texels outside it
# `alpha = 0`. A fine field over a coarse one is two rasters, in the order they stack.

module Heatmap

# What this vocabulary takes from the rest of the package, and the whole of it.
using ..CesiumLink: rgba

export Raster, rgba_grid, heatmap_index, heatmap_payload

# --- the box a raster covers ---------------------------------------------------------------------

# `extent` as the four degrees `(west, south, east, north)`, checked. `what` names whoever is
# refused, so the message points at the raster the author wrote rather than at this function.
function to_extent(what, extent)
    e = collect(Float64, extent)
    length(e) == 4 || throw(ArgumentError(
        "$what: an extent is (west, south, east, north) in degrees (got $(length(e)) values)"))
    all(isfinite, e) ||
        throw(ArgumentError("$what: an extent has a coordinate that is not finite (got $e)"))
    west, south, east, north = e
    west < east || throw(ArgumentError(
        "$what: an extent runs west to east, and $west is not west of $east. A field that " *
        "crosses ±180° is two rasters, one each side of it"))
    south < north || throw(ArgumentError(
        "$what: an extent runs south to north, and $south is not south of $north"))
    -180 ≤ west && east ≤ 180 || throw(ArgumentError(
        "$what: an extent lies between -180° and 180° of longitude (got $west to $east)"))
    -90 ≤ south && north ≤ 90 || throw(ArgumentError(
        "$what: an extent lies between -90° and 90° of latitude (got $south to $north)"))
    return (west, south, east, north)
end

# --- baking a field into texels ------------------------------------------------------------------

"""
    rgba_grid(cmap, values; range, alpha=1.0) -> Array{UInt8}

Colour a gridded field into the byte array [`Raster`](@ref) takes. `values` is `W × H`, indexed
**longitude first, west to east, then latitude, south to north** — both ascending, which is the grid
`[f(lon, lat) for lon in lons, lat in lats]` builds. A field that moves is `W × H × keyframes`, and
it switches at the keyframe crossing like every other colour in the scene.

The result is `4 × W × H`, or `4 × W × H × keyframes`. It reaches the browser as the image a texture
is made from, with **the north edge as row 0 and the west edge as column 0**. This function is where
the latitude axis turns around to meet that, and it is the only place it does.

`range` and `alpha` are [`rgba`](@ref)'s: `range` is the value span the colormap covers and `alpha`
is a scalar or one value per texel. A value that is `NaN` draws nothing, so a field with holes in it
needs no mask — and a shape that is not a rectangle is a box whose outside texels are `NaN`. The
default `range` covers the finite values of the whole array, keyframes and all, so a moving field
does not re-scale under its own colorbar.

```julia
values = [demand(lon, lat) for lon in -20:0.5:40, lat in 10:0.5:50]
grid = rgba_grid(ColorSchemes.viridis, values; range = (0, 12))
```
"""
function rgba_grid(cmap, values; kw...)
    ndims(values) in (2, 3) || throw(ArgumentError(
        "a heatmap grid is W × H of longitude then latitude, or W × H × keyframes " *
        "(got $(size(values)))"))
    size(values, 1) ≥ 1 && size(values, 2) ≥ 1 || throw(ArgumentError(
        "a heatmap grid covers at least one texel (got $(size(values)))"))
    baked = reshape(rgba(cmap, values; kw...), 4, size(values)...)
    # `values` ascends south to north and row 0 of the image is the north edge.
    return reverse(baked; dims = 3)
end

"""
    heatmap_index(extent, (W, H), lon, lat) -> Union{Nothing,Tuple{Int,Int}}

Which texel of a `W × H` grid over `extent` holds the coordinate, as an index into the `values`
[`rgba_grid`](@ref) takes, or `nothing` where the coordinate lies outside the box.

This is the exact inverse of the mapping [`rgba_grid`](@ref) bakes in, so a listener answers a
tooltip out of the array it sent and the number cannot disagree with the pixel. A texel covers a
cell of the box, and a field sampled at cell centres therefore inverts exactly. The box divides into
`W × H` equal cells, and a coordinate on the eastern or northern edge reads the last cell rather
than `nothing`.

```julia
ij = heatmap_index(extent, size(values), lon, lat)
ij === nothing || tooltip!(reply) do io
    print(io, values[ij...], " Mbps")
end
```
"""
function heatmap_index(extent, dims, lon, lat)
    west, south, east, north = to_extent(:heatmap_index, extent)
    i = cell_index(float(lon), west, east, Int(dims[1]))
    j = cell_index(float(lat), south, north, Int(dims[2]))
    return i === nothing || j === nothing ? nothing : (i, j)
end

# Which of `n` equal cells spanning `lo` to `hi` holds `x`, or `nothing` when `x` is outside them.
function cell_index(x, lo, hi, n)
    (isfinite(x) && lo ≤ x ≤ hi) || return nothing
    return min(n, floor(Int, (x - lo) / (hi - lo) * n) + 1)
end

# --- the family ----------------------------------------------------------------------------------

"""
    Raster(kind; extent, rgba)

One heatmap: a grid of baked colour and the box of degrees it is stretched over. `extent` is
`(west, south, east, north)`, ordered and within `±180°` of longitude and `±90°` of latitude. `rgba`
is the `UInt8` array [`rgba_grid`](@ref) returns, `4 × W × H` or `4 × W × H × keyframes`.

`kind` names the raster inside the window. A later window replaces the raster of the same name, and
the order rasters are passed in is the order they stack: a later one draws over an earlier one.

A field that crosses ±180° is refused, because the box it describes is then ambiguous. Declare two
rasters, one each side of the meridian.

```julia
Raster(:coverage; extent = (-20, 10, 40, 50), rgba = rgba_grid(CMAP, demand))
Raster(:globe; extent = (-180, -90, 180, 90), rgba = rgba_grid(CMAP, coarse))
```
"""
struct Raster
    # A raster name the scene author invents, so a `String` like every other one (ADR-0029).
    kind::String
    extent::NTuple{4,Float64}
    # `4 × W × H`, or `4 × W × H × keyframes`, with the north edge last on the latitude axis.
    rgba::Array{UInt8}
    # An INNER constructor so the shape checks run for every call form: an exact-typed call would
    # otherwise reach the auto-generated one and put a malformed raster on the wire.
    function Raster(kind, extent, grid)
        ext = to_extent(kind, extent)
        # The wire carries bytes, and a Float64 grid is four times the size for nothing. Say so
        # rather than convert: a caller holding values rather than colours wants `rgba_grid`.
        grid isa AbstractArray{UInt8} || throw(ArgumentError(
            "$kind.rgba is a UInt8 array of baked colour, which is what `rgba_grid` returns " *
            "(got $(typeof(grid)))"))
        ndims(grid) in (3, 4) && size(grid, 1) == 4 || throw(ArgumentError(
            "$kind.rgba is 4 × W × H, or 4 × W × H × keyframes (got $(size(grid)))"))
        size(grid, 2) ≥ 1 && size(grid, 3) ≥ 1 || throw(ArgumentError(
            "$kind.rgba covers at least one texel (got $(size(grid)))"))
        return new(String(kind), ext, convert(Array{UInt8}, grid))
    end
end

Raster(kind; extent, rgba) = Raster(kind, extent, rgba)

"""
    heatmap_payload(rasters...) -> NamedTuple

The `heatmap` module's payload for one window, out of any number of [`Raster`](@ref)s. Pass it to
[`CesiumLink.push_window`](@ref) addressed to `:heatmap`; the keyframe count travels with the window, not with
the payload, because the transport does not interpret a payload and so cannot count the frames in
one.

```julia
push_window(server, Dict(:heatmap => heatmap_payload(
                Raster(:coverage; extent = (-20, 10, 40, 50), rgba = grid)));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```
"""
function heatmap_payload(rasters::Raster...)
    seen = Set{String}()
    for r in rasters
        r.kind in seen &&
            throw(ArgumentError("two heatmaps are both named $(repr(r.kind))"))
        push!(seen, r.kind)
    end
    return (; heatmaps = [lower(r) for r in rasters])
end

# The extent stays a tuple: the module reads four plain numbers there, not an encoded array.
lower(r::Raster) = (; r.kind, extent = r.extent, rgba = r.rgba)

end # module Heatmap
