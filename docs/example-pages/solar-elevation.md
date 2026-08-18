# 1 · Solar elevation

How high the sun stands over every point of the globe at one instant, drawn as colour on the
surface. Five coarse regions lie over it, each filled by its own mean.

```sh
julia examples/solar_elevation.jl
```

Or start it from a session that already has CesiumLink — see [Run an example](@ref "Run an example"):

```julia
server = include(joinpath(pkgdir(CesiumLink), "examples", "solar_elevation.jl"))
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/solar-elevation.jsonl&modules=modules"
        title="Solar elevation over the globe, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

There is no clock. The camera still moves: a three-stop
[camera track](../how-to/camera-tour.md) paced with `after`, because one keyframe gives no keyframe
axis to key on. The stops come 8 s and 20 s after load, then the globe stands still. A wall-paced
tour runs once, so reload the page to see it again. Drag the globe and the tour stops; **Rejoin**
gives the camera back.

## One file, one dependency

The whole program is one file. It imports `CesiumLink` and `Dates`, and nothing else. There is no
`Project.toml` and no orbit propagator: the sun's position is a closed form of six lines, and the
field is a comprehension over it. The first rung of the ladder needs no JavaScript at all.

## The scene has no clock

The picture is a statistic on the globe rather than a state at a time. Nothing plays, so the example
asks for none of the time furniture:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

That takes the ruler, the clock face and the keyframe readout off the screen together. **This one
call is the whole difference between a timeless scene and a scene of one instant.** The frame count
does not say which one this is: a scene that shows a real instant still wants its clock, so only the
author knows.

[Show a scene with no clock](../how-to/static-scene.md) covers the rest of the shape.

## The field is one raster

[`rgba_grid`](@ref) bakes the elevation values into colour, and [`Raster`](@ref) names the box those
colours cover:

```julia
Raster(:elevation; extent = (-180.0, -90.0, 180.0, 90.0),
       rgba = rgba_grid(CMAP, values; range = RANGE))
```

`values` is `180 × 90`: longitude first and west to east, then latitude and south to north, sampled
at the centre of each two-degree cell. `range` is stated rather than left to the data, so the
colours answer to the legend beside them. It is symmetric, `(-90, 90)`, so the middle colour falls
on zero: that line is the terminator between day and night.

Julia bakes every shade. The browser picks no colour.

## The regions are rings

The five patches over the field are one [`Areas`](@ref) family, built from vertices rather than from
a centre and a radius:

```julia
Areas(:region; boundary = REGIONS, outline = "#000000d9",
      color = rgba(CMAP, region_values; range = RANGE))
```

`boundary` takes one entry per region, each a `2 × V` matrix of longitude and latitude in degrees.
A ring is open: the last vertex joins the first, so do not repeat it. The rings are written by hand
and coarse, there to show what `boundary` takes and not to be a map.

Each region takes its fill from the colormap and the range of the field under it, so a fill that
matches its surroundings means a mean that agrees with them.

## Full source

{{source}}
