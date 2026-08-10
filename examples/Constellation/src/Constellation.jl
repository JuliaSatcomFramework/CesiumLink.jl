"""
    Constellation

A Walker constellation over Europe and North Africa, as a CesiumLink scene: satellites, ground
cells, gateways, and the three link families their geometry implies.

    julia examples/Constellation/run.jl

The package holds the one method of [`CesiumLink.serve_scene!`](@ref) in this repository. Everything
it draws is geometry — a link stands while its far end is above `MASK_DEG` degrees of elevation, and
nothing here solves a route or counts capacity.

The mission is declared whole and delivered a chunk at a time: the scene answers `core/need` with an
append, so the viewer holds `CHUNK_FRAMES` keyframes rather than `TOTAL_FRAMES` of them.
"""
module Constellation

using CesiumLink
using Dates
using LinearAlgebra: dot, norm
using SatelliteToolboxPropagators
using SatelliteToolboxTransformations: r_eci_to_ecef

export ConstellationScene

const EPOCH = DateTime(2026, 6, 21, 12, 0, 0)
const PLANES = 5                # a Walker delta pattern of 40 satellites: 40/5/1
const PER_PLANE = 8
const PHASING = 1
const ALTITUDE_M = 8.0e5
const INCLINATION_DEG = 53.0
const DT_SECONDS = 30.0         # mission time between two keyframes
const TOTAL_FRAMES = 300        # the whole mission, two and a half hours at that step
const CHUNK_FRAMES = 60         # half an hour, and what one window carries
const MASK_DEG = 10.0           # a link stands while its far end is this high above the horizon
const BOX = (lon = (-15.0, 40.0), lat = (25.0, 65.0))   # Europe and North Africa
const LATTICE = 4000            # points over the whole sphere, of which the box keeps some
const CELL_RADIUS_M = 2.1e5
const CMAP = ["#26456e", "#3f8fbf", "#7fd4c1", "#ffe08a"]

const SAT_COLOR = "#ffe08a"
const USER_COLOR = "#7fd4c1"
const FEEDER_COLOR = "#ffa552"
const ISL_COLOR = "#5f7fb5"

const GATEWAYS = (
    lon = [-3.70, 12.50, 23.73, 5.14, -6.85],
    lat = [40.42, 41.90, 37.98, 50.00, 33.97],
    name = ["Madrid", "Rome", "Athens", "Redu", "Rabat"],
)

"""
    ConstellationScene(; epoch = EPOCH, dt_seconds = DT_SECONDS, total_frames = TOTAL_FRAMES,
                       lattice = LATTICE, ellipsoid = Ellipsoids.WGS84)

What the scene is computed from: one propagator per satellite, the ground cells and the gateways
with the surface normal at each, and the mesh between the satellites.

The struct holds no keyframe. [`window_families`](@ref) computes every keyframe from the range it is
asked for, so a window over part of the mission costs only that part.

It does hold the two things the scene's listeners answer out of: whether the reader asked for the
inter-satellite links, and the altitude of every satellite at every keyframe delivered so far.

`ellipsoid` is the shape the ground positions are converted against. It must be the shape the
session declares, or the scene computes on one globe and is drawn on another.

`lattice` is how many points are spread over the whole sphere before the box keeps the ones inside
it, so it sets how many cells the scene holds. Raise it for a heavier scene.
"""
struct ConstellationScene
    epoch::DateTime
    dt_seconds::Float64
    total_frames::Int
    propagators::Vector{OrbitPropagator{Float64,Float64}}
    cells::Matrix{Float64}          # 2 × C degrees of (lon, lat)
    cell_ecef::Matrix{Float64}      # 3 × C metres
    cell_up::Matrix{Float64}        # 3 × C, the surface normal at each cell
    gateway_ecef::Matrix{Float64}
    gateway_up::Matrix{Float64}
    isl::Matrix{Int}                # 2 × M index pairs, the same at every keyframe
    show_isl::Base.RefValue{Bool}   # what the reader last asked the toggle for
    altitude_km::Vector{Vector{Float64}}    # one entry per delivered keyframe, one value per satellite
end

function ConstellationScene(; epoch = EPOCH, dt_seconds = DT_SECONDS,
                            total_frames = TOTAL_FRAMES, lattice = LATTICE,
                            ellipsoid = Ellipsoids.WGS84)
    cells = box_cells(lattice, BOX)
    gateways = [GATEWAYS.lon'; GATEWAYS.lat']
    return ConstellationScene(epoch, dt_seconds, total_frames, walker_propagators(epoch),
                              cells, ecef(cells[1, :], cells[2, :]; ellipsoid), up_vectors(cells),
                              ecef(GATEWAYS.lon, GATEWAYS.lat; ellipsoid), up_vectors(gateways),
                              isl_mesh(), Ref(true), Vector{Float64}[])
