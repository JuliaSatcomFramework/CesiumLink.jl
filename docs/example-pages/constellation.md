# 2 · Constellation

Forty satellites over Europe and North Africa, with the ground cells they serve, the gateways they
feed through, and the links between them — three hundred keyframes of thirty seconds each, delivered
sixty at a time.

```sh
julia --project=docs -e 'using Constellation; Constellation.run_example()'
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/constellation.jsonl&modules=modules"
        title="A constellation over Europe and North Africa, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

Play it and watch one cell. Its link swings from satellite to satellite, and goes out entirely when
nothing stands high enough over it.

## The scene is a type, and `serve_scene!` installs it

This example is a package, not a script. It declares a type for its scene and adds the one method of
[`serve_scene!`](@ref) that installs it:

```julia
function CesiumLink.serve_scene!(server, scene::ConstellationScene)
```

CesiumLink declares that verb and defines no method for it. It cannot: a scene is satellites here
and something else in the next program, so only the package that holds the data knows how to build
one. What CesiumLink owns is the shape of the call — take a server, build the scene, register the
listeners, push the opening window — and the guarantee that follows from it.

That guarantee is the last line of the method:

```julia
install_scene!(server, scene, listeners)
```

[`install_scene!`](@ref) records this scene as the one the server drives, and takes down whatever
scene was installed before it. Edit the example, re-run it against the same server, and the second
scene *replaces* the first — its three listeners answer, and the first scene's three are
unregistered. Without that call both scenes would stand, and every event would get two answers.

`ConstellationScene` holds no keyframe. It holds one propagator per satellite, the ground cells and
the gateways, and the mesh between the satellites — everything that does not depend on time. The
keyframes come out of one function of a range:

```julia
window_families(scene, first_frame, count)
```

## Six families, one window at a time

The scene draws six families, and every window carries all six:

| Family | Kind | What it is |
|---|---|---|
| `sat` | [`Nodes`](@ref) | the satellites, moving over the whole window |
| `gateway` | [`Nodes`](@ref) | five ground stations, standing still and labelled |
| `cell` | [`Areas`](@ref) | the ground cells, recoloured at every keyframe |
| `user` | [`Edges`](@ref) | one link per served cell, to the satellite serving it |
| `feeder` | [`Edges`](@ref) | one link per satellite that sees a gateway |
| `isl` | [`Edges`](@ref) | the mesh between the satellites |

One window is what keeps them agreeing. An [`Edges`](@ref) family joins two other families **by
index**, so `user` pair `(7, 12)` means cell 7 and satellite 12 — and cell 7 is the seventh column of
whatever `cell` sent on this window. Send the cells on one window and the links on another and the
indices address two different scenes.

The cells are a Fibonacci lattice over the sphere, kept where it falls inside the box. A footprint is
computed from a centre and a radius rather than given vertex by vertex:

```julia
Areas(:cell; center = scene.cells, radius = CELL_RADIUS_M, sides = 6, height_m = 2000,
      color = reshape(rgba(CMAP, served; range = (MASK_DEG, 90.0)), 4, ncell, count))
