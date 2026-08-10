# Drape a scalar field over the globe

You hold a field of numbers over longitude and latitude: demand, rain fade, elevation
statistics. You want it on the globe as colour, with a colorbar that agrees with it, and a
hover that says what the number under the cursor is.

The `heatmap` module draws it. Julia bakes the colour, so nothing in the browser reads a
value or picks a shade from it.

## Build the grid, colour it, send it

The grid is `W × H`: longitude first, west to east, then latitude, south to north. Both axes
ascend. Sample the field at cell centres, so the inverse mapping is exact.

```@example heatmap
using CesiumLink

# The centres of `n` equal cells that span `lo` to `hi`.
centres(lo, hi, n) = range(lo + (hi - lo) / 2n, hi - (hi - lo) / 2n; length = n)

extent = (-20.0, 10.0, 40.0, 50.0)          # west, south, east, north
lons = centres(extent[1], extent[3], 60)
lats = centres(extent[2], extent[4], 40)

demand(lon, lat) = 12 + 6 * sind(3lon) + lat / 5
values = [demand(lon, lat) for lon in lons, lat in lats]
size(values)
```

[`rgba_grid`](@ref) bakes the values into the byte array a raster carries. State `range`
yourself when more than one raster, or more than one keyframe, must answer to the same
colours.

```@example heatmap
CMAP = ["#0d0887", "#b12a90", "#fca636", "#f0f921"]
RANGE = (0.0, 25.0)

grid = rgba_grid(CMAP, values; range = RANGE)
size(grid)                                   # 4 × W × H
```

[`Raster`](@ref) names the grid and the box it covers. [`heatmap_payload`](@ref) makes the
module's payload out of any number of rasters, and [`push_window`](@ref) sends it.

```julia
server = start_server()
register_module!(server, vendored(:heatmap))
register_module!(server, vendored(:ui))

push_window(server, Dict(:heatmap => heatmap_payload(
                Raster(:demand; extent, rgba = grid)));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```

A raster is declared per window. A window that says nothing about the heatmap leaves the
screen as it is, so a scene that pushes a run of windows states its rasters in each one.

Add the colorbar from the same colormap and the same range.

```julia
declare_overlay(server, [Legend("Demand [Gbps]", RANGE..., CMAP; region = :top_right)])
```

## Leave out the texels you have no value for

A value that is `NaN` draws nothing. Its texel takes `alpha = 0`, and the imagery below
shows through.

```@example heatmap
holed = copy(values)
holed[1, 1] = NaN
rgba_grid(CMAP, holed; range = RANGE)[:, 1, end]     # the north-west texel, fully transparent
```

Two consequences you can use:

- A field with holes in it needs no mask of its own.
- **A shape that is not a rectangle is a rectangle whose outside texels are `NaN`.** Build
  the box, then write `NaN` everywhere the shape does not cover.

If you leave `range` out, it covers the finite values of the whole array. One missing value
does not move the colours of the others. Every value missing raises, because there is then
no range to compute.

## Stack a fine field over a coarse one

One raster covers one box. Pass several to [`heatmap_payload`](@ref) in the order they
stack. A later one draws over an earlier one.

```julia
heatmap_payload(Raster(:globe; extent = (-180, -90, 180, 90), rgba = coarse),
                Raster(:peak;  extent = (10, 30, 50, 60),     rgba = fine))
```

Put the fine raster's bounds on coarse cell boundaries. Its edges then line up with the
cells underneath rather than cut across them.

A field that crosses ±180° is refused, because the box it names is then ambiguous. Declare
two rasters, one each side of the meridian.

## Move the field over time

A field that changes is `W × H × keyframes`, and [`rgba_grid`](@ref) returns
`4 × W × H × keyframes`. The image switches at the keyframe crossing. It does not blend two
of them.

The default `range` covers the finite values of the whole array, keyframes and all, so a
moving field does not re-scale under its own colorbar.

## Report the value under the cursor

This module owns no entity, so a hover picks nothing over it. It samples at the cursor's
globe coordinate instead. Ask for the coordinate with `coordinate = true`, then invert the
grid with [`heatmap_index`](@ref).

```julia
on_pointer(server; type = :hover, coordinate = true) do ev, reply
    # The coordinate is `nothing` when the ray misses the globe. That is an ordinary hover
    # off the limb, and not an error.
    c = ev.coordinate
    ij = c === nothing ? nothing : heatmap_index(extent, size(values), c.lon, c.lat)
    if ij === nothing || isnan(values[ij...])
        command!(reply, "ui", "tooltip", (; html = nothing))
    else
        tooltip!(reply) do io
            print(io, "<b>", round(values[ij...]; digits = 2), " Gbps</b>")
        end
    end
end
```

[`heatmap_index`](@ref) is the exact inverse of the mapping [`rgba_grid`](@ref) bakes in, so
the number the tooltip states and the pixel the eye reads cannot disagree. It answers
`nothing` outside the box. The far edge belongs to the last cell, so a coordinate on the
boundary of the box indexes rather than misses.

With several rasters, search them in reverse declared order: the raster on top is the one
the eye sees. Skip a raster whose texel is `NaN` there, and the answer falls through to the
raster that is visible underneath.

The globe raycast is an opt-in. A session where no listener asks for the coordinate never
pays for it.

## Is `heatmap_index` the right tool for a value per cell?

Use it when the field really is a grid over a box. It maps a coordinate back to the cell
your own `values` array holds, so a tooltip reads the array you sent.

It is the wrong tool for cells that are not a grid: a mesh of irregular polygons, or ground
cells with centres of their own. Those are entities, and the `primitives` module draws them
as [`Areas`](@ref). A hover then reports the entity under the cursor, and the listener reads
`ev.entity.idx` instead. See [Draw points, lines and areas](primitives.md).

## Next

- [Heatmap vocabulary](../reference/heatmap.md) for the whole surface.
- [Colours](../reference/colormap.md) for the colormap forms [`rgba`](@ref) accepts.
- [Send large arrays](large-arrays.md), because a fine grid is the largest array most scenes
  send.