end

# How much of the mission is delivered: every keyframe up to here has been sent, so this is where an
# append starts and how far a replacement window reaches.
delivered(scene::ConstellationScene) = length(scene.altitude_km)

# --- what the scene is built out of ---------------------------------------------------------------

# One propagator per satellite of a Walker delta pattern: the planes spread over 360° of right
# ascension, the satellites spread around each plane, and every plane offset from the one before it
# by `PHASING` steps of the pattern's phase unit.
function walker_propagators(epoch)
    jd = datetime2julian(epoch)
    a = EARTH_EQUATORIAL_RADIUS + ALTITUDE_M
    total = PLANES * PER_PLANE
    propagators = Vector{OrbitPropagator{Float64,Float64}}(undef, total)
    for p in 1:PLANES, s in 1:PER_PLANE
        raan = 2π * (p - 1) / PLANES
        anomaly = 2π * ((s - 1) / PER_PLANE + PHASING * (p - 1) / total)
        orbit = KeplerianElements(jd, a, 0.0, deg2rad(INCLINATION_DEG), raan, 0.0, anomaly)
        propagators[(p - 1) * PER_PLANE + s] = Propagators.init(Val(:J2), orbit)
    end
    return propagators
end

# The mesh between the satellites: a ring around each plane, and one link from every satellite to the
# satellite holding the same slot in the next plane. The mesh stands for the whole mission, so it
# travels as one matrix while the two ground link families travel as one matrix per keyframe.
function isl_mesh()
    slot(p, s) = (p - 1) * PER_PLANE + mod1(s, PER_PLANE)
    pairs = NTuple{2,Int}[]
    for p in 1:PLANES, s in 1:PER_PLANE
        push!(pairs, (slot(p, s), slot(p, s + 1)))
        p < PLANES && push!(pairs, (slot(p, s), slot(p + 1, s)))
    end
    return pair_matrix(pairs)
end

# The ground cells: a Fibonacci lattice over the whole sphere, kept where it falls inside `box`. The
# lattice spaces its points evenly over the sphere, so the cells left inside the box are evenly
# spaced too. A grid of constant steps in longitude and latitude crowds them towards the pole.
function box_cells(n, box)
    golden = π * (3 - sqrt(5))
    inside = NTuple{2,Float64}[]
    for i in 1:n
        lat = asind(1 - 2 * (i - 0.5) / n)
        lon = rem(rad2deg(golden * i), 360, RoundNearest)
        first(box.lon) ≤ lon ≤ last(box.lon) && first(box.lat) ≤ lat ≤ last(box.lat) &&
            push!(inside, (lon, lat))
    end
    return Float64[inside[c][i] for i in 1:2, c in eachindex(inside)]
end

# The local up at a geodetic coordinate, which is the surface normal there. Its Cartesian form needs
# no ellipsoid: the normal points the same way whatever the two radii are.
function up_vectors(lonlat)
    up = Matrix{Float64}(undef, 3, size(lonlat, 2))
    for i in axes(lonlat, 2)
        slon, clon = sincosd(lonlat[1, i])
        slat, clat = sincosd(lonlat[2, i])
        up[1, i], up[2, i], up[3, i] = clat * clon, clat * slon, slat
    end
    return up
end

pair_matrix(pairs) = Int[pairs[m][i] for i in 1:2, m in eachindex(pairs)]

column(a, i) = (a[1, i], a[2, i], a[3, i])
column(a, i, k) = (a[1, i, k], a[2, i, k], a[3, i, k])

# The angle of `target` above the horizon at a ground point, in degrees. `up` is the surface normal
# there, so the angle between the line of sight and the local horizontal plane is one dot product.
function elevation(ground, up, target)
    los = target .- ground
    return asind(clamp(dot(up, los) / norm(los), -1.0, 1.0))
end

# --- the keyframes ---------------------------------------------------------------------------------