```

`served` holds the elevation of the satellite serving each cell, or `NaN` where none does. A `NaN`
colour draws nothing, so an unserved cell leaves the globe instead of sitting there in a colour it
has not earned. The colour array is `4 × cells × keyframes`: the geometry is sent once and the
colours switch at every keyframe crossing.

## The links come and go

Nothing else in this documentation shows a relationship the server derives per keyframe. This is
what makes the scene read as a simulation rather than as an animation.

A cell is served when some satellite stands more than ten degrees above its horizon, and it is served
by the highest of them. That is a geometry question with a different answer at every keyframe: a link
appears, swings to another satellite, and goes out. So `user` and `feeder` carry **one index matrix
per keyframe**, and the count of edges changes from one to the next:

```julia
Edges(:user; from = :cell, to = :sat, pairs = user, width = 1.0, color = USER_COLOR)
```

`pairs` here is a vector of `2 × M` matrices, one per keyframe, each sized to that keyframe's own
links. The `isl` family is the contrast: its mesh is the same at every keyframe, so it travels as one
matrix. That difference is not only tidiness — a family whose `pairs` change is torn down and rebuilt
at every crossing, while a standing family is only written to. Give a changing family the ragged
form, and give a standing one a single matrix.

Every link family takes one colour for the whole family. An edge's colour is its batch key, so three
families in three colours cost three draw commands, while a colour ramp over a thousand links would
cost a thousand. See [Draw points, lines and areas](../how-to/primitives.md).

## The mission is declared whole and delivered in chunks

The mission is three hundred keyframes. The first window carries sixty of them:

```julia
push_window(server, ...; start_frame = 1, count = 60, total_frames = 300, mode = :replace)
```

`total_frames` is the mission and `count` is the buffer. The ruler spans the mission from the first
frame on, and scrubbing works anywhere inside the buffer. A real mission is far longer than this one
— five keyframes' worth of buffer against a hundred is the same call with bigger numbers.

The rest arrives because the viewer asks for it. As playback nears the end of the buffer the Core
raises `core/need`, and the scene answers:

```julia
on_event(server, "core", "need") do ev, _
    push_frames!(server, scene, ev.start_frame, max(ev.count, CHUNK_FRAMES), ev.mode)
end
```

A scene with no `core/need` listener cannot produce a window on demand. This one rounds the count up
to a whole chunk, so the buffer runs ahead of the clock instead of growing two keyframes at a time.
The whole mechanism, without a constellation around it, is
[Deliver a long mission a piece at a time](../how-to/lazy-delivery.md).

!!! warning "An append preserves the index space"
    Satellite `i` must still be satellite `i` after the buffer grows. The reader asked for nothing,
    and a window that orders the entities differently teleports them at the seam. An append that
    leaves a gap is not an append either: there is nothing to interpolate across a gap, so the viewer
    clears the buffer and refills it.

The recorded scene above pulls too. The player holds the whole recording and answers `core/need` out
of it, so the frames a viewer asks for arrive the same way — from a file rather than from Julia.

## The toggle, and the tooltip

Two listeners answer the reader. The overlay declares one [`Toggle`](@ref):

```julia
Toggle(:isl, "Inter-satellite links", scene.show_isl[])
```

The widget shows the value the **server** declared, so the answer states the overlay again with the
value it applied. A control the server refuses snaps back, which is how a scene says no.

Answering it re-extracts the window. The propagation stands and only the family list changes, so the
replacement is one call over the frames already delivered:

```julia
push_frames!(server, scene, 1, delivered(scene), :replace)
```

This one is a `:replace`, not an append. The reader asked for a different scene, so a window that
renumbers the entities is exactly right — five families instead of six, and the clock keeps running
where it was.

The tooltip is a hover listener that names the satellite under the cursor and gives its altitude:

```julia
on_pointer(server; type = :hover) do ev, reply
```

It derives nothing. The altitude of every satellite at every delivered keyframe was already computed
for the window that carries it, and the listener reads it out of there. The chain assembles one batch
after every listener returns, so a slow listener delays every other answer to the same event. Two
rules hold it up: `ev.entity.idx` is already 1-based, and every index is bounded before it is used —
a hover listener that throws loses the whole batch, and nothing on screen reports it. See
[Show a value on hover](../how-to/tooltips.md).

Neither works in the recording above. Replaying one runs no listener, so the toggle and the tooltip
need the live program — the command at the top of this page.

## The geometry, and what it leaves out

The links are geometry and nothing more. There is no routing solve here, no forward or return path,
and no capacity: a link exists when the elevation angle holds, a feeder goes to the nearest gateway
that can see the satellite, and the mesh joins neighbours in a plane and across planes.

The satellites are propagated with `SatelliteToolboxPropagators` and rotated into ECEF with
`SatelliteToolboxTransformations`. The rotation is TEME to PEF, which runs with no Earth orientation
parameters: `fetch_iers_eop` reads them off the network, and a documentation build that reaches the
network fails on someone else's bad day. What it drops moves a satellite by a few metres, far under
one pixel here.

The ground coordinates go through CesiumLink's own [`ecef`](@ref), against the ellipsoid the session
declares. No geodesy package is needed for that — see
[Work in map coordinates](../how-to/coordinates.md).

## Full source

{{source}}
