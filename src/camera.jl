# The camera the Core drives, stated as one declared **camera track**: an ordered set of viewpoints,
# each saying where to look and when it applies (ADR-0018). The camera is user state, so a viewpoint
# is an offer — the viewer applies it while the server holds the camera, and ignores it once the user
# takes the camera on the canvas (ADR-0017).
#
# `core/camera` is a Core topic, like `core/furniture` and `core/regions` beside it, so this file is
# flat in `CesiumLink` rather than a payload vocabulary in a submodule.

const CORE_CAMERA = ("core", "camera")

# A viewpoint carries only what its author states. A field left out keeps whatever Cesium chooses,
# and a substituted default levels a camera that asked to keep its tilt.
stated(nt::NamedTuple) = (; (k => v for (k, v) in pairs(nt) if v !== nothing)...)

# What to ride, lowered for the wire: a module to ask, and a name that module spells for itself. The
# viewer hands the name straight to that module's own resolver and reads nothing out of it, so no
# module's vocabulary reaches the Core (ADR-0006).
#
# `module` is a Julia keyword, so the pair is built by name rather than written as `(; module = …)`.
anchor(target::AbstractString) = NamedTuple{(:module, :target)}(("primitives", target))
anchor(p::Pair{<:AbstractString,<:AbstractString}) = NamedTuple{(:module, :target)}((first(p), last(p)))
anchor(x) =
    throw(ArgumentError("what to ride is named as the module drawing it spells it: a string for " *
                        "the `primitives` module, or `\"othermodule\" => \"target\"` for another " *
                        "(got $(repr(x)))"))

"""
    Viewpoint(; lon, lat, height=0, heading, pitch, roll, duration, at, after, take, label)
    Viewpoint(; west, south, east, north, duration, at, after, take, label)
    Viewpoint(; follow, range, heading, pitch, duration, at, after, take, label)

One entry of a **camera track**: where the camera stands, and when it goes there.

The destination is a point on the globe (`lon`, `lat`, `height`), a rectangle to frame (`west`,
`south`, `east`, `north`), or a moving thing to ride (`follow`). Angles are degrees and `height` is
metres. Exactly one of the three: a call that gives two of them, or none, throws.

`heading`, `pitch` and `roll` are degrees as well. Each one left out keeps the angle Cesium would
choose.

`duration` is the flight time in seconds. `0` is a hard cut. Leave it out for Cesium's own
distance-based flight time.

# Riding a moving thing

`follow` names what to ride, spelled the way the module that draws it spells it. The viewer hands
the name to that module and reads nothing out of it. A bare string names something the `primitives`
module draws, which is what a scene built out of `Nodes`, `Edges` and `Areas` wants. Write
`"othermodule" => "target"` to ride what another module draws.

`primitives` spells a name as one kind and one index, counted from 1: `"sat[7]"`. That is the index
a pointer event reports, so a listener answers a click with `"sat[\$(ev.entity.idx)]"` and converts
nothing in between. Every kind it draws answers, so a camera rides the midpoint of a link as readily
as a satellite.

`range` is metres from the thing being ridden, and it takes `follow`. `heading` and `pitch` keep
their names and change frame: with `follow` they are angles around the thing being ridden, not
angles over the globe. `roll` has nothing to mean around a moving thing, so it throws.

The camera flies into that seat over `duration` seconds and starts riding when it lands. A viewpoint
that states no `range` and no angle mounts the camera where it already stands, and `duration` then
has nowhere to fly to.

```julia
Viewpoint(; follow = "sat[7]", range = 400_000, pitch = -30, at = 60, label = "Riding sat 7")
```

Three schedules say when the viewpoint applies. They are mutually exclusive, and a call that gives
two of them throws:

| Field | The viewer applies it |
|---|---|
| `at` | when the clock crosses that keyframe. A 1-based absolute keyframe index |
| `after` | that many seconds after the track is declared. Absolute per entry, not cumulative |
| neither | on arrival |

Use `at` for a tour of a scene that moves. Use `after` for a scene of one keyframe, which has no
keyframe axis to schedule against.

`take` takes the camera back from the user before this viewpoint applies. Without it, a viewpoint
that arrives after the user drags the globe is ignored.

`label` is what the **stop list** calls this stop — the viewer shows the track beside the scene, one
row per stop. Give a short name that says where the camera goes. A stop with no label falls back to
its schedule: `on arrival`, `after 8 s`, or the keyframe index as the wire carries it, which is one
below the `at` you write here.

```julia
Viewpoint(; lon = 12.5, lat = 41.9, height = 2_000_000, at = 1, duration = 0, label = "Rome")
Viewpoint(; west = -10, south = 35, east = 30, north = 60, after = 8)
```

See also [`declare_camera`](@ref).
"""
struct Viewpoint
    # The wire form, already lowered: this type is a call-site check, and holding the payload keeps
    # one shape to read in a test and in a recording.
    wire::NamedTuple
