# Give a recording a tour

A scene plays and the camera stays where it is. Declare a **camera track** to add a tour. A track is
one retained command, so a recorded page flies the tour with no Julia process behind it.

A track is an ordered set of [`Viewpoint`](@ref)s. [`declare_camera`](@ref) states the whole set:

```julia
declare_camera(server,
               Viewpoint(; lon = 12.5, lat = 41.9, height = 12_000_000),
               Viewpoint(; lon = 12.5, lat = 41.9, height = 2_000_000, at = 60, duration = 6),
               Viewpoint(; west = -10, south = 35, east = 30, north = 60, at = 240, duration = 8))
```

A destination is a point on the globe or a rectangle to frame. Angles are degrees, `height` is
metres, and `duration` is the flight time in seconds. `0` is a hard cut. With no `duration`, Cesium
picks one from the distance.

An `at` index counts on the keyframe grid the windows establish. A track declared before the first
window takes that window's grid, so a seeding viewpoint can arrive before the scene.

## Key a moving scene by keyframe

`at` is an absolute keyframe index, counted from 1. The viewer applies the viewpoint when the clock
**crosses** that keyframe:

```julia
declare_camera(server,
               Viewpoint(; lon = 0, lat = 0, height = 20_000_000),          # the opening view
               Viewpoint(; lon = 116, lat = 40, height = 3_000_000, at = 120, duration = 5),
               Viewpoint(; lon = -74, lat = 41, height = 3_000_000, at = 400, duration = 5))
```

The viewer applies the latest viewpoint whose keyframe passed, and repeats that test on every
crossing:

- Pause the clock, and the camera holds where the tour left it.
- Scrub back, and the camera returns to the viewpoint that keyframe was authored with.
- Change speed, and the tour changes speed with the scene.

Only each viewpoint's own `at` schedules it. The order of the arguments has no effect.

!!! warning "Re-declare the track after a re-grid"
    Keyframe 120 means `start_time + 120 × dt_seconds`. A window that changes either value moves
    every keyframe an `at` names, so the viewer drops the track and warns. Declare the new track
    **after** the window that establishes the new grid. A `replace` of the same grid keeps the
    track, and so does a mission that grows longer.

## Pace a scene of one keyframe by the clock on the wall

A scene of one keyframe has no keyframe axis to key on, and its time furniture is down, so it has no
scene clock. Use `after`, which counts seconds from the moment the track arrives:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
declare_camera(server,
               Viewpoint(; west = -180, south = -60, east = 180, north = 75),
               Viewpoint(; lon = 8, lat = 47, height = 4_000_000, after = 5, duration = 4),
               Viewpoint(; lon = 78, lat = 22, height = 4_000_000, after = 14, duration = 4))
```

Each `after` counts from the declaration, not from the viewpoint before it, so a slow flight does
not push the rest of the tour later.

One viewpoint carries `at` **or** `after`, never both. A call that gives both throws.

!!! tip "The reader can replay a wall-paced tour from any stop"
    A wall-paced tour starts when the track arrives and ends after the last stop. A reader who
    arrives late clicks a row in the stop list to run the rest of the tour from there, or the first
    row to run all of it again.

## Name the stops

The camera-follow indicator opens into a **stop list**: one row per viewpoint, in declared order,
with the row that applies now marked. A row paced by wall seconds also shows the time left. The
indicator is closed when the page opens; click its head line to open it. Give each viewpoint a
`label`:

```julia
declare_camera(server,
               Viewpoint(; west = -180, south = -60, east = 180, north = 75,
                         label = "The daylit face"),
               Viewpoint(; lon = 8, lat = 47, height = 4_000_000, after = 5, duration = 4,
                         label = "Europe, at noon"),
               Viewpoint(; lon = 78, lat = 22, height = 4_000_000, after = 14, duration = 4,
                         label = "India, at sunset"))
```

Keep a label short. The panel has a maximum height, it scrolls, and it keeps the applied row in
view.

A stop with no label shows its schedule instead: `on arrival`, `after 5 s`, or `at keyframe N`. That
`N` is the index the wire carries, which is one below the index you wrote.

Label a wall-paced tour. `after` counts from a declaration the reader never sees, and a timeless
scene has no clock that shows the schedule.

Every row is a click target:

- A click on a stop keyed `at` a keyframe moves the clock there, and the scene goes with it.
- A click on a stop paced `after` wall seconds re-arms the stops after it.

A click takes the camera back as **Rejoin** does, so a row works while the reader holds the globe.
It uses the fixed rejoin flight, not the viewpoint's own `duration`.

## Ride a moving thing

Give a stop `follow` in place of a destination. The camera then holds station on the thing:

```julia
declare_camera(server,
               Viewpoint(; lon = 0, lat = 20, height = 20_000_000, label = "The whole sky"),
               Viewpoint(; follow = "sat[7]", range = 400_000, pitch = -30, at = 40, duration = 4,
                         label = "Riding sat 7"))