"""
    window_families(scene::ConstellationScene, first_frame, count) -> Tuple

The six families for keyframes `first_frame` to `first_frame + count - 1`.

Every keyframe of the scene is computed here and nowhere else, and the range is an argument, so a
window over part of the mission is this same call over a shorter range.

The inter-satellite links are among the families only while `scene.show_isl` stands. The propagation
is the same either way — the toggle changes what the payload carries, not where anything is.
"""
function window_families(scene::ConstellationScene, first_frame::Integer, count::Integer)
    sats = satellite_positions(scene, first_frame, count)
    remember_altitudes!(scene, sats, first_frame)
    ncell = size(scene.cell_ecef, 2)
    ngateway = size(scene.gateway_ecef, 2)
    nsat = length(scene.propagators)

    # The elevation of the satellite serving each cell, or `NaN` where no satellite stands high
    # enough. A `NaN` colour draws nothing, so an unserved cell leaves the globe rather than being
    # coloured for a link it does not have.
    served = fill(NaN, ncell, count)
    user = Vector{Matrix{Int}}(undef, count)
    feeder = Vector{Matrix{Int}}(undef, count)

    for k in 1:count
        links = NTuple{2,Int}[]
        for c in 1:ncell
            ground, up = column(scene.cell_ecef, c), column(scene.cell_up, c)
            best, highest = 0, MASK_DEG
            for s in 1:nsat
                angle = elevation(ground, up, column(sats, s, k))
                angle > highest && ((best, highest) = (s, angle))
            end
            best == 0 && continue
            push!(links, (c, best))
            served[c, k] = highest
        end
        user[k] = pair_matrix(links)

        feeds = NTuple{2,Int}[]
        for s in 1:nsat
            sat = column(sats, s, k)
            nearest, shortest = 0, Inf
            for g in 1:ngateway
                ground, up = column(scene.gateway_ecef, g), column(scene.gateway_up, g)
                elevation(ground, up, sat) < MASK_DEG && continue
                range_m = norm(sat .- ground)
                range_m < shortest && ((nearest, shortest) = (g, range_m))
            end
            nearest == 0 || push!(feeds, (nearest, s))
        end
        feeder[k] = pair_matrix(feeds)
    end

    families = (
        Nodes(:sat; position = sats, size = 8, color = SAT_COLOR),
        # The star stands above the cell fill, which the `:cell` family lifts to `height_m`.
        # A gateway on the ground is drawn inside a cell that covers it. The mask and the range
        # above read `gateway_ecef` itself, so this height changes the picture and not the physics.
        Nodes(:gateway; position = scene.gateway_ecef .+ 4000 .* scene.gateway_up,
              size = 15, marker = :star, color = FEEDER_COLOR, label = GATEWAYS.name),
        Areas(:cell; center = scene.cells, radius = CELL_RADIUS_M, sides = 6, height_m = 2000,
              color = reshape(rgba(CMAP, served; range = (MASK_DEG, 90.0)), 4, ncell, count)),
        # One colour per link family, not one per link. An edge's colour is its batch key, so three
        # families in three colours cost three draw commands and a ramp would cost one per edge.
        Edges(:user; from = :cell, to = :sat, pairs = user, width = 1.0, color = USER_COLOR),
        Edges(:feeder; from = :gateway, to = :sat, pairs = feeder, style = :dashed,
              dash_length = 20, width = 2.0, color = FEEDER_COLOR),
    )
    scene.show_isl[] || return families
    return (families...,
            Edges(:isl; from = :sat, to = :sat, pairs = scene.isl, width = 1.0, color = ISL_COLOR))
end

# Keep the altitude of every satellite at every keyframe this window carries. The hover listener
# reads its answer out of this and derives nothing: the listener chain assembles one batch after
# every listener returns, so work done in one of them delays every other answer to the same event.
function remember_altitudes!(scene::ConstellationScene, sats, first_frame)
    last_frame = first_frame + size(sats, 3) - 1
    length(scene.altitude_km) < last_frame && resize!(scene.altitude_km, last_frame)
    for k in axes(sats, 3)
        scene.altitude_km[first_frame + k - 1] =
            [(norm(column(sats, s, k)) - EARTH_EQUATORIAL_RADIUS) / 1000 for s in axes(sats, 2)]
    end
    return nothing
end

# The altitude of satellite `idx` at keyframe `frame`, or `nothing` where the delivered buffer does
# not reach. Every index is bounded here, because a hover listener that throws loses the whole batch
# of commands and nothing on screen reports it.
function satellite_altitude(scene::ConstellationScene, frame, idx)
    frame isa Integer && checkbounds(Bool, scene.altitude_km, frame) &&
        isassigned(scene.altitude_km, frame) || return nothing
    at = scene.altitude_km[frame]
    return checkbounds(Bool, at, idx) ? at[idx] : nothing
end

