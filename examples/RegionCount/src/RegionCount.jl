"""
    RegionCount

Satellites passing over two regions, and a chart of how many of them stood above one. The chart is
drawn by a viewer module this package ships, into a floating box the viewer hands over.

Run the example with `run.jl` beside this file.

The package shows three things together: a scene installed through `serve_scene!`, a module that
fills a `ui` content site, and a JavaScript library that arrives as a Julia artifact.
"""
module RegionCount

using CesiumLink
using Dates
using LazyArtifacts

export Satellites, RegionScene, counts_over, counts_payload, answer!

# The id the module is declared under, the key its commands are addressed to, and the topic it
# listens on. The JavaScript names the topic too, and the two must move together.
const MODULE_ID = "regioncount"
const TOPIC = "counts"

# Two coarse rings, each a 2 × V matrix of (lon; lat) degrees. They exist to be clicked, and they
# are not a map. Both sit well away from the antimeridian, which is what lets `inside` treat
# longitude as a plain number.
const REGIONS = [
    Float64[-10 2 20 30 40 30 12 -5; 36 44 40 40 47 60 58 45],       # Europe
    Float64[-17 -8 9 12 12 20 35 41 51 37 25 10 -6;
            21 4 4 -6 -20 -35 -25 -3 12 20 32 34 35],                # Africa
]
const REGION_NAMES = ["Europe", "Africa"]

const MU = 3.986004418e14        # Earth's gravitational parameter, m³/s²
const R_EARTH = 6378137.0        # metres
const SPIN = 7.2921159e-5        # how fast the Earth turns, rad/s

"""
    Satellites(; planes = 12, per_plane = 12, altitude_km = 700, inclination_deg = 55,
               epoch = DateTime(2026, 3, 20), keyframes = 90, dt_seconds = 60)

What the scene is made of: a set of circular orbits, and how long to fly them for. Pass one to
`serve_scene!`.
"""
Base.@kwdef struct Satellites
    planes::Int = 12
    per_plane::Int = 12
    altitude_km::Float64 = 700.0
    inclination_deg::Float64 = 55.0
    epoch::DateTime = DateTime(2026, 3, 20)
    keyframes::Int = 90
    dt_seconds::Float64 = 60.0
end

"""
    RegionScene

The scene that is playing: where every satellite is at every keyframe, where its sub-satellite point
is, the rings it passes over, and the directory the viewer module is served from.
"""
struct RegionScene
    position::Array{Float64,3}    # 3 × satellites × keyframes, ECEF metres
    subpoint::Array{Float64,3}    # 2 × satellites × keyframes, (lon; lat) degrees
    minutes::Vector{Float64}      # keyframe times, minutes from the epoch
    regions::Vector{Matrix{Float64}}
    names::Vector{String}
    served::String                # the staged directory the module and its library are read from
end

# Circular orbits, propagated by hand. A satellite is a point on a circle of radius `r`, tilted by
# the inclination and turned to its own plane; the Earth turns under it. Fifteen lines of geometry
# instead of a dependency: the subject here is the module boundary, not orbital mechanics.
function propagate(c::Satellites)
    r = R_EARTH + 1000c.altitude_km
    rate = sqrt(MU / r^3)                       # radians per second around the orbit
    ci, si = cosd(c.inclination_deg), sind(c.inclination_deg)
    nsat = c.planes * c.per_plane
    position = Array{Float64,3}(undef, 3, nsat, c.keyframes)
    subpoint = Array{Float64,3}(undef, 2, nsat, c.keyframes)
    for k in 1:c.keyframes
        t = (k - 1) * c.dt_seconds
        spin = SPIN * t                         # how far the Earth turned since the epoch
        for p in 1:c.planes, j in 1:c.per_plane
            raan = 2π * (p - 1) / c.planes              # where this plane crosses the equator
            u = 2π * (j - 1) / c.per_plane + rate * t   # the angle travelled from the equator
            # Inertial, then turned into the frame the globe is drawn in.
            xi = cos(raan) * cos(u) - sin(raan) * sin(u) * ci
            yi = sin(raan) * cos(u) + cos(raan) * sin(u) * ci
            z = sin(u) * si
            x = xi * cos(spin) + yi * sin(spin)
            y = -xi * sin(spin) + yi * cos(spin)
            s = (p - 1) * c.per_plane + j
            position[:, s, k] .= (r * x, r * y, r * z)
            subpoint[1, s, k] = atand(y, x)
            subpoint[2, s, k] = asind(z)
        end
    end
    return position, subpoint
end

