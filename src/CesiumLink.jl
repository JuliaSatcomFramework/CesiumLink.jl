"""
    CesiumLink

Drive the CesiumLink browser client from Julia over a WebSocket.

Serve the viewer with [`start_server`](@ref), declare the ES modules it loads with
[`register_module!`](@ref), and broadcast time-varying scene data with [`push_window`](@ref) — one
message per run of keyframes, carrying every module's payload for those frames.

A session can be recorded with [`record!`](@ref) and played back later with [`replay`](@ref), which
drives a real viewer through it with whatever produced the data absent.
"""
module CesiumLink

using HTTP, JSON, Base64, CodecZlib
# Qualified: `connect` and `localhost` are names too general to put in this namespace. One call uses
# them — the probe that tells a live discovery file from a dead one.
import Sockets
# The built viewer ships as a lazy artifact, which `viewer_dist` falls back to. `@artifact_str`
# reaches a lazy entry only when this package loads `LazyArtifacts`.
using LazyArtifacts
using ColorTypes: Colorant, red, green, blue, alpha
# Qualified rather than brought in: `Dates` stamps one field of the discovery file, and `format` and
# `now` are names too general to put in this namespace.
import Dates

# Wire encoding, scene payloads, message frames, the server, and session record/replay.

include("codec.jl")
include("ellipsoids.jl")
include("colormap.jl")
include("primitives/primitives.jl")
include("models.jl")
include("heatmap.jl")
include("messages.jl")
include("events.jl")
include("server.jl")
include("static.jl")
include("artifacts.jl")
include("discovery.jl")
include("editor.jl")
include("imagery.jl")
include("geodesy.jl")
include("recorder.jl")
include("furniture.jl")
include("camera.jl")
include("ui.jl")

# Each vendored module's payload vocabulary is a submodule. Its names come back up here, and the
# `export` list below carries them on, so a scene reaches `Nodes` and `Title` with a plain
# `using CesiumLink`. `kind` and `payload` are the interface a downstream control implements, and
# `watch_float_rects!` is the listener `start_server` registers. None of the three is exported, so
# all three are named here. `ModelFamilies` is the `models` module's vocabulary under a name of its
# own: a namespace called `Models` would shadow the family called `Models`.
using .Primitives, .ModelFamilies, .Heatmap, .UI
using .UI: kind, payload, watch_float_rects!

# `Ellipsoids` is a table of bodies a scene reads once, and not a vocabulary it calls throughout, so
# only the namespace is exported. `Ellipsoids.MOON` says the name is a body; a bare `MOON` does not.
export Ellipsoids
export start_server, stop_server, ModuleEntry, register_module!, ecef, geodetic
export Imagery
export viewer_url, bound_port, discovery_dir
export send_command, send_reply, push_window
export declare_furniture, declare_regions
export Viewpoint, declare_camera, declare_follow
export on_event, on_pointer, off_event, command!, tooltip!, Command, Reply
export serve_scene!, install_scene!
export AbstractControl, Title, Legend, Toggle, Select, Group, declare_overlay
export Floating, Screen, Entity, World, declare_floating
export Nodes, Edges, Areas, primitives_payload, marker_image, rgba, vendored, viewer_dist
export Models, models_payload
export Raster, rgba_grid, heatmap_index, heatmap_payload
export record!, stop_recording!, replay

end # module CesiumLink
