# 1 · Solar elevation

How high the sun stands over every point of the globe, at one instant, as colour on the surface —
with five coarse regions drawn over it, each filled by its own mean.

```sh
julia --project=. examples/solar_elevation.jl
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/solar-elevation.jsonl&modules=modules"
        title="Solar elevation over the globe, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

There is no clock, and the section below says why. The camera still moves: the example declares a
three-stop [camera track](../how-to/camera-tour.md), paced with `after` because a scene of one
keyframe has no keyframe axis to key on. The stops come 8 s and 20 s after the scene loads, and the
globe stands still after the last one. A wall-paced tour runs once, so reload the page to watch it
from the start. Drag to turn the globe and the tour stops; the **Rejoin** button gives the camera
back.

## One file, one dependency

The whole program is one file. It imports `CesiumLink` and `Dates`, and nothing else. There is no
`Project.toml`, no package to install, and no orbit propagator: the position of the sun is a closed
form of six lines, and the field is a comprehension over it.

That is what the first rung of the ladder is for. A scene that draws a field over the globe needs
one Julia file and no JavaScript at all.

## The scene has no clock

The picture is a statistic on the globe, not a state at a time. Nothing plays, nothing steps and
there is nothing to scrub. So the example asks for none of the time furniture:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

That takes the ruler, the clock face and the keyframe readout off the screen together. **This one
call is the whole difference between a timeless scene and a scene of one instant.** The wire carries
the furniture set, not the reason for it, and a window of one keyframe is not a reason: a scene that
shows a real instant still wants its clock. Only the author knows which kind the scene is.

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
colours answer to the legend beside them. It is symmetric — `(-90, 90)` — which puts the middle
colour of the map on zero, and that is the terminator you see between day and night.

Julia bakes every shade. The browser reads no value and picks no colour.

## The regions are rings

The five patches over the field are one [`Areas`](@ref) family, built from vertices rather than from
centres and a radius:

```julia
Areas(:region; boundary = REGIONS, outline = "#000000d9",
      color = rgba(CMAP, region_values; range = RANGE))
```

`boundary` takes one entry per region, each a `2 × V` matrix of longitude and latitude in degrees.
A ring is open: the last vertex joins the first, so do not repeat it. The rings here are written out
by hand and are deliberately coarse — they show what `boundary` takes, and they are not a map.

Each region is filled from the same colormap and the same range as the field under it, so a region
whose fill matches its surroundings is a region whose mean agrees with them.

## Full source

{{source}}