# Ray casting: a point is inside a ring when a ray from it crosses the edges an odd number of times.
# Longitude is treated as a plain number, which holds because neither ring crosses the antimeridian.
function inside(ring::AbstractMatrix, lon, lat)
    hit = false
    n = size(ring, 2)
    j = n
    for i in 1:n
        x1, y1 = ring[1, i], ring[2, i]
        x2, y2 = ring[1, j], ring[2, j]
        if (y1 > lat) != (y2 > lat) && lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            hit = !hit
        end
        j = i
    end
    return hit
end

"""
    counts_over(scene::RegionScene, region::Integer) -> Vector{Int}

How many satellites stood above `region` at each keyframe. This is what the chart draws, and the one
place the answer is computed: the click listener and the recording step both call it.
"""
function counts_over(scene::RegionScene, region::Integer)
    ring = scene.regions[region]
    sats = axes(scene.subpoint, 2)
    return [count(s -> inside(ring, scene.subpoint[1, s, k], scene.subpoint[2, s, k]), sats)
            for k in axes(scene.subpoint, 3)]
end

"""
    counts_payload(scene::RegionScene, region::Integer) -> NamedTuple

The payload the viewer module reads: which region was asked about, the keyframe times in minutes,
and one count per keyframe.
"""
counts_payload(scene::RegionScene, region::Integer) =
    (; region = scene.names[region], scene.minutes, counts = counts_over(scene, region))

"""
    answer!(server, scene::RegionScene, region::Integer) -> Int

Send the chart for `region` to the module, outside any event. A click answers through the listener
instead; this is how a recording drives the same path by hand.
"""
answer!(server, scene::RegionScene, region::Integer) =
    send_command(server, MODULE_ID, TOPIC, counts_payload(scene, region))

"""
    stage_module!(server) -> String

Copy the module and the chart library into a fresh directory, register the module from there, and
return the directory.

The server serves one directory per module — the entry file's own — so the library has to sit beside
the entry file. The library arrives as a lazy artifact, and an artifact directory is content
addressed and belongs to no package, so nothing is written into it or into the installed package.
The files are copied rather than linked, because a symlink does not work on Windows.
"""
function stage_module!(server)
    dir = mktempdir()
    cp(joinpath(pkgdir(RegionCount), "assets", "regioncount.js"), joinpath(dir, "regioncount.js"))
    cp(joinpath(artifact"plotly-esm-min", "plotly-esm-min.mjs"), joinpath(dir, "plotly-esm-min.mjs"))
    # `ModuleEntry` defaults `api_version` to the version this package implements. A viewer that
    # implements another version skips the module and says so, rather than running it against a
    # contract it does not meet — so state a version here only to declare an older one on purpose.
    register_module!(server, ModuleEntry(MODULE_ID, joinpath(dir, "regioncount.js")))
    return dir
end

"""
    serve_scene!(server, c::Satellites = Satellites()) -> RegionScene

Install the scene: stage the viewer module, declare the overlay and the float that mounts it,
register the click listener and push the whole window.

The float is declared once, up front, holding an empty chart. A float that appeared on the first
click would forget where the user had moved it, since every rect the user gave a box is dropped when
a scene is installed.
"""
function CesiumLink.serve_scene!(server, c::Satellites = Satellites())
    served = stage_module!(server)
    register_module!(server, vendored(:primitives))
    register_module!(server, vendored(:ui))

    position, subpoint = propagate(c)
    minutes = [(k - 1) * c.dt_seconds / 60 for k in 1:c.keyframes]
    scene = RegionScene(position, subpoint, minutes, REGIONS, REGION_NAMES, served)

    # The pick is the whole stack under the cursor, nearest first, so the ring is looked for by name
    # rather than taken from the nearest entity: a satellite drawn over a ring is nearer than it.
    listener = on_pointer(server; type = :click) do ev, reply
        i = findfirst(e -> e.kind == "region", ev.entities)
        i === nothing && return nothing
        # The index is already 1-based. It is bounded here because a listener that raises sends no
        # commands frame and no error, which reads exactly like a click that reached nothing.
        idx = ev.entities[i].idx
        1 <= idx <= length(scene.regions) || return nothing
        command!(reply, MODULE_ID, TOPIC, counts_payload(scene, idx))
    end
    install_scene!(server, scene, [listener])

    declare_overlay(server, [Title("Satellites over a region"; region = :top_left)])
    declare_floating(server, [
        Floating("counts"; anchor = Screen(24, 96), mount = MODULE_ID, closable = false,
                 adjustable = true, style = (; width = "420px", height = "300px")),
    ])
    push_window(server,
                Dict(:primitives => primitives_payload(
                         Areas(:region; boundary = scene.regions, outline = "#ffffffcc",
                               color = "#4cc9f066"),
                         Nodes(:sat; position, size = 7, color = "#ffe066")));
                start_frame = 1, count = c.keyframes, dt_seconds = c.dt_seconds,
                total_frames = c.keyframes, start_time = "$(c.epoch)Z")
    return scene
end

end # module RegionCount
