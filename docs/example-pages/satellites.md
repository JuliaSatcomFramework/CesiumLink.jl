# 2 · Satellite trails

Sixty real low-orbit satellites, each one dragging a glowing trail along its orbit, over a globe lit
by the sun and under a star field. The camera opens on the whole sky and then rides one of them.

```sh
julia examples/Satellites/run.jl
```

Or start it from a session that already has CesiumLink — see [Run an example](@ref "Run an example"):

```julia
server = include(joinpath(pkgdir(CesiumLink), "examples", "Satellites", "run.jl"))
```

The scene below is a recording of that program, played in the browser.

```@raw html
<!-- The basemap tiles come from CARTO's CDN, which nothing here controls. A globe wearing Earth's
     bundled texture means that host is unreachable, not that the viewer is broken. -->
<iframe src="../viewer/player.html?rec=../recordings/satellites.jsonl&modules=modules"
        title="Sixty satellites dragging glowing trails over a lit globe, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

Watch one trail as it crosses the terminator. Then wait: at keyframe 12 the camera leaves the whole
sky and rides satellite 1 for the rest of the mission.

The mission is short on purpose — 30 keyframes, fifteen minutes of orbit. Every keyframe carries a
position for each of 60 satellites and for each of the nine vertices of its trail, so a mission long
enough to cover a whole orbit would be several megabytes on this page.

## The trail hangs off points nobody sees

The trail is the whole trick of this example, and it is three families:

```julia
Nodes(:sat; position = scene.position[:, :, frames], size = 6, color = SAT_COLOR),
Nodes(:track; position = reshape(scene.track[:, :, :, frames], 3, :, count), show = false),
Edges(:trail; from = :track, to = :track, pairs = scene.segments, style = :glow,
      width = 1.0, color = TRAIL_COLOR),
```

The `track` family carries `show = false`, so nothing draws it. It exists to hold the vertices the
`trail` lines are strung between. An edge draws from a masked endpoint, and a mask reads only its own
family, so the lines stand while the points under them stay invisible. See
[Draw points, lines and areas](../how-to/primitives.md).

The layout is what lets one `pairs` matrix stand for the whole window. Vertex `s + (j - 1) · S` is
satellite `s` at trail vertex `j`, in every keyframe, so a segment joining two consecutive vertices of
one satellite is written once and never rebuilt. The lines never change, so the `trail` family carries
no `show` and is never torn down.

## A vertex is an offset, not an instant

```julia
const TRACK_OFFSETS = (-TRAIL_SECONDS):DT_SECONDS:LEAD_SECONDS
```

Each vertex stands at a fixed offset **from the keyframe**, not at a fixed instant of the mission. So
the whole ladder slides along the orbit with the satellite rather than staying put while the satellite
leaves it. Nine vertices: six behind the satellite, the satellite, and two ahead of it.

It slides smoothly because a position is the one thing the viewer blends between keyframes. Every
other knob switches at the crossing. The vertex at offset zero rides the same blend as the marker, so
the head of the trail cannot drift off the satellite it belongs to.

The ladder is also what the window costs: one position per satellite per offset per keyframe. That is
why the window is eight keyframes and the offsets are one keyframe interval apart. A 30-second chord
of a low orbit stands about 1 km inside the arc it cuts, which is well under one pixel at any range
the whole globe is visible from.

## The globe is lit and the sky is drawn

```julia
start_server(; imagery = IMAGERY, lighting = true, stars = true)
```

`lighting` puts the sun where the clock says, so a terminator runs across the globe and the night side
goes dark. `stars` draws the sky around it. Both are off by default, and this is the scene they are
for: an orbit view, where the terminator is the picture rather than a shadow over the data. The
windows carry a real `start_time`, so the sun stands where the mission's own epoch puts it. See
[Choose what the globe is textured with](../how-to/basemap.md).

## The camera rides a satellite

```julia
declare_camera(server,
               Viewpoint(; lon = 0, lat = 20, height = 24_000_000, label = "The whole sky"),
               Viewpoint(; follow = "sat[$RIDE_SAT]", range = 500_000, pitch = -35,
                         at = RIDE_FRAME, duration = 5,
                         label = "Riding $(scene.names[RIDE_SAT])"))
```

Two stops. The first is a fixed viewpoint over the whole sky. The second names an entity, so the
camera flies to it at keyframe 12 and then stays with it: the marker holds still in the frame while
the ground and the other orbits sweep under it.

A drag while the camera rides steers around the satellite and keeps riding it. The track is declared
**after** the window that establishes the keyframe grid, because `at` counts in keyframes. See
[Give a recording a tour](../how-to/camera-tour.md).

## The elements are real

`leo-20200122.tle` holds 60 near-circular low orbits out of a CelesTrak catalogue snapshot, and SGP4
propagates each one. The mission runs at the snapshot's own epoch, not at today's date: SGP4 drifts by
kilometres a day away from the epoch its elements were fitted at. Point `TLE_FILE` at a fresh download
to fly today's sky.

The rotation into ECEF is TEME to PEF, and it reads no Earth orientation parameters. Reading them
needs the network, and what they correct — polar motion, and the difference between UT1 and UTC —
moves a satellite by a few metres, far under one pixel at this scale.

## What it does not do

The scene holds the whole mission in memory: fifteen minutes of 60 satellites is a small array, so
it is propagated once at construction. A mission long enough for that to matter propagates per
window instead, which is what [Constellation](constellation.md) does.

## Full source

{{source}}
