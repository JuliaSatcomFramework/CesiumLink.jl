#!/usr/bin/env julia
# The tracks tracer scene: three satellites on circular orbits, five ground stations, and the
# visibility links between them, streamed to the viewer as windows and drawn by the vendored
# `primitives` module — no JavaScript is authored for it.
#
#   julia --project=. tools/tracks/serve.jl [port]
#
# Open http://localhost:<port>/?ws=auto. The opening window is two keyframes; the viewer asks for
# what it needs next as playback nears the edge of its buffer, and each answer is an `:append` that
# preserves the index space, so motion stays continuous across the seam.

using CesiumLink
using JSON

const ROOT = normpath(joinpath(@__DIR__, "..", ".."))

const NSAT = 3
const NFRAME = 240
const DT = 60.0                                    # mission seconds per keyframe
const EPOCH = "2026-07-26T10:00:00Z"
const RSAT = 7.0e6
const PERIOD = 90 * 60.0

const STATIONS = [(12.5, 41.9), (4.4, 52.0), (20.2, 67.9), (5.1, 50.0), (-4.4, 40.5)]
const NAMES = ["Rome", "Delft", "Kiruna", "Redu", "Cebreros"]
const NUSER = length(STATIONS)

# One colormap value colours the stations and labels the legend, so the bar cannot drift from what
# is on screen.
const CMAP = ["#30123b", "#28bceb", "#a2fc3c", "#fabb39", "#7a0403"]

# The viewer draws the globe on WGS84, so the stations are placed on it. A sphere at geocentric
# latitude puts them up to ~21 km from the city they are named after.
const USER_ECEF = Float32.(ecef(first.(STATIONS), last.(STATIONS)))

# Satellite `i` at mission time `t`: a circular orbit inclined 53°, one plane per satellite.
function orbit(i::Integer, t::Real)
    θ = 2π * t / PERIOD + 2π * (i - 1) / NSAT
    inc = deg2rad(53.0)
    raan = 2π * (i - 1) / NSAT
    x, y, z = RSAT * cos(θ), RSAT * sin(θ) * cos(inc), RSAT * sin(θ) * sin(inc)
    return (x * cos(raan) - y * sin(raan), x * sin(raan) + y * cos(raan), z)
end

# Crude horizon test: the satellite is above the station's local horizontal plane.
visible(sat, user) = sum(user .* (sat .- user)) > 0

# Whether the visibility links are drawn. The overlay's toggle sets it, and the scene changes only
# because Julia pushes a replacement window — nothing in the browser knows what the toggle means.
const SHOW_LINKS = Ref(true)

# How many satellites each station sees at keyframe `k` of a window's positions.
in_view(pos, k) = [sum(s -> visible(pos[:, s, k], USER_ECEF[:, u]), 1:NSAT) for u in 1:NUSER]

"""
    orbit_track(first, count) -> Array{Float32,3}

Where the satellites are over `count` keyframes starting at the 1-based absolute keyframe `first`,
as `3 × NSAT × count` — the trailing axis is the keyframe, which is how every array in a payload
carries one.
"""
function orbit_track(first::Integer, count::Integer)
    pos = Array{Float32}(undef, 3, NSAT, count)
    for k in 1:count, i in 1:NSAT
        pos[:, i, k] .= orbit(i, (first + k - 2) * DT)
    end
    return pos
end

"""
    window_payload(first, count)

The `primitives` payload for `count` keyframes starting at the 1-based absolute keyframe `first`:
satellites on an interpolated track, the stations standing still and coloured by how many satellites
they see, and the visibility links between them, whose membership changes at every crossing.
"""
function window_payload(first::Integer, count::Integer)
    pos = orbit_track(first, count)
    pairs = map(1:count) do k
        SHOW_LINKS[] || return zeros(Int, 2, 0)
        links = [[u, s] for u in 1:NUSER for s in 1:NSAT if visible(pos[:, s, k], USER_ECEF[:, u])]
        reduce(hcat, links; init = zeros(Int, 2, 0))
    end
    color = Array{UInt8}(undef, 4, NUSER, count)
    for k in 1:count
        color[:, :, k] = rgba(CMAP, in_view(pos, k); range = (0, NSAT))
    end
    return primitives_payload(
        Nodes(:sat; position = pos, size = 12, color = (60, 190, 255, 255),
              scale_by_distance = (1.5e6, 1.0, 3.0e7, 0.35)),
        Nodes(:user; position = USER_ECEF, size = 9, color, label = NAMES),
        Edges(:link; from = :user, to = :sat, pairs, width = 1.5, color = "#ffffffb3"),
    )
