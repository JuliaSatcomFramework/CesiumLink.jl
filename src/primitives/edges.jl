"""
    Edges(kind; from, to, pairs, color=nothing, style=nothing, width=nothing, show=nothing,
          dash_length=nothing)

Lines joining two families by index. `from` and `to` name those families — each may be [`Nodes`](@ref)
or [`CesiumLink.Primitives.Areas`](@ref), a node contributing its position and an area its footprint centre, so a link from
a ground cell to a satellite is one family over one of each. `pairs` is a `2 × M` matrix of
**1-based** `(from, to)` index pairs — or a vector of one such matrix per keyframe, which is how
connectivity that changes over the window is expressed.

`style` is one of $(STYLES), per family or per edge, so one family draws both the glowing active form
of a link and the idle solid one as two batches. `width` is pixels and `dash_length` the pixels of
one dash period. Where `pairs` changes per keyframe the per-edge knobs do too, as a vector of one
array per keyframe sized to that keyframe's edges.

**An edge's colour is its batch key.** A line's colour lives in its material, and the renderer emits
one draw command per run of lines sharing one, so a family costs one draw command per distinct
`(style, colour, dash_length)` it resolves to. Per-edge colour is therefore for a handful of
appearances — active and idle, served and unserved — and not for a continuous ramp: colouring a
thousand edges through [`CesiumLink.rgba`](@ref) draws a correct picture through a thousand draw commands.
`width` and `show` are batch-table attributes and vary per edge for free. On [`Nodes`](@ref) and
[`CesiumLink.Primitives.Areas`](@ref) colour is a per-entity attribute and a ramp costs nothing.

`show` masks per edge exactly as it does on [`Nodes`](@ref), and **reads only this family's own**: an
edge whose endpoint is masked still draws, hanging off an invisible end. Hiding a cell and the links
into it is two masks, one on each family.

Masking is also the cheap way to stop drawing an edge, and the difference is large. `pairs`, `color`
and `style` are what a line is built from, so a family varying any of them per keyframe is torn down
and rebuilt at every crossing; `width` and `show` are written in place onto lines that stand. A
family whose connectivity is a fixed mesh with changing traffic therefore costs far less expressed as
one `pairs` under a mask than as one `pairs` per keyframe.

```julia
Edges(:isl; from = :sat, to = :sat, pairs = isl, style = active_style, width = active_width)
Edges(:feeder; from = :gw, to = :sat, pairs = feeders, style = :dashed, dash_length = 16)
```
"""
struct Edges
    # A family name and the two endpoint family names, all invented by the scene author, so all
    # `String`s (ADR-0029).
    kind::String
    from::String
    to::String
    # 0-based, as the wire carries them: the module indexes the node families' own arrays with these.
    pairs::Union{Matrix{UInt32},Vector{Matrix{UInt32}}}
    color::KnobValue
    # A material code per edge. `styles` names what a code beyond the stock ones draws, and is
    # `nothing` for a family drawn in stock materials alone.
    style::KnobValue
    styles::Union{Nothing,Vector{Union{Nothing,String}}}
    width::KnobValue
    # Per-edge visibility. Independent of the endpoint families' own masks.
    show::KnobValue
    dash_length::Union{Nothing,Float64}
    # An INNER constructor, for the same reason as `Nodes`.
    function Edges(kind, from, to, pairs, color, style, width, show, dash_length)
        ragged = is_per_keyframe(pairs)
        p = ragged ? [to_pairs(kind, m) for m in pairs] : to_pairs(kind, pairs)
        c = per_keyframe(to_colors, color)
        table = new_styles()
        st = per_keyframe(x -> to_styles(x, table, "$kind.style"), style)
        wd = per_keyframe(to_scalars, width)
        sh = per_keyframe(to_codes, show)
        knobs = ("color" => (c, 4), "style" => (st, 1), "width" => (wd, 1), "show" => (sh, 1))
        if ragged
            counts = [Base.size(m, 2) for m in p]
            for (name, (v, item)) in knobs
                edge_knob_frames(kind, name, v, item, counts)
            end
        else
            m = Base.size(p, 2)
            agree_frames(String(kind),
                (name => knob_frames(v, m, item, "$kind.$name") for (name, (v, item)) in knobs)...)
        end
        return new(String(kind), String(from), String(to), p, c, st,
                   length(table) > length(STYLES) ? table : nothing, wd, sh,
                   dash_length === nothing ? nothing : float(dash_length))
    end
end

Edges(kind; from, to, pairs, color = nothing, style = nothing, width = nothing, show = nothing,
      dash_length = nothing) =
    Edges(kind, from, to, pairs, color, style, width, show, dash_length)