end

function Viewpoint(; lon = nothing, lat = nothing, height = 0,
                   west = nothing, south = nothing, east = nothing, north = nothing,
                   follow = nothing, range = nothing,
                   heading = nothing, pitch = nothing, roll = nothing,
                   duration = nothing, at = nothing, after = nothing, take = nothing,
                   label = nothing)
    names_point = !isnothing(lon) || !isnothing(lat)
    names_rect = any(!isnothing, (west, south, east, north))
    names_ride = !isnothing(follow)
    count((names_point, names_rect, names_ride)) == 1 ||
        throw(ArgumentError("a viewpoint takes one destination: either `lon` and `lat`, or " *
                            "`west`, `south`, `east` and `north`, in degrees, or `follow` to " *
                            "ride a moving thing"))
    isnothing(range) || names_ride ||
        throw(ArgumentError("`range` is metres from the thing a viewpoint rides, so it takes " *
                            "`follow` as well"))
    wire = if names_ride
        isnothing(roll) ||
            throw(ArgumentError("`roll` has nothing to mean around a moving thing, so a viewpoint " *
                                "that carries `follow` states its seat as `heading`, `pitch` and " *
                                "`range`"))
        (; follow = anchor(follow))
    elseif names_point
        (isnothing(lon) || isnothing(lat)) &&
            throw(ArgumentError("a point destination takes both `lon` and `lat`"))
        (; destination = (; lon, lat, height))
    else
        any(isnothing, (west, south, east, north)) &&
            throw(ArgumentError("a rectangle destination takes all of `west`, `south`, `east` " *
                                "and `north`"))
        (; destination = (; west, south, east, north))
    end

    isnothing(at) || isnothing(after) ||
        throw(ArgumentError("a viewpoint carries `at` or `after`, not both: `at` is a keyframe " *
                            "index and `after` is wall-clock seconds from the declaration"))
    # The viewer drops a fractional `at` with a console warning, which is a browser nobody watches.
    isnothing(at) || (at isa Integer && at ≥ 1) ||
        throw(ArgumentError("`at` is a 1-based absolute keyframe index, so it takes an integer " *
                            "≥ 1 (got $(repr(at)))"))
    isnothing(after) || (after isa Real && after ≥ 0) ||
        throw(ArgumentError("`after` is seconds from the declaration, so it takes a number ≥ 0 " *
                            "(got $(repr(after)))"))
    # The viewer drops a label it cannot read and keeps the viewpoint, which is a console warning
    # nobody watches. Say it here instead.
    isnothing(label) || label isa AbstractString ||
        throw(ArgumentError("`label` is what the stop list calls this stop, so it takes a string " *
                            "(got $(repr(label)))"))

    # The seat sits beside the ride and not inside it: the viewer reads `range` and `orientation` off
    # the viewpoint, and `follow` carries only what to ride.
    isnothing(range) || (wire = (; wire..., range))
    orientation = stated((; heading, pitch, roll))
    isempty(orientation) || (wire = (; wire..., orientation))
    # A keyframe index crosses the wire 0-based, like every other index (`to_wire_index`).
    return Viewpoint((; wire...,
                      stated((; duration, at = isnothing(at) ? nothing : to_wire_index(at),
                              after, take, label))...))
end