end

# The floats standing, by id. Clicking an entity puts one here and clicking it again takes it out;
# nothing about them lives anywhere else, because a float is only a declaration.
const PINNED = Dict{String,Floating}()

# What a pinned entity's box says at keyframe `k`.
pin_html(kind, idx, k) = "<b>Pinned $kind $idx</b><br>at keyframe $k"

"""
    pin(kind, idx) -> Floating

A box anchored to entity `idx` of family `kind`, which it then follows across the globe. Its content
is keyframed, so the box is handed one fragment per keyframe of the window and reads the clock
locally — no event, and no round trip per crossing.
"""
pin(kind, idx) =
    Floating("$kind-$idx"; anchor = Entity("primitives", kind, idx),
             html = pin_html(kind, idx, "—"))

"""
    ui_payload(first, count)

The `ui` payload for the same keyframes: one content fragment per keyframe for every float standing,
addressed by the float's id. A window with nothing pinned carries an empty set of entries.
"""
ui_payload(first::Integer, count::Integer) =
    (; per_keyframe = Dict(id => (; html = [pin_html(f.anchor.kind, f.anchor.idx, k)
                                            for k in first:(first + count - 1)])
                           for (id, f) in PINNED))

# The whole floating set, as one declaration: one box per pinned entity.
declare_floats(server) = declare_floating(server, collect(values(PINNED)))

"""
    overlay_items() -> Vector{AbstractControl}

The whole overlay, as one ordered list: the keyframe caption, and one box holding the legend of the
colormap the stations are coloured through beside the toggle the link visibility is filtered by. The
toggle carries the value the scene is actually filtered with, so re-declaring after a control event
leaves the widget showing the server's state.
"""
overlay_items() = [
    Title(Dict(k => "Keyframe $k of $NFRAME" for k in 1:NFRAME); region = :top_center),
    # A group is one contribution to its region: its children sit inside its box rather than each
    # wearing one of their own, and `flex-direction` is the whole of laying them out side by side.
    Group([Legend("Satellites in view", 0, NSAT, CMAP),
           Toggle(:links, "Visibility links", SHOW_LINKS[])];
          region = :top_right, style = (; flex_direction = "row", align_items = "center")),
]

