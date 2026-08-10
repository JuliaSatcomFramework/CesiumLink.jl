# Real satellites on a lit globe, each one dragging a glowing trail along its orbit.
#
#     julia examples/Satellites/run.jl
#
# The orbital elements are real: `leo-20200122.tle` is 60 low, near-circular orbits out of a
# CelesTrak catalogue snapshot, and SGP4 propagates each one. The mission runs at the snapshot's own
# epoch, because SGP4 drifts by kilometres a day away from the epoch its elements were fitted at.
# Point `TLE_FILE` at a fresh download to fly today's sky:
#
#     curl 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle' > visual.tle
#
# What the scene shows, and what draws it:
#
# - one marker per satellite — a `Nodes` family whose positions the viewer interpolates per tick;
# - the trail behind and ahead of each one — an `Edges` family over a second, invisible node family
#   that holds the trail vertices. A vertex is a fixed offset from the keyframe rather than a fixed
#   instant of the mission, so the whole trail slides along the orbit as one, and it slides smoothly
#   because a position is the one thing the viewer blends between keyframes. The vertex at offset
#   zero rides the same blend as the marker, so the head of the trail cannot drift off it;
# - the day and night faces — `lighting = true`, so the sun stands where the clock says, and
#   `stars = true` for the sky it stands in;
# - a tour of two stops — a declared camera track that opens on the whole sky and then rides one
#   satellite. A drag while it rides steers around the satellite and keeps riding it.

# The environment beside this file, set up only when the file is run as a program. Something that
# includes it — the documentation build does — brings its own environment, which already holds these
# packages.
if abspath(PROGRAM_FILE) == @__FILE__
    using Pkg
    Pkg.activate(@__DIR__)
    Pkg.develop(path = normpath(joinpath(@__DIR__, "..", "..")))
    Pkg.instantiate()
end

using CesiumLink
using Dates
using LinearAlgebra: norm
using SatelliteToolboxPropagators
using SatelliteToolboxTle
using SatelliteToolboxTransformations: r_eci_to_ecef

const TLE_FILE = joinpath(@__DIR__, "leo-20200122.tle")
const DT_SECONDS = 30.0         # mission time between two keyframes
const TOTAL_FRAMES = 30         # the whole mission: fifteen minutes, a sixth of an orbit
# What one window carries. The trail costs a position per satellite per offset per keyframe, so the
# window is short: eight keyframes are about 100 KB and six seconds of playback, which is time enough
# to ask for the next eight and have them arrive. A long window would only put more of the mission in
# the viewer's buffer, and it is the buffer a scrub has to be answered out of.
const CHUNK_FRAMES = 8
const INTERVAL_SECONDS = 0.75   # wall-clock time one keyframe interval plays over
const LEAD_SECONDS = 60.0       # how far ahead of the satellite the trail is drawn
const TRAIL_SECONDS = 180.0     # and how far behind it
# Where the trail has a vertex, as an offset from the keyframe. The step is one keyframe interval, so
# the ladder is nine vertices: six behind the satellite, the satellite, and two ahead of it. A 30 s
# chord of a low orbit stands about 1 km inside the arc it cuts, which is well under a pixel at any
# range the whole globe is visible from, and the ladder is what the window pays for: one position per
# satellite per offset per keyframe.
const TRACK_OFFSETS = (-TRAIL_SECONDS):DT_SECONDS:LEAD_SECONDS
const SAT_COLOR = "#00e5ff"
const TRAIL_COLOR = "#00e5ff80"
# The tour: which satellite the camera rides, and the keyframe it gets on at. Twelve keyframes is
# nine seconds of playback, which is time enough to read the whole sky before the camera leaves it.
const RIDE_SAT = 1
const RIDE_FRAME = 12
const IMAGERY = Imagery("https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
                        max_level = 18, credit = "© OpenStreetMap · © CARTO")

