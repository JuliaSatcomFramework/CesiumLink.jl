# Run the example:
#
#     julia examples/RegionCount/run.jl
#
# CesiumLink is not a registered package, so this environment is told where it is: the checkout two
# directories above this file. Both calls do nothing after the first run.

using Pkg
Pkg.activate(@__DIR__)
Pkg.develop(path = normpath(joinpath(@__DIR__, "..", "..")))
Pkg.instantiate()

using CesiumLink, RegionCount

server = start_server()
serve_scene!(server, Satellites())
println("open ", viewer_url(server), " — click Europe or Africa, then press Enter to stop")
readline()
stop_server(server)