```

`follow` names what to ride, spelled the way the module that draws it spells it. For
[`primitives`](primitives.md) that is one kind and one index, written `sat[7]`. **The index counts
from 1.**

`range` is metres from the thing. `heading` and `pitch` are angles around the thing, not compass
angles on the globe. A stop that states no seat keeps the camera where it already stands.

Set `duration` to any value: the camera rides from the instant the stop applies, then eases onto its
seat inside that frame.

A ride ends when a later stop flies somewhere else, when the reader presses home, or when the reader
gets off. A drag does not end it. See below.

!!! tip "A recording carries a ridden tour"
    A camera track is retained and the recording holds the module that answers for `sat[7]`, so a
    recorded scene rides the satellite with no Julia process behind it.

## Answer a click with a ride

[`declare_follow`](@ref) rides what the reader clicked. A pointer event carries the name a ride
takes, so a listener hands the entity straight back:

```julia
on_pointer(server; type = :click) do ev, reply
    if ev.entity === nothing
        declare_follow(server)                     # a click on empty space gets off
    else
        declare_follow(server, "$(ev.entity.kind)[$(ev.entity.idx)]";
                       range = 400_000, pitch = -30, duration = 3)
    end
    return nothing
end
```

No ride starts unless a scene writes this.

Three things get off: `declare_follow(server)`, the home button, and the **Get off** button the
camera-follow indicator shows while a ride runs. All three leave the camera above the ground the
thing was over, at the height it had when it got on, and looking straight down.

This call states the frame and leaves the declared track alone, so one scene runs a tour **and**
answers a click.

!!! warning "A ride from a listener is not replayed, and a ride in a track is"
    `declare_follow` broadcasts to the clients connected now. A browser that connects later does not
    inherit it, because a ride belongs to one reader's camera. Declare a ride that **every** reader
    must take as a `Viewpoint` in the track.

## What each schedule costs in a recording

A replayed recording runs two clocks. The player delivers the recorded frames on a wall-clock timer.
The scene animates on the viewer's own clock, which the reader can pause and scrub.

| | `at` | `after` |
|---|---|---|
| Pause the scene | the tour holds | the tour goes on without it |
| Scrub back | the camera goes back with the scene | nothing changes |
| `speed = 2` in the player | the tour runs twice as fast | the tour keeps its authored pace |

Key by keyframe wherever the scene has keyframes. `speed` scales frame delivery and the scene clock
together, so it carries a keyframed track along and leaves a wall-paced one alone.

## Let the reader take the globe, and give it back

A drag or a wheel on the globe takes the camera, and the viewer then ignores every viewpoint that
arrives. Nothing else takes it: a key press over the globe belongs to the module that bound it, and
the home button flies home and leaves the server driving.

A drag on a camera that rides **detaches, and does not dismount**. The tour stops advancing, as it
does on any drag, and the frame stays.

The **camera-follow indicator** gives the camera back. It is furniture, it is on by default, and it
appears once a viewpoint arrives:

```julia
declare_furniture(server; camera_follow = false)   # a page that wants an unadorned globe
```

The declaration governs the indicator only. A session that declares it off still ignores viewpoints
after the reader takes the camera, and says nothing about it.

To pull the camera back from Julia, put `take = true` on a viewpoint:

```julia
Viewpoint(; lon = 12.5, lat = 41.9, height = 2_000_000, at = 600, take = true)
```

Use it where the scene reaches something the reader must see. A viewpoint that carries `take`
overrides a reader who looks somewhere else on purpose.

## Nothing comes back up

There is no camera event. The viewer never reports where the reader looked, so a recording carries
the camera only as the commands the server broadcast. A track is one of those, and it is retained.

## Next

- [The camera](../reference/camera.md) — the full surface of both calls.
- [Record and replay a session](record-replay.md) — writing the session out, and playing it in a
  page.
- [`core/camera`](../reference/wire/protocol.md) — what a track looks like on the wire.