"""
    SatelliteScene(; tle_file = TLE_FILE)

The mission, computed whole at construction: where every satellite stands at every keyframe, where
each of its trail vertices stands at each keyframe, and the line mesh over those vertices.

Two hours of 60 satellites is a small array, so the scene holds it rather than propagating per
window. A mission long enough for that to matter propagates per window instead — see the
`Constellation` example, which computes each window from the range it is asked for.
"""
struct SatelliteScene
    epoch::DateTime
    names::Vector{String}
    position::Array{Float64,3}      # 3 × S × TOTAL_FRAMES, ECEF metres
    track::Array{Float64,4}         # 3 × S × offsets × TOTAL_FRAMES, the trail vertices
    segments::Matrix{Int}           # 2 × M index pairs into one keyframe's vertices
end

function SatelliteScene(; tle_file = TLE_FILE)
    tles = read_tles_from_file(tle_file)
    # The elements of one snapshot are fitted at epochs a few days apart. The mission runs at the
    # latest of them, which is the instant the whole set is freshest at.
    epoch = julian2datetime(maximum(tle_epoch, tles))
    jd0 = datetime2julian(epoch)
    propagators = [Propagators.init(Val(:SGP4), tle) for tle in tles]
    keyframe_time = [(k - 1) * DT_SECONDS for k in 1:TOTAL_FRAMES]

    position = positions_at(propagators, jd0, keyframe_time)
    nsat, noffset = length(tles), length(TRACK_OFFSETS)
    track = Array{Float64}(undef, 3, nsat, noffset, TOTAL_FRAMES)
    for (k, t) in enumerate(keyframe_time)
        track[:, :, :, k] = positions_at(propagators, jd0, t .+ TRACK_OFFSETS)
    end

    # One keyframe's vertices reach the viewer as one family of `S · offsets` entities, laid out
    # satellite first: vertex `s + (j - 1) · S` is satellite `s` at offset `j`. A segment joins two
    # consecutive offsets of one satellite, and the pairs are the same at every keyframe because
    # every vertex keeps its place in the ladder.
    vertex(s, j) = s + (j - 1) * nsat
    segments = [vertex(s, j + (i - 1)) for i in 1:2, s in 1:nsat, j in 1:(noffset - 1)]
    return SatelliteScene(epoch, [String(tle.name) for tle in tles], position, track,
                          reshape(segments, 2, :))
end

# Where every satellite stands at each of `times` — seconds from the epoch at Julian day `jd0` — as
# `3 × S × length(times)` ECEF metres. A time before the epoch is as good as one after it, which is
# what the trailing half of the ladder asks for at the first keyframe. SGP4 gives a position in
# TEME, which is the frame its own theory is written in.
#
# Do not read Earth orientation parameters here. What the TEME-to-PEF rotation leaves out without
# them — polar motion, and the difference between UT1 and UTC — moves a satellite by a few metres,
# far under one pixel at this scale, and reading them needs the network.
function positions_at(propagators, jd0, times)
    position = Array{Float64}(undef, 3, length(propagators), length(times))
    for (k, t) in enumerate(times)
        jd = jd0 + t / 86400
        teme_to_ecef = r_eci_to_ecef(Val(:TEME), Val(:PEF), jd)
        for (s, propagator) in enumerate(propagators)
            r_teme, _ = Propagators.propagate_to_epoch!(propagator, jd)
            position[:, s, k] = teme_to_ecef * r_teme
        end
    end
    return position
end

nsat(scene::SatelliteScene) = length(scene.names)

