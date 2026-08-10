# Forty satellites over Europe and North Africa, with their ground cells, gateways and links.
#
#     julia examples/Constellation/run.jl
#
# From a session that already has CesiumLink, one line starts the same scene and returns the server:
#
#     include(joinpath(pkgdir(CesiumLink), "examples", "Constellation", "run.jl"))

Base.include(@__MODULE__, joinpath(@__DIR__, "..", "setup.jl"))   # hide
AUTORUN && activate_example(@__DIR__)   # hide

using CesiumLink, Constellation

"""
    run_example()

Start a server for this scene and print the address of the viewer. A session gets the server back,
to stop with `stop_server`.
"""
function run_example()
    server = start_server()
    serve_scene!(server, ConstellationScene())
    return hold(server)
end

AUTORUN && run_example()   # hide
