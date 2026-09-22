# The graticule over a bare globe.
#
#     julia examples/graticule.jl
#
# From a session that already has CesiumLink, one line starts the same scene and returns the server:
#
#     include(joinpath(pkgdir(CesiumLink), "examples", "graticule.jl"))
#
# The scene draws nothing of its own: no satellite, no cell, no raster, and no module is registered.
# The Core draws the graticule with no module loaded, and this program is there to show it.
#
# Nothing here has a time, so the scene declares no time furniture and pushes no window at all.

# This example has no environment of its own. CesiumLink is its only dependency.
Base.include(@__MODULE__, joinpath(@__DIR__, "setup.jl"))   # hide
AUTORUN && activate_example(REPO_ROOT)   # hide

using CesiumLink

"""
    install_graticule_scene!(server)

Declare the scene on `server`: the graticule, the furniture and the camera tour.
"""
function install_graticule_scene!(server)
    declare_furniture(server; timeline = false, animation = false, keyframe = false)

    # Darker and less transparent than the default, so the lines read on any basemap.
    declare_graticule(server; spacing = (20, 10), color = "#1c2b4acc",
                      label_color = "#0d1626e0", label_font = "13px system-ui")

    # Three stops. The first shows the whole grid, with both label axes in view. The second stands
    # over the pole, where the parallels close in and the meridians meet, and where the globe hides
    # the far half of every line that runs round the back. The third comes close enough to see the
    # lines sit on the coastlines under them.
    declare_camera(server,
        Viewpoint(; lon = 10, lat = 25, height = 22_000_000, label = "The whole grid"),
        Viewpoint(; lon = 0, lat = 88, height = 9_000_000, after = 8, duration = 6,
                  label = "Over the pole"),
        Viewpoint(; west = -12, south = 34, east = 22, north = 60, after = 20, duration = 6,
                  label = "Close over Europe"))
    return nothing
end

"""
    run_example()

Start a server for this scene and print the address of the viewer. A session gets the server back,
to stop with `stop_server`.
"""
function run_example()
    server = start_server()
    install_graticule_scene!(server)
    return hold(server)
end

AUTORUN && run_example()   # hide