# The three families for keyframes `first_frame` to `first_frame + count - 1`. The trail vertices
# travel as one more moving family: `3 × (S · offsets) × count`, which the viewer blends per tick
# exactly as it blends the markers. The family hides its own markers — an edge draws from a masked
# endpoint, and nothing else reads that family — and the lines over it never change, so the edge
# family carries no `show` and is never torn down.
function window_families(scene::SatelliteScene, first_frame, count)
    frames = first_frame:(first_frame + count - 1)
    return (
        Nodes(:sat; position = scene.position[:, :, frames], size = 6, color = SAT_COLOR),
        Nodes(:track; position = reshape(scene.track[:, :, :, frames], 3, :, count), show = false),
        Edges(:trail; from = :track, to = :track, pairs = scene.segments, style = :glow,
              width = 1.0, color = TRAIL_COLOR),
    )
end

# Send keyframes `first_frame` to `first_frame + count - 1`, clipped to the mission.
function push_frames!(server, scene::SatelliteScene, first_frame, count, mode)
    count = min(count, TOTAL_FRAMES - first_frame + 1)
    count ≥ 1 || return 0
    push_window(server,
                Dict(:primitives => primitives_payload(window_families(scene, first_frame, count)...));
                start_frame = first_frame, count, mode, dt_seconds = DT_SECONDS,
                total_frames = TOTAL_FRAMES, interval_seconds = INTERVAL_SECONDS,
                start_time = string(scene.epoch, "Z"))
    return count
end

"""
    install_satellite_scene!(server, scene = SatelliteScene()) -> SatelliteScene

Install `scene` on `server`: register the modules it draws with, declare its overlay, push the first
chunk of the mission, and register the two listeners that keep it answering.
"""
function install_satellite_scene!(server, scene = SatelliteScene())
    register_module!(server, vendored(:primitives))
    register_module!(server, vendored(:ui))

    declare_overlay(server, [
        Title("$(nsat(scene)) satellites, propagated from real elements"; region = :top_left),
    ])
    push_frames!(server, scene, 1, CHUNK_FRAMES, :replace)

    # Two stops: the whole sky, and then the view from one satellite. The ride is what the scene is
    # for — the marker holds still in the frame while the ground and the other orbits sweep under it.
    # A track is declared after the window that establishes the keyframe grid its `at` counts on.
    declare_camera(server,
                   Viewpoint(; lon = 0, lat = 20, height = 24_000_000, label = "The whole sky"),
                   Viewpoint(; follow = "sat[$RIDE_SAT]", range = 500_000, pitch = -35,
                             at = RIDE_FRAME, duration = 5,
                             label = "Riding $(scene.names[RIDE_SAT])"))

    listeners = (
        # The Core asks here as playback nears the end of the buffer.
        on_event(server, "core", "need") do ev, _
            push_frames!(server, scene, ev.start_frame, max(ev.count, CHUNK_FRAMES), ev.mode)
        end,

        # The name and the height of the satellite under the cursor. Both are read out of the arrays
        # the scene already holds: a hover listener that computes delays every other answer to the
        # same event, and one that throws loses the whole batch with nothing on screen to say so.
        on_pointer(server; type = :hover) do ev, reply
            sat = nothing
            for e in ev.entities
                e.kind == "sat" && (sat = e; break)
            end
            frame = ev.frame
            ok = sat !== nothing && frame isa Integer &&
                 checkbounds(Bool, scene.names, sat.idx) &&
                 checkbounds(Bool, 1:TOTAL_FRAMES, frame)
            # Hide the box on a miss. An empty reply leaves the last tooltip standing while it
            # follows the cursor.
            ok || return command!(reply, "ui", "tooltip", (; html = nothing))
            height_km = (norm(scene.position[:, sat.idx, frame]) - 6_378_137.0) / 1000
            tooltip!(reply) do io
                print(io, "<b>", scene.names[sat.idx], "</b><br>",
                      round(height_km; digits = 1), " km")
            end
        end,
    )

    return install_scene!(server, scene, listeners)
end

if abspath(PROGRAM_FILE) == @__FILE__
    server = start_server(; imagery = IMAGERY, lighting = true, stars = true)
    install_satellite_scene!(server)
    println("open ", viewer_url(server), " — then press Enter to stop")
    readline()
    stop_server(server)
end