# Where every satellite stands over the keyframe range, as `3 × S × count` ECEF metres.
#
# Do not read Earth orientation parameters here. The rotation from TEME to PEF runs without them, and
# what it leaves out — polar motion, and the difference between UT1 and UTC — moves a satellite by a
# few metres, which is far under one pixel at this scale. `fetch_iers_eop` reads them off the
# network, and a documentation build that reaches the network fails on someone else's bad day.
function satellite_positions(scene::ConstellationScene, first_frame::Integer, count::Integer)
    positions = Array{Float64}(undef, 3, length(scene.propagators), count)
    jd = datetime2julian(scene.epoch)
    for k in 1:count
        t = (first_frame + k - 2) * scene.dt_seconds        # seconds from the epoch
        teme_to_ecef = r_eci_to_ecef(Val(:TEME), Val(:PEF), jd + t / 86400)
        for (s, propagator) in enumerate(scene.propagators)
            r_teme, _ = Propagators.propagate!(propagator, t)
            positions[:, s, k] = teme_to_ecef * r_teme
        end
    end
    return positions
end

# --- the scene -------------------------------------------------------------------------------------

# State the whole overlay, with the values the scene applied. The widget shows what the server
# declared, so a control the server refuses snaps back to it.
function declare!(server, scene::ConstellationScene)
    return declare_overlay(server, [
        Title("$(length(scene.propagators)) satellites over Europe and North Africa";
              region = :top_left),
        Legend("Elevation of the serving satellite [°]", MASK_DEG, 90.0, CMAP;
               region = :top_right),
        Toggle("isl", "Inter-satellite links", scene.show_isl[]),
    ])
end

# Send keyframes `first_frame` to `first_frame + count - 1`, clipped to the declared mission.
#
# An append preserves the index space. The reader asked for nothing when the buffer grows, so
# satellite `i` stays satellite `i` and cell `i` stays cell `i`; a window that orders the entities
# differently teleports them at the seam. A window that answers a control is a `:replace` and is free
# to carry other families, because that change is the one the reader asked for.
function push_frames!(server, scene::ConstellationScene, first_frame, count, mode)
    count = min(count, scene.total_frames - first_frame + 1)
    count ≥ 1 || return 0
    push_window(server,
                Dict(:primitives =>
                     primitives_payload(window_families(scene, first_frame, count)...));
                start_frame = first_frame, count, mode, dt_seconds = scene.dt_seconds,
                total_frames = scene.total_frames, interval_seconds = 0.15,
                start_time = string(scene.epoch, "Z"))
    return count
end

"""
    serve_scene!(server, scene::ConstellationScene) -> ConstellationScene

Install `scene` on `server`: register the modules it draws with, declare its overlay, push the first
chunk of the mission, and register the three listeners that keep the scene answering.

CesiumLink declares [`CesiumLink.serve_scene!`](@ref) and defines no method for it, because only the
package that holds the data knows how to build a scene out of it. This is that method.
"""
function CesiumLink.serve_scene!(server, scene::ConstellationScene)
    register_module!(server, vendored(:primitives))
    register_module!(server, vendored(:ui))

    declare!(server, scene)
    push_frames!(server, scene, 1, CHUNK_FRAMES, :replace)

    listeners = (
        # The Core asks here as playback nears the end of the buffer. It asks for the frames it
        # wants; the answer rounds the count up to a whole chunk, so the buffer runs ahead of the
        # clock instead of being extended two keyframes at a time.
        on_event(server, "core", "need") do ev, _
            push_frames!(server, scene, ev.start_frame, max(ev.count, CHUNK_FRAMES), ev.mode)
        end,

        # The reader owns whether the inter-satellite links are drawn, and the server owns the scene
        # that follows from it. Any other control is answered by declaring the overlay again, which
        # is what puts a widget back to the value the server stands behind.
        on_event(server, "ui", "control") do ev, _
            if ev.payload.id == "isl"
                scene.show_isl[] = ev.payload.value
                declare!(server, scene)
                push_frames!(server, scene, 1, delivered(scene), :replace)
            else
                declare!(server, scene)
            end
        end,

        on_pointer(server; type = :hover) do ev, reply
            sat = nothing
            for e in ev.entities
                e.kind == "sat" && (sat = e; break)
            end
            altitude = sat === nothing ? nothing :
                       satellite_altitude(scene, ev.frame, sat.idx)
            # Hide the box on a miss. Nothing else does it, and an empty reply leaves the last
            # tooltip standing while it follows the cursor.
            altitude === nothing && return command!(reply, "ui", "tooltip", (; html = nothing))
            tooltip!(reply) do io
                print(io, "<b>Satellite ", sat.idx, "</b><br>",
                      round(altitude; digits = 1), " km")
            end
        end,
    )

    # What takes down the scene the server drove before. Re-run the example on a live server and it
    # replaces the scene, rather than leaving two of them to answer every event between them.
    return install_scene!(server, scene, listeners)
end

end # module Constellation
