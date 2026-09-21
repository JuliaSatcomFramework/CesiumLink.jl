# The graticule over a bare globe.
#
#     julia examples/graticule.jl
#
# From a session that already has CesiumLink, one line starts the same scene and returns the server:
#
#     include(joinpath(pkgdir(CesiumLink), "examples", "graticule.jl"))
#
# The scene draws nothing of its own: no satellite, no cell, no raster. The Core draws the graticule
# with no module loaded, and this program is there to show it, so the only module it registers is
# the one that draws the two controls in the corner. A dropdown sets the spacing and a checkbox
# turns the labels on and off; each click is answered with one `declare_graticule` call.
#
# Nothing here has a time, so the scene declares no time furniture and pushes no window at all.

# This example has no environment of its own. CesiumLink is its only dependency.
Base.include(@__MODULE__, joinpath(@__DIR__, "setup.jl"))   # hide
AUTORUN && activate_example(REPO_ROOT)   # hide

using CesiumLink

const SPACINGS = [10 => "10°", 15 => "15°", 20 => "20°", 30 => "30°", 45 => "45°"]
const LINE_COLOR = "#1c2b4acc"        # darker and less transparent than the default, so the lines read on any basemap
const LABEL_COLOR = "#0d1626e0"

"""
    declare_scene!(server; spacing = 20, labels = true)

Declare the graticule and the overlay that shows its settings. Both are full statements, so this
one function is what a click is answered with and what the scene opens with.
"""
function declare_scene!(server; spacing = 20, labels = true)
    declare_graticule(server; spacing, labels, color = LINE_COLOR, width = 1.5,
                      label_color = LABEL_COLOR, label_font = "13px system-ui")
    declare_overlay(server, [
        Title("The graticule"; region = :top_left),
        Group([Select("spacing", "Spacing", spacing, SPACINGS),
               Toggle("labels", "Labels", labels)]; region = :bottom_right),
    ])
    return (; spacing, labels)
end

"""
    install_graticule_scene!(server) -> Ref

Build the scene on `server`: the graticule, the two controls and the listener that answers them.
Returns the settings the scene is in, which the listener updates.
"""
function install_graticule_scene!(server)
    register_module!(server, vendored(:ui))
    declare_furniture(server; timeline = false, animation = false, keyframe = false)

    # Two stops. The first shows the whole grid, with both label axes in view; the second stands
    # over the pole, where the parallels close in and the meridians meet, and where the globe hides
    # the far half of every line that runs round the back.
    declare_camera(server,
        Viewpoint(; lon = 10, lat = 25, height = 22_000_000, label = "The whole grid"),
        Viewpoint(; lon = 0, lat = 88, height = 9_000_000, after = 20, duration = 6,
                  label = "Over the pole"))

    state = Ref(declare_scene!(server))
    on_event(server, "ui", "control") do ev, _
        id, value = ev.payload.id, ev.payload.value
        if id == "spacing"
            state[] = declare_scene!(server; spacing = value, state[].labels)
        elseif id == "labels"
            state[] = declare_scene!(server; state[].spacing, labels = value)
        end
        return nothing
    end
    return state
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
