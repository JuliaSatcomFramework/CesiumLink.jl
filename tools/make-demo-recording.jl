# Write the session recording the documentation plays.
#
#   julia --project=. tools/make-demo-recording.jl [out.jsonl]
#
# The documentation build calls `make_demo_recording` itself, so the file is generated rather than
# committed. Run the script by hand to look at one.
#
# The scene is a ring of satellites turning once over the run, above five ground stations. It is
# built and pushed before the recording opens, so `record!` writes the whole scene at offset zero
# out of what the server retains. A player therefore shows the scene at once instead of building it
# over the first seconds of playback.
#
# The server binds an ephemeral loopback port and nothing ever connects to it: the recording is
# written out of what the server retains, not out of what a client received. So this runs beside a
# live viewer without taking its port.

using CesiumLink

const FRAMES = 36
const DT = 600.0                       # ten minutes of mission time per keyframe
const START = "2026-08-04T12:00:00Z"
const N_SATS = 12
const RADIUS = 6.378137e6 + 7.0e5
const CMAP = ["#2b3a67", "#33e0ff", "#ffd166"]

# Every basemap this package ships, in the order the picker draws them. Entry 1 is what the globe
# wears at startup, so the sharp labelled one stays first and the bundled pyramid stays last. The
# basemap guide plays this recording to show a picker holding the whole catalogue.
const DEMO_IMAGERY = [KNOWN_EARTH_BASEMAPS.blue_marble_labeled,
                      KNOWN_EARTH_BASEMAPS.blue_marble,
                      KNOWN_EARTH_BASEMAPS.blue_marble_relief,
                      KNOWN_EARTH_BASEMAPS.offline_natural_earth]

const STATIONS = (
    lon = [12.50, -0.13, -74.01, 139.69, 151.21],
    lat = [41.90, 51.51, 40.71, 35.69, -33.87],
    name = ["Rome", "London", "New York", "Tokyo", "Sydney"],
)

# A ring of satellites, one turn over the whole run, so the run reads as a run.
function demo_ring(frames)
    pos = Array{Float32}(undef, 3, N_SATS, length(frames))
    for (k, f) in enumerate(frames), s in 1:N_SATS
        θ = 2π * ((s - 1) / N_SATS + (f - 1) / FRAMES)
        pos[1, s, k] = RADIUS * cos(θ)
        pos[2, s, k] = RADIUS * sin(θ) * cosd(35)
        pos[3, s, k] = RADIUS * sin(θ) * sind(35)
    end
    return pos
end

"""
    make_demo_recording(out; dist_dir) -> String

Write the documentation's demo recording to `out` and return the path. `dist_dir` is the built
viewer, which the module set is named out of.
"""
function make_demo_recording(out; dist_dir)
    # This scene belongs to the recorder, and to nobody's screen.
    server = start_server(; dist_dir, host = "127.0.0.1", port = 0, open = false,
                          imagery = DEMO_IMAGERY)
    try
        register_module!(server, vendored(:primitives; dist_dir))
        register_module!(server, vendored(:ui; dist_dir))

        colours = rgba(CMAP, 1:N_SATS; range = (1, N_SATS))
        stations = ecef(STATIONS.lon, STATIONS.lat; ellipsoid = server)

        declare_overlay(server, [
            Title("A recorded session, played in the browser"; region = :top_left),
            Legend("Satellite index", 1, N_SATS, CMAP; region = :top_right),
        ])
        declare_furniture(server; timeline = true, animation = true, keyframe = true)

        # The tour the recording carries. It is declared before `record!`, so the server retains it
        # and it lands at offset zero: the page flies it with no Julia behind it. Every stop is keyed
        # by keyframe, so the camera holds when the reader pauses and goes back when the reader
        # scrubs.
        #
        # A keyframe is 0.4 s of playback and the run is 36 of them, so the stops below fall at 3.2 s,
        # 7.6 s and 10.8 s of a 14.4 s run. Twelve satellites stand 30° apart and the ring turns 10°
        # per keyframe, so every third keyframe puts one on a station's meridian: keyframe 9 on
        # Rome's, keyframe 20 on New York's.
        #
        # Each stop carries a `label`, so the viewer's stop list names the tour instead of falling
        # back to four keyframe indices. A label says where the camera goes: the ring passes over each
        # station's meridian and never over the station itself, so a stop claims the meridian only.
        declare_camera(server,
            # Open far enough out to hold the whole ring.
            Viewpoint(; lon = 20, lat = 25, height = 24_000_000, label = "The whole ring"),
            # Settle over Rome, then over New York, as the ring crosses each one's meridian.
            Viewpoint(; lon = STATIONS.lon[1], lat = STATIONS.lat[1], height = 3_200_000,
                      at = 9, duration = 3, label = "$(STATIONS.name[1])'s meridian"),
            Viewpoint(; lon = STATIONS.lon[3], lat = STATIONS.lat[3], height = 3_200_000,
                      at = 20, duration = 3, label = "$(STATIONS.name[3])'s meridian"),
            # Pull out over the Atlantic, between the two stations the tour stopped over.
            Viewpoint(; lon = -30, lat = 10, height = 26_000_000, at = 28, duration = 3,
                      label = "Out over the Atlantic"))

        push_window(server,
            Dict(:primitives => primitives_payload(
                Nodes(:sat; position = demo_ring(1:FRAMES), color = colours, size = 10),
                Nodes(:station; position = stations, size = 14,
                      color = (255, 209, 102, 255), label = STATIONS.name)));
            start_frame = 1, count = FRAMES, dt_seconds = DT, total_frames = FRAMES,
            interval_seconds = 0.4, start_time = START)

        mkpath(dirname(out))
        record!(server, out)
        stop_recording!(server)
    finally
        stop_server(server)
    end
    return out
end

# Only the command line runs it; the documentation build calls the function.
if abspath(PROGRAM_FILE) == @__FILE__
    root = normpath(joinpath(@__DIR__, ".."))
    out = length(ARGS) ≥ 1 ? ARGS[1] :
        joinpath(root, "julia", "CesiumLink", "docs", "src", "public", "recordings", "orbit.jsonl")
    make_demo_recording(out; dist_dir = joinpath(root, "lib", "dist"))
    println("wrote $out ($(round(filesize(out) / 1024; digits = 1)) KiB)")
end
