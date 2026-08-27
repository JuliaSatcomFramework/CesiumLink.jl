const Family = Union{Nodes,Edges,Areas}

"""
    primitives_payload(families...) -> NamedTuple

The `primitives` module's payload for one window, out of any mix of [`Nodes`](@ref), [`Edges`](@ref)
and [`CesiumLink.Primitives.Areas`](@ref) families. Pass it to [`CesiumLink.push_window`](@ref) addressed to `:primitives`; the
keyframe count travels with the window, not with the payload, because the transport does not
interpret a payload and so cannot count the frames in one.

```julia
push_window(server, Dict(:primitives => primitives_payload(
                Nodes(:sat; position = pos, size = 12),
                Nodes(:user; position = users, size = 9, label = names),
                Edges(:link; from = :user, to = :sat, pairs = links, width = 1.5)));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```
"""
function primitives_payload(families::Family...)
    kinds = Dict{DataType,Set{String}}()
    for f in families
        seen = get!(Set{String}, kinds, typeof(f))
        f.kind in seen &&
            throw(ArgumentError("two $(nameof(typeof(f))) families are both named $(repr(f.kind))"))
        push!(seen, f.kind)
    end
    check_endpoints(families)
    payload = NamedTuple()
    nodes = [lower(f) for f in families if f isa Nodes]
    edges = [lower(f) for f in families if f isa Edges]
    areas = [lower(f) for f in families if f isa Areas]
    isempty(nodes) || (payload = (; payload..., nodes))
    isempty(edges) || (payload = (; payload..., edges))
    isempty(areas) || (payload = (; payload..., areas))
    return payload
end

"""
    endpoint_count(f) -> Union{Nothing,Int}

How many entities a family offers an edge to hang off, or `nothing` where this window does not say.
A node family always states it; an area family states it only on the window carrying its geometry,
since an append addresses standing footprints and restates neither their centres nor their number.
"""
endpoint_count(f::Nodes) = Base.size(f.position, 2)
endpoint_count(f::Areas) = f.boundary !== nothing ? length(f.boundary) :
                           f.center === nothing ? nothing : Base.size(f.center, 2)

# Every edge family hangs off two endpoint families, either of which may be `Nodes` or `Areas`. Both
# must be in this payload: the module resolves an endpoint by name against what the window delivers,
# so a name nothing carries would reach the viewer as a family that silently draws nothing. Where
# the endpoint states its entity count, the indices are checked against it too — an index past the
# end is dropped by the renderer rather than drawn wrongly, which is the same silence one step later.
function check_endpoints(families)
    endpoints = Dict{String,Union{Nothing,Int}}()
    for f in families
        f isa Edges && continue
        endpoints[f.kind] = endpoint_count(f)
    end
    for f in families
        f isa Edges || continue
        blocks = f.pairs isa AbstractVector ? f.pairs : [f.pairs]
        for (role, kind, row) in ((:from, f.from, 1), (:to, f.to, 2))
            haskey(endpoints, kind) || throw(ArgumentError(
                "$(f.kind).$role names $(repr(kind)), which this payload carries no Nodes or " *
                "Areas family for"))
            n = endpoints[kind]
            n === nothing && continue
            for m in blocks
                isempty(m) && continue
                # The pairs are already 0-based here, so the last valid index is `n - 1`.
                maximum(@view m[row, :]) < n || throw(ArgumentError(
                    "$(f.kind).$role indexes past the $n entities of $(repr(kind))"))
            end
        end
    end
    return nothing
end

# What the module reads. A knob the family did not set is omitted rather than sent as null, so the
# module's "was this delivered?" question is answered by the key's presence.
sent(; kw...) = NamedTuple(k => v for (k, v) in kw if v !== nothing)

# `scale_by_distance` stays a tuple: the module reads four plain numbers there, not an encoded array.
lower(f::Nodes) = (; f.kind, position = f.position, marker = f.marker,
                   sent(; f.color, f.size, f.show, f.label,
                        scaleByDistance = f.scale_by_distance)...)

lower(f::Edges) = (; f.kind, f.from, f.to, pairs = f.pairs,
                   sent(; f.color, f.style, styles = f.styles, f.width, f.show,
                        dashLength = f.dash_length)...)

lower(f::Areas) = (; f.kind, geometry(f)..., sent(; f.color, f.outline, f.show)...)

# The geometry keys travel together: a window carrying neither centres nor a boundary describes no
# geometry at all, and the standing footprints it addresses already carry their shape. A boundary
# travels with the extents derived from it, which is where the module reads each region's span.
geometry(f::Areas) =
    f.boundary !== nothing ?
        (; boundary = f.boundary, extent = f.extent, heightM = f.height_m,
           sent(; f.drape, meshDeg = f.mesh_deg)...) :
    f.center === nothing ? (;) :
    (; center = f.center, sides = f.sides, heightM = f.height_m,
       sent(; f.radius, f.drape, meshDeg = f.mesh_deg)...)