"""
    declare_camera(server::Server, viewpoints::Viewpoint...) -> Int

Declare the **camera track** the viewer flies, as the **whole** set. Returns the number of clients
reached.

Each call is a full statement, not an addition: the track this call names replaces the one before
it, and `declare_camera(server)` clears the track. The declaration is retained, so a browser that
connects later comes back to the same tour, and a recording replays it with no listener behind it.

```julia
declare_camera(server,
               Viewpoint(; lon = 12.5, lat = 41.9, height = 8_000_000, label = "Europe"),
               Viewpoint(; lon = 12.5, lat = 41.9, height = 500_000, at = 60, duration = 6,
                         label = "Rome"))
```

The viewer shows the whole track beside the scene as a **stop list**, one row per viewpoint, and it
marks the row that applies now. Label the stops and the list says what the tour is.

The viewer applies the latest viewpoint whose moment passed. So pausing the clock holds the camera,
and scrubbing back returns it to the viewpoint that keyframe was authored with.

The user takes the camera with a drag or a wheel on the globe, and keeps it: a viewpoint that
arrives afterwards is ignored until the user rejoins, or until one arrives that carries `take`. A
drag on a camera that rides something detaches, and does not dismount — the tour stops advancing and
the camera keeps riding, so the user now steers around the thing. The `home` button gets off, and so
does any later stop that flies somewhere else.

Re-declare the track after any window that changes the keyframe grid — a new epoch or a new
`dt_seconds`. Every `at` counts on that grid, so the viewer drops a track the grid moved under.

See also [`Viewpoint`](@ref).
"""
declare_camera(server::Server, viewpoints::Viewpoint...) =
    # The element type is named: an empty comprehension gives a `Vector{Union{}}`, and `Union{}` is
    # a subtype of `Number`, so the codec takes the empty track for an array of data and refuses it.
    send_command(server, CORE_CAMERA..., (; track = NamedTuple[v.wire for v in viewpoints]))

"""
    declare_follow(server::Server, target; range, heading, pitch, duration) -> Int
    declare_follow(server::Server) -> Int

Put the camera on a moving thing, or take it off. Returns the number of clients it was queued for.

`target` names what to ride, and `range`, `heading` and `pitch` say how to sit on it, exactly as
[`Viewpoint`](@ref) states them. The camera flies into that seat over `duration` seconds. A call
that states no seat mounts the camera where it stands, and `duration` then has nowhere to fly to.

This call states the frame and leaves the declared camera track alone, so one scene runs a tour
**and** answers a click with a ride, and neither wipes the other. A drag detaches without
dismounting: the user steers around the thing and carries on riding it.

`declare_follow(server)` gets off, and so does the button the camera panel offers while a ride runs.
Both leave the camera looking straight down on the ground the thing was above, from the height it
had when it got on. The `home` button gets off as well, to its own view, and so does any stop that
flies somewhere else.

A ride is **not** replayed to a client that connects later, and a declared track is. A ride is about
one viewer's camera, so a browser arriving afterwards does not inherit it. State a ride that every
viewer is meant to take as a [`Viewpoint`](@ref) in the track instead.

The name is what a click reports, so a listener hands an entity straight back:

```julia
on_pointer(server; type = :click) do ev, reply
    ev.entity === nothing && return nothing
    declare_follow(server, "\$(ev.entity.kind)[\$(ev.entity.idx)]"; range = 400_000, pitch = -30)
end
```

That is safe from inside a listener that also pushes a `:replace` window: this travels as its own
command and not in the listener's reply batch, which such a push voids (see [`push_window`](@ref)).

See also [`Viewpoint`](@ref), [`declare_camera`](@ref).
"""
function declare_follow(server::Server, target = nothing; range = nothing, heading = nothing,
                        pitch = nothing, duration = nothing)
    follow = if isnothing(target)
        all(isnothing, (range, heading, pitch, duration)) ||
            throw(ArgumentError("`declare_follow(server)` gets the camera off the ride, so it " *
                                "takes nothing else. State a seat with what to ride."))
        # An explicit null, and not an absent field: the viewer reads the key's presence as the
        # statement, so a dropped key would leave the camera riding whatever it rides.
        nothing
    else
        f = (; anchor(target)..., stated((; range, duration))...)
        seat = stated((; heading, pitch))
        isempty(seat) ? f : (; f..., orientation = seat)
    end
    # Broadcast, and deliberately not retained. The server retains one command per topic, so
    # retaining a ride would drop the camera track a client connecting later is replayed — the very
    # track this call exists to leave alone. A ride is about the camera, which is user state, and
    # replaying one seats a stranger on something somebody else clicked. A ride a scene means every
    # viewer to take is a stop in the track, and `declare_camera` retains that.
    return broadcast_all!(server, commands_message([Command(CORE_CAMERA..., (; follow))]))
end
