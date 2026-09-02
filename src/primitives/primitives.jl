# The payload vocabulary of the vendored `primitives` module: rendering vocabulary — points, lines,
# footprints, colours, sizes — and never domain vocabulary. What the data means stays in whatever
# package owns it.
#
# One rule governs every appearance knob:
#
#   an array whose trailing dimension is the window's keyframe count varies per keyframe;
#   an array without it is constant for the whole window; a scalar covers the whole family.
#
# Positions blend between keyframes and everything else switches at the crossing. That is the only
# assumption the renderer makes about meaning, and it is the one that makes motion smooth.

module Primitives

# What this vocabulary takes from the rest of the package, and the whole of it.
using ..CesiumLink: rgba8, to_wire_index

using ColorTypes: Colorant
using Base64: base64encode

export Nodes, Edges, Areas, Label, primitives_payload, marker_image

# One file per family, over the knob helpers all three share. `knobs.jl` comes first because every
# family calls it, and `payload.jl` last because it names all three families.
include("knobs.jl")
include("nodes.jl")
include("edges.jl")
include("areas.jl")
include("payload.jl")

end # module Primitives