"""
    serve_tracks(; port=50006, dist_dir=joinpath(ROOT, "lib", "dist")) -> Server

Start a server for the tracer scene and push its opening window. Keeps the buffer fed by answering
requests for keyframes with the kind of window each one asks for.
"""
function serve_tracks(; port = 50006, dist_dir = joinpath(ROOT, "lib", "dist"))
    server = start_server(; dist_dir, host = "::", port)
    register_module!(server, vendored(:primitives; dist_dir))
    # Last: registration order is draw order, so the overlay and its floats stack over the scene.
    register_module!(server, vendored(:ui; dist_dir))

    # The frames asked for, as the kind of window asked for: an advance extends the buffer, and a
    # landing — what a client joining mid-run is answered with — stands on its own.
    on_event(server, "core", "need") do ev, reply
        push_window(server, Dict(:primitives => window_payload(ev.start_frame, ev.count),
                                 :ui => ui_payload(ev.start_frame, ev.count));
                    start_frame = ev.start_frame, count = ev.count, dt_seconds = DT,
                    total_frames = NFRAME, start_time = EPOCH, mode = ev.mode)
    end

    declare_overlay(server, overlay_items())
    declare_floats(server)

    # Hovering an entity is answered with a tooltip fragment. One formatter, 1-based, in the language
    # that owns the data.
    on_pointer(server; type = :hover) do ev, reply
        # Off an entity: null content, which is how the box is hidden.
        ev.entity === nothing &&
            return command!(reply, "ui", "tooltip", (; html = nothing))
        tooltip!(reply) do io
            k, i = ev.entity.kind, ev.entity.idx
            if k == "sat"
                print(io, "<b>Satellite $i</b><br>keyframe ", ev.frame)
            elseif k == "user"
                print(io, "<b>", NAMES[i], "</b><br>ground station")
            else
                print(io, "<b>Link</b><br>visible this keyframe")
            end
        end
    end

    # Clicking an entity is answered in Julia, and the answer reaches the screen as a float anchored
    # to the entity clicked, which it then follows. Clicking the same one again lets it go, and so
    # does its close button, through the `close` listener below. The subscription the viewer
    # forwards against is derived from this registration, so nothing about it is declared twice.
    #
    # No modifier is named, so every combination arrives and the reported set is whatever was held.
    # That is what makes tools/tracks/pointer-check.mjs able to tell a combination that is dropped on
    # the way from one that arrives mislabelled.
    on_pointer(server; type = :click) do ev, reply
        ev.entity === nothing && return nothing
        # `collect(Symbol, ...)` rather than `collect`: an empty modifier set is an empty tuple, and
        # collecting one without an element type yields a `Union{}[]` that JSON renders as `{}`.
        println("click ", JSON.json((; kind = ev.entity.kind, idx = ev.entity.idx,
                                     mods = collect(Symbol, ev.mods), ev.frame, ev.window)))
        flush(stdout)
        id = "$(ev.entity.kind)-$(ev.entity.idx)"
        haskey(PINNED, id) ? delete!(PINNED, id) : (PINNED[id] = pin(ev.entity.kind, ev.entity.idx))
        declare_floats(server)
        # A float's content is keyframed, and the windows already buffered ahead of the clock were
        # built when this one was not standing, so none of them carries a track addressed to it. The
        # replacement covers where the clock is, so the box reads the keyframe on screen instead of
        # its declared placeholder, and stops short of the declared range's end so the two-keyframe
        # window interpolation needs still fits inside it.
        start_frame = min(max(something(ev.frame, 1), 1), NFRAME - 1)
        push_window(server, Dict(:primitives => window_payload(start_frame, 2),
                                 :ui => ui_payload(start_frame, 2));
                    start_frame, count = 2, dt_seconds = DT, total_frames = NFRAME,
                    start_time = EPOCH, mode = :replace)
        return nothing
    end

    # The close button asks the server to let a float go; declaring the set without it is what
    # actually removes it, so dismissal is decided here rather than in the browser.
    on_event(server, "ui", "close") do ev, reply
        delete!(PINNED, ev.payload.id)
        declare_floats(server)
        return nothing
    end

    # A control is an ordinary listener on the `ui` module's topic. The scene changes only because
    # this pushes a replacement window; the overlay is declared again either way, so the widget ends
    # up showing the state the scene is actually in.
    on_event(server, "ui", "control") do ev, reply
        ev.payload.id == "links" && (SHOW_LINKS[] = ev.payload.value === true)
        # The replacement covers where the clock is, and stops short of the declared range's end so
        # the two-keyframe window interpolation needs still fits inside it.
        start_frame = min(max(something(ev.frame, 1), 1), NFRAME - 1)
        push_window(server, Dict(:primitives => window_payload(start_frame, 2),
                                 :ui => ui_payload(start_frame, 2));
                    start_frame, count = 2, dt_seconds = DT, total_frames = NFRAME,
                    start_time = EPOCH, mode = :replace)
        declare_overlay(server, overlay_items())
        println("control ", JSON.json((; ev.payload.id, ev.payload.value, ev.frame)))
        flush(stdout)
        return nothing
    end

    # The opening window: two keyframes, the fewest interpolation can run across.
    push_window(server, Dict(:primitives => window_payload(1, 2), :ui => ui_payload(1, 2));
                start_frame = 1, count = 2, dt_seconds = DT, total_frames = NFRAME,
                start_time = EPOCH, mode = :replace)
    return server
end

if abspath(PROGRAM_FILE) == @__FILE__
    port = length(ARGS) ≥ 1 ? parse(Int, ARGS[1]) : 50006
    serve_tracks(; port)
    println("tracks scene on http://localhost:$port/?ws=auto — ctrl-C to stop")
    while true
        sleep(1)
    end
end
