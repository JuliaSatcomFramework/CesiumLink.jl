# Machinery, not material. Nothing here is part of what an example teaches: this file is what lets
# one `include` of a `run.jl` start the scene from a session, on a fresh clone. The lines that use it
# carry a `# hide` marker, and the documentation build leaves them off the page.
#
# The documentation build includes an example for its functions only: it brings its own environment
# and drives its own server. It says so by defining `Main.CESIUMLINK_LIBRARY_ONLY`. Every other
# caller — `julia examples/<name>/run.jl`, and an `include` from a session — gets the environment
# beside the example and a server that runs the scene.

using Pkg

const REPO_ROOT = normpath(joinpath(@__DIR__, ".."))
const AUTORUN = !isdefined(Main, :CESIUMLINK_LIBRARY_ONLY)

"""
    activate_example(dir)

Make the environment at `dir` the active one, and tell it where CesiumLink is. No registry holds
CesiumLink, so the environment cannot resolve until it knows the path to this checkout.
"""
function activate_example(dir)
    Pkg.activate(dir)
    dir == REPO_ROOT || Pkg.develop(path = REPO_ROOT)
    Pkg.instantiate()
    return nothing
end

"""
    hold(server)

Print the address of the viewer, then give `server` back to the session that asked for it. Stop it
with `stop_server`. A program has no session to give it to, so it waits at the keyboard and stops
the server itself.
"""
function hold(server)
    println("open ", viewer_url(server))
    isinteractive() && return server
    println("press Enter to stop")
    readline()
    stop_server(server)
    return nothing
end
