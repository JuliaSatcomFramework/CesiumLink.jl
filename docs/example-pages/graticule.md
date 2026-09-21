# 6 · The graticule

Meridians and parallels over a bare globe, and nothing else on it.

```sh
julia examples/graticule.jl
```

Or start it from a session that already has CesiumLink — see [Run an example](@ref "Run an example"):

```julia
server = include(joinpath(pkgdir(CesiumLink), "examples", "graticule.jl"))
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/graticule.jsonl&modules=modules"
        title="A graticule over the globe, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

**This example registers no module.** There is no satellite, no cell and no raster, because the
graticule is not one of the things a module draws. The Core draws it with no module loaded, under
whatever the modules put on the globe, so the program has nothing to register.

## No window at all

Every other example pushes at least one window. This one pushes none: the scene has no time in it,
and the graticule is a declaration rather than data of a frame. So the program says the one thing a
timeless scene says, and nothing else:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

The globe, the basemap picker and the corner buttons are all there without a window. See
[Show a scene with no clock](../how-to/static-scene.md) for the scene that does hold one keyframe.

## One call, the whole statement

```julia
declare_graticule(server; spacing = (20, 10), color = "#1c2b4acc", width = 1.5,
                  label_color = "#0d1626e0", label_font = "13px system-ui")
```

`spacing` is degrees, one number for both families or `(lon, lat)` for the meridians and the
parallels apart. This scene puts the meridians twenty degrees apart and the parallels ten.

[`declare_graticule`](@ref) takes the whole set of keywords every time. A keyword a call does not
name takes its default, not what an earlier call said, so a session that wants a finer grid says so
in one call and repeats nothing:

```julia
declare_graticule(server; spacing = 10)
```

That call draws the default colour and width, not the ones above. The declaration is retained, so a
browser connecting later gets the grid that was declared last. `spacing = nothing` takes the lines
off, and that too is a retained state rather than an absence.

## The lines sit on the ellipsoid

The graticule stands at `altitude_m = 0` unless a call says otherwise: on the surface the imagery
is drawn on, so a coastline and the line over it stay together however close the camera comes. The
third stop of the tour shows that.

A session that turns [`declare_globe_depth`](@ref) on is the one that wants a lift. The viewer joins
two vertices with a straight chord, which sags a little inside the sphere between them, and a globe
that is depth-testing hides the sagging part. Such a session lifts the graticule by some tens of
kilometres. This one does not turn the depth test on, so it leaves the lines where they are.

## The globe hides the far half

Watch the second stop of the camera tour, over the pole. The meridians meet there, the parallels
close in, and every line stops at the horizon: the graticule keeps only the runs of each line on the
camera's own side of the Earth, and the labels the same way. That is the graticule's own doing. It
needs no [`declare_globe_depth`](@ref), which is why this program never calls it. See ADR-0037 in
`docs/decisions/` for why the occlusion belongs to the graticule.

## Full source

{{source}}
