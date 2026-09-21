# 6 · The graticule

Meridians and parallels over a bare globe, and nothing else on it. A dropdown sets how far apart
they stand and a checkbox turns the labels on and off.

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

A recording runs no listener, so the two controls in the corner reach nobody here. The recording
carries the answers instead: the spacing closes in and the labels go off and come back, at the
moments the session made those calls. Run the program and the controls answer to you.

**This example draws no entity.** There is no satellite, no cell and no raster, because the
graticule is not one of the things a module draws. The Core draws it with no module loaded, over
whatever the modules put on the globe, and the only module this program registers is the one that
draws the two controls.

## No window at all

Every other example pushes at least one window. This one pushes none: the scene has no time in it,
and the graticule is a declaration rather than data of a frame. So the program says the two things
a timeless scene says — no time furniture, and nothing else:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

The globe, the basemap picker and the corner buttons are all there without a window. See
[Show a scene with no clock](../how-to/static-scene.md) for the scene that does hold one keyframe.

## Each call is the whole statement

[`declare_graticule`](@ref) takes the whole set of keywords every time. A keyword a call does not
name takes its default, not what an earlier call said:

```julia
declare_graticule(server; spacing, labels, color = LINE_COLOR, width = 1.5,
                  label_color = LABEL_COLOR, label_font = "13px system-ui")
```

So the function that answers a click repeats the colour and the width, and only `spacing` and
`labels` come from the control. The same function declares the overlay, with the dropdown and the
checkbox showing the values the graticule was just declared with. That is what keeps the widget and
the globe agreeing: both come out of one call, from one set of values.

`spacing = nothing` would take the lines off, and that is a retained state rather than an absence: a
browser connecting later gets a globe with the graticule declared off, not a globe nobody has said
anything to. This program never turns it off, because there would be nothing left to look at.

## The globe hides the far half

Watch the second stop of the camera tour, over the pole. The meridians meet there, the parallels
close in, and every line stops at the horizon: the graticule keeps only the runs of each line on the
camera's own side of the Earth, and the labels the same way. That is the graticule's own doing. It
needs no [`declare_globe_depth`](@ref), which is why this program never calls it. See ADR-0037 in
`docs/decisions/` for why the occlusion belongs to the graticule.

## A knob is one call

```julia
on_event(server, "ui", "control") do ev, _
    id, value = ev.payload.id, ev.payload.value
    if id == "spacing"
        state[] = declare_scene!(server; spacing = value, state[].labels)
    elseif id == "labels"
        state[] = declare_scene!(server; state[].spacing, labels = value)
    end
    return nothing
end
```

Both declarations are retained, so the listener contributes nothing to its reply and pushes no
window. It re-declares, and the viewer redraws. A browser that connects after a click comes back to
the spacing that was picked, because that is the declaration the server now holds.

## Full source

{{source}}
