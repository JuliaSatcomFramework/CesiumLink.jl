"""
    KnobValue

An appearance knob after normalization: `nothing`, a number covering the whole family, an array over
entities and possibly keyframes, or — for an edge family whose membership itself changes per keyframe
— one array per keyframe.
"""
const KnobValue = Union{Nothing,Float64,AbstractArray}

"""
    STYLES

The stock line materials, in the order their codes travel on the wire.
"""
const STYLES = (:solid, :dashed, :glow)
# --- the array convention ------------------------------------------------------------------------

# Keyframes `a` describes for a family of `n` entities with `item` components each, or 0 when it
# carries no keyframe axis. Throws naming `what` for a size that is none of the allowed forms, so a
# shape mistake fails here rather than as a silent render bug in the browser.
knob_frames(::Nothing, n, item, what) = 0
knob_frames(::Real, n, item, what) = 0

function knob_frames(a::AbstractArray, n, item, what)
    bad() = throw(ArgumentError(
        "$what has size $(size(a)), which is none of the forms for $n entities of $item " *
        "component$(item == 1 ? "" : "s"): a lone value, one per entity, or one per entity per keyframe"))
    # A lone vector of the right length is the family's one value; a per-entity array always carries
    # an entity axis of its own, so the two forms differ in rank even for a family of one.
    item > 1 && ndims(a) == 1 && return length(a) == item ? 0 : bad()
    entity_dims = item > 1 ? 2 : 1
    ndims(a) == entity_dims || ndims(a) == entity_dims + 1 || bad()
    item > 1 && size(a, 1) != item && bad()
    size(a, entity_dims) == n || bad()
    return ndims(a) == entity_dims ? 0 : size(a, ndims(a))
end

# The keyframe count a family describes: every knob that carries one must agree, since they describe
# the same run of frames.
function agree_frames(family, counts::Pair...)
    frames = 0
    for (what, c) in counts
        c == 0 && continue
        frames == 0 && (frames = c; continue)
        c == frames && continue
        throw(ArgumentError("$family: $what describes $c keyframes, another of its arrays $frames"))
    end
    return frames
end

# --- normalizing what a caller passes ------------------------------------------------------------

# A knob of plain numbers: a size, a width, a radius.
to_scalars(::Nothing) = nothing
to_scalars(x::Real) = float(x)
to_scalars(a::AbstractArray{<:Real}) = convert(Array{Float32}, a)

# A knob of small non-negative codes: a visibility mask, a stock material.
to_codes(::Nothing) = nothing
to_codes(x::Bool) = float(x)
to_codes(x::Integer) = float(x)
to_codes(a::AbstractArray{Bool}) = convert(Array{UInt8}, a)
to_codes(a::AbstractArray{<:Integer}) = convert(Array{UInt8}, a)

function style_code(s::Symbol)
    i = findfirst(==(s), STYLES)
    i === nothing && throw(ArgumentError("line style must be one of $(STYLES) (got $(repr(s)))"))
    return UInt8(i - 1)
end

to_styles(::Nothing) = nothing
to_styles(s::Symbol) = float(style_code(s))
to_styles(a::AbstractArray{Symbol}) = UInt8[style_code(s) for s in a]
to_styles(x) = to_codes(x)

# A colour knob, as the three families take it: a lone `(r, g, b, a)` for the family, or a `4 × N`
# byte matrix — the shape [`CesiumLink.rgba`](@ref) produces — optionally with a trailing keyframe axis.
to_colors(::Nothing) = nothing
to_colors(a::AbstractArray{UInt8}) = convert(Array{UInt8}, a)
to_colors(v::AbstractVector{<:Colorant}) = reduce(hcat, [collect(UInt8, rgba8(c)) for c in v];
                                                 init = Matrix{UInt8}(undef, 4, 0))
to_colors(c) = collect(UInt8, rgba8(c))

# One array per keyframe, for a family whose membership changes with them. A knob still covers the
# whole family when it is a lone value, so only a vector *of arrays* is read that way.
is_per_keyframe(x) = x isa AbstractVector && !isempty(x) && all(y -> y isa AbstractArray, x)
per_keyframe(f, x) = is_per_keyframe(x) ? [f(one) for one in x] : f(x)

# Check one knob of an edge family whose connectivity changes per keyframe. Such a family has no
# fixed edge count, so a knob either covers the whole family or arrives as one array per keyframe,
# each sized to that keyframe's edges.
function edge_knob_frames(kind, name, v, item::Integer, counts::AbstractVector)
    v === nothing && return nothing
    if is_per_keyframe(v)
        length(v) == length(counts) || throw(ArgumentError(
            "$kind.$name has $(length(v)) keyframes, its connectivity $(length(counts))"))
        for (k, one) in enumerate(v)
            knob_frames(one, counts[k], item, "$kind.$name at keyframe $k")
        end
    elseif v isa AbstractArray && !(item > 1 && ndims(v) == 1 && length(v) == item)
        throw(ArgumentError("$kind.$name varies per edge, so it travels as one array per keyframe, " *
                            "like the connectivity it is sized against"))
    end
    return nothing
end

# One `2 × M` block of 1-based index pairs, converted to the 0-based form the wire carries.
function to_pairs(kind, m)
    a = convert(Array, m)
    ndims(a) == 2 && Base.size(a, 1) == 2 ||
        throw(ArgumentError("$kind.pairs is a 2 × M matrix of index pairs (got $(Base.size(a)))"))
    all(≥(1), a) || throw(ArgumentError("$kind.pairs holds 1-based node indices"))
    return to_wire_index.(UInt32.(a))
end
