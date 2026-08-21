# A ring of satellites joined by links, drawn with a line material of the scene's own.
#
#     julia examples/PulseEdges/run.jl
#
# From a session that already has CesiumLink, one line starts the same scene and returns the server:
#
#     include(joinpath(pkgdir(CesiumLink), "examples", "PulseEdges", "run.jl"))
#
# The example is here for one seam. The vendored `primitives` module draws an edge in one of three
# stock materials, and a scene that wants a fourth registers it from the browser rather than copying
# the module. Both halves are in this directory: `assets/pulse.js` registers the material, and the
# `Edges` family below names it. The name `"pulse.travelling"` is all that joins them.
#
# Nothing else about the scene is the point. Twelve satellites fly one circular orbit, propagated by
# hand, and each link joins one to the next.

# This example has no environment of its own. CesiumLink is its only dependency, and the package's
# own environment holds it.
Base.include(@__MODULE__, joinpath(@__DIR__, "..", "setup.jl"))   # hide
AUTORUN && activate_example(REPO_ROOT)   # hide

using CesiumLink

# The id the module is declared under, and the material it registers. The name of the material
# starts with the id of the module, which is what tells `primitives` to look for a registration
# instead of a stock name — see `assets/pulse.js`.
const MODULE_ID = "pulse"
const MATERIAL = "pulse.travelling"

const MU = 3.986004418e14       # Earth's gravitational parameter, m³/s²
const R_EARTH = 6378137.0       # metres
const SPIN = 7.2921159e-5       # how fast the Earth turns, rad/s
const ALTITUDE = 1.2e6          # metres above the surface
const INCLINATION = 60.0        # degrees
const NSAT = 12
const KEYFRAMES = 60
const DT_SECONDS = 60.0
const LINK_COLOR = "#ffb347"

# Twelve satellites evenly spaced around one circular orbit, in ECEF metres: 3 × NSAT × KEYFRAMES.
# The orbit is tilted by the inclination and the Earth turns under it. This is the whole propagator,
# because the subject of the example is the material and not the orbit.
function ring_positions()
    r = R_EARTH + ALTITUDE
    rate = sqrt(MU / r^3)                    # radians per second around the orbit
    ci, si = cosd(INCLINATION), sind(INCLINATION)
    position = Array{Float64,3}(undef, 3, NSAT, KEYFRAMES)
    for k in 1:KEYFRAMES
        t = (k - 1) * DT_SECONDS
        cg, sg = cos(SPIN * t), sin(SPIN * t)  # the Earth's own turn, undone to reach ECEF
        for s in 1:NSAT
            θ = 2π * (s - 1) / NSAT + rate * t
            x, y, z = r * cos(θ), r * sin(θ) * ci, r * sin(θ) * si
            position[:, s, k] .= (cg * x + sg * y, -sg * x + cg * y, z)
        end
    end
    return position
end

# One link per satellite, joining it to the next and the last one back to the first: a 2 × NSAT
# matrix of 1-based index pairs.
const LINKS = reduce(hcat, [[s, mod1(s + 1, NSAT)] for s in 1:NSAT])

"""
    install_pulse_scene!(server) -> NamedTuple

Build the scene and push it to `server`. Returns the positions and the links it drew, so a caller
can check that the scene really holds something.
"""
function install_pulse_scene!(server)
    # `primitives` is registered first, so its own setup has run by the time `pulse` reaches it.
    # Registration order is the order the viewer runs the setups in, and a module that reaches a
    # peer before that peer's setup is told so and gets state that is not built yet.
    register_module!(server, vendored(:primitives))
    register_module!(server, MODULE_ID, joinpath(@__DIR__, "assets", "pulse.js"))
    register_module!(server, vendored(:ui))

    position = ring_positions()

    declare_overlay(server, [
        Title("A line material of the scene's own"; region = :top_left),
    ])

    # `style` names the registered material. Julia checks the shape of the name and passes it on: it
    # cannot know what a browser registered, so a name that nothing answers for draws a solid line
    # and writes one console line rather than failing here.
    push_window(server,
                Dict(:primitives => primitives_payload(
                         Nodes(:sat; position, size = 10, color = LINK_COLOR),
                         Edges(:link; from = :sat, to = :sat, pairs = LINKS,
                               style = MATERIAL, width = 3.0, color = LINK_COLOR)));
                start_frame = 1, count = KEYFRAMES, dt_seconds = DT_SECONDS,
                total_frames = KEYFRAMES)

    return (; position, links = LINKS)
end

"""
    run_example()

Start a server for this scene and print the address of the viewer. A session gets the server back,
to stop with `stop_server`.
"""
function run_example()
    server = start_server()
    install_pulse_scene!(server)
    return hold(server)
end

AUTORUN && run_example()   # hide
