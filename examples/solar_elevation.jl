# Solar elevation over the whole globe, at one instant.
#
#     julia --project=. examples/solar_elevation.jl
#
# The whole program is this file and its only dependency is CesiumLink. The sun's position is a
# closed-form expression, the field is a comprehension, and the regions are hand-written rings.
#
# The scene shows a statistic on the globe, not a state at a time, so it declares no time furniture
# and the viewer draws no clock. Nothing in the scene moves, so the camera moves instead: the scene
# declares a camera track paced by the clock on the wall.

using CesiumLink
using Dates

const EPOCH = DateTime(2026, 6, 21, 12, 0, 0)   # the June solstice, when the terminator leans most
const RANGE = (-90.0, 90.0)                     # symmetric, so the middle stop lands on 0°
# Nine stops, evenly spaced over `RANGE`: four night colours, the fifth on the horizon, then four
# day colours. The colour jumps between the fifth stop and the sixth, so the terminator is a line
# the eye finds rather than a wide band it has to look for.
const CMAP = ["#05070f", "#0a1024", "#101a3c", "#182a5c", "#22407e",
              "#e9a13c", "#f3c352", "#f9de84", "#fff6c4"]
const STEP = 2.0                                # degrees of longitude and of latitude per cell

# Five coarse rings, each a 2 × V matrix of (lon; lat) degrees. They show what `boundary` takes.
# They are not a map.
const REGIONS = [
    Float64[-10 28 40 30 5 -10; 36 36 45 60 58 48],             # Europe
    Float64[-17 20 35 40 30 18 10; 14 32 10 -5 -30 -34 4],      # Africa
    Float64[-80 -50 -35 -45 -70 -75; 8 5 -8 -25 -40 -15],       # South America
    Float64[113 130 145 153 140 120; -22 -11 -15 -28 -38 -33],  # Australia
    Float64[60 100 140 120 70; 50 50 60 72 72],                 # northern Asia
]

# The subsolar point: the coordinate the sun stands over. This is the low-precision solar position
# of the Astronomical Almanac. It is good to about 0.01° for dates near now.
function subsolar_point(t::DateTime)
    n = datetime2julian(t) - 2451545.0                          # days from J2000.0
    mean_longitude = 280.460 + 0.9856474n
    mean_anomaly = 357.528 + 0.9856003n
    ecliptic_longitude = mean_longitude + 1.915sind(mean_anomaly) + 0.020sind(2mean_anomaly)
    obliquity = 23.439 - 4.0e-7n
    right_ascension = atand(cosd(obliquity) * sind(ecliptic_longitude), cosd(ecliptic_longitude))
    sidereal_hours = mod(18.697375 + 24.065709824419n, 24)      # Greenwich, at this instant
    return (lon = rem(right_ascension - 15sidereal_hours, 360, RoundNearest),
            lat = asind(sind(obliquity) * sind(ecliptic_longitude)))
end

# The angle of the sun above the local horizon, in degrees. Negative is night. The local up vector
# is the surface normal, so the angle between it and the direction to the sun is this one
# expression — no Cartesian conversion, and no geodesy package.
solar_elevation(lon, lat, sun) =
    asind(sind(lat) * sind(sun.lat) + cosd(lat) * cosd(sun.lat) * cosd(lon - sun.lon))

# The centres of the cells that span `lo` to `hi`. A raster carries a value per cell, so sample at
# the centres: the mapping back from a coordinate to a cell is then exact.
cell_centres(lo, hi, step) = range(lo + step / 2, hi - step / 2; step)

"""
    install_solar_scene!(server; epoch = EPOCH) -> NamedTuple

Build the scene and push it to `server`. Returns the field and the regions it drew, so a caller can
check that the scene really holds something.
"""
function install_solar_scene!(server; epoch = EPOCH)
    register_module!(server, vendored(:heatmap))
    register_module!(server, vendored(:primitives))
    register_module!(server, vendored(:ui))

    sun = subsolar_point(epoch)
    lons = cell_centres(-180.0, 180.0, STEP)
    lats = cell_centres(-90.0, 90.0, STEP)
    values = [solar_elevation(lon, lat, sun) for lon in lons, lat in lats]

    # Each region takes the mean of the elevation at its own vertices.
    region_values = [sum(solar_elevation(v[1], v[2], sun) for v in eachcol(ring)) / size(ring, 2)
                     for ring in REGIONS]

    declare_overlay(server, [
        Title("Solar elevation at $(epoch)Z"; region = :top_left),
        Legend("Sun above the horizon [°]", RANGE..., CMAP; region = :top_right),
    ])
    declare_furniture(server; timeline = false, animation = false, keyframe = false)

    # The scene is one keyframe, so there is no keyframe axis to key a tour on. `after` is the
    # schedule that stays: seconds from the moment the track arrives, which in a played recording is
    # the moment the page opens. Each one counts from the declaration, not from the stop before it.
    # Each stop carries a `label`, and on a wall-paced tour that is what makes it a tour: the reader
    # sees the three stops as a list before the first one runs, so a camera that starts to move eight
    # seconds after the page opens reads as the tour it is.
    declare_camera(server,
        # Open on the daylit face. The subsolar point stands over Africa at this epoch, so the
        # terminator runs down both edges of this box.
        Viewpoint(; west = -90, south = -60, east = 90, north = 70, label = "The daylit face"),
        # Europe and Africa, the two regions the sun stands highest over.
        Viewpoint(; west = -25, south = -40, east = 50, north = 65, after = 8, duration = 5,
                  label = "Europe and Africa, at noon"),
        # South America, at the morning edge of the terminator.
        Viewpoint(; west = -85, south = -45, east = -25, north = 15, after = 20, duration = 5,
                  label = "South America, at sunrise"))

    push_window(server,
                Dict(:heatmap => heatmap_payload(
                         Raster(:elevation; extent = (-180.0, -90.0, 180.0, 90.0),
                                rgba = rgba_grid(CMAP, values; range = RANGE))),
                     :primitives => primitives_payload(
                         Areas(:region; boundary = REGIONS, outline = "#000000d9",
                               color = rgba(CMAP, region_values; range = RANGE))));
                start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)

    return (; values, regions = REGIONS, sun)
end

# Only the command line runs it. The documentation build calls the function.
if abspath(PROGRAM_FILE) == @__FILE__
    server = start_server()
    install_solar_scene!(server)
    println("open ", viewer_url(server), " — then press Enter to stop")
    readline()
    stop_server(server)
end
