"""
    MARKERS

The stock marker glyphs a node family may be drawn with.
"""
const MARKERS = (:disc, :star, :square, :triangle)

"""
    marker_image(path) -> String

Read an image file and return the `data:` URI a [`Nodes`](@ref) family takes for `marker`. PNG and
SVG are the two formats every browser draws; the MIME type comes from the extension.

Give the image a square canvas. A billboard reads `size` for its width and its height together, so a
wide image is drawn squeezed.

Use a `data:` URI and not a link to an image on a server. The viewer runs under a policy that admits
the first and refuses the second, and a refused image draws nothing at all.

```julia
Nodes(:sat; position = pos, marker = marker_image("assets/satellite.png"), size = 20)
```
"""
function marker_image(path)
    ext = lowercase(splitext(String(path))[2])
    mime = ext == ".svg" ? "image/svg+xml" :
           ext == ".png" ? "image/png" :
           ext in (".jpg", ".jpeg") ? "image/jpeg" :
           ext == ".webp" ? "image/webp" :
           throw(ArgumentError("marker_image draws .png, .svg, .jpg or .webp (got $(repr(ext)))"))
    return "data:$mime;base64," * base64encode(read(path))
end

# What a node family draws its entities with: a stock glyph by name, or a supplied image as the
# `data:` URI [`marker_image`](@ref) builds. Only that one URI form is accepted, because the viewer
# runs under a policy that refuses an image fetched from a server and draws nothing in its place.
to_marker(m::Symbol) = m in MARKERS ? String(m) :
    throw(ArgumentError("marker must be one of $(MARKERS), or an image from `marker_image` " *
                        "(got $(repr(m)))"))
to_marker(m::AbstractString) = startswith(m, "data:") ? String(m) :
    throw(ArgumentError("a marker image is a `data:` URI, which `marker_image` builds from a file " *
                        "(got $(repr(first(m, 32))))"))

"""
    Nodes(kind; position, color=nothing, size=nothing, marker=:disc, label=nothing,
          show=nothing, scale_by_distance=nothing)

A family of points or stock sprites. `position` is ECEF metres, `3 × N` for a family that stands
still through the window or `3 × N × count` for one whose positions are interpolated across it.

`color`, `size` and `show` follow the array convention and switch at the keyframe crossing:
a lone value covers the family, one value per entity varies across it, and a trailing keyframe
dimension varies it over time. `marker` is one of $(MARKERS) — a white glyph the per-entity colour
tints — or an image of your own from [`marker_image`](@ref), which the same tint multiplies and the
default white leaves as you drew it. `label` is one string per entity. `scale_by_distance` is
`(near_m, near_scale, far_m, far_scale)`, so markers stay legible close up and shrink when the whole
scene is in view.

**`show` is a per-entity visibility mask** — zero hides an entity, any other value draws it, and an
absent `show` draws the whole family. A `BitVector` of a predicate is the shape it is for. It is the
only knob that is not about appearance, and it exists because a family's membership is fixed for a
window's life: a keyframe changes what the entities look like, never how many there are. Masking is
how the drawn set varies within one window, and it costs one batch-table write — the same class as a
recolour, with no rebuild.

Two consequences of masking rather than dropping. A masked entity keeps its index, so an anchor or an
[`Edges`](@ref) pair naming it stays valid. And it is **not pickable** while hidden: nothing is drawn
for it, so nothing under the pointer reports it — a mask is not a dimming.

```julia
Nodes(:sat; position = pos, size = 12, color = rgba(CMAP, throughput; range = (0, 12)))
Nodes(:gw; position = gw_ecef, marker = :star, color = (200, 120, 255, 255))
```
"""
struct Nodes
    # A family name the scene author invents, so a `String` on both sides of the wire (ADR-0029):
    # a pointer event reports it back as `ev.entity.kind`.
    kind::String
    position::Array{Float32}
    color::KnobValue
    size::KnobValue
    # Per-entity visibility: zero hides, anything else draws, `nothing` draws the family.
    show::KnobValue
    # A stock glyph name, or the `data:` URI of a supplied image.
    marker::String
    label::Union{Nothing,Vector{String}}
    scale_by_distance::Union{Nothing,NTuple{4,Float64}}
    # An INNER constructor so the shape checks run for every call form: an exact-typed call would
    # otherwise reach the auto-generated one and put a malformed family on the wire.
    function Nodes(kind, position, color, size, show, marker, label, scale_by_distance)
        pos = convert(Array{Float32}, position)
        ndims(pos) in (2, 3) && Base.size(pos, 1) == 3 ||
            throw(ArgumentError("$kind.position is 3 × N or 3 × N × keyframes (got $(Base.size(pos)))"))
        n = Base.size(pos, 2)
        mk = to_marker(marker)
        label === nothing || length(label) == n ||
            throw(ArgumentError("$kind has $(length(label)) labels for $n entities"))
        c, s, v = to_colors(color), to_scalars(size), to_codes(show)
        agree_frames(String(kind),
            "position" => (ndims(pos) == 3 ? Base.size(pos, 3) : 0),
            "color" => knob_frames(c, n, 4, "$kind.color"),
            "size" => knob_frames(s, n, 1, "$kind.size"),
            "show" => knob_frames(v, n, 1, "$kind.show"))
        sbd = scale_by_distance === nothing ? nothing : NTuple{4,Float64}(scale_by_distance)
        return new(String(kind), pos, c, s, v, mk,
                   label === nothing ? nothing : collect(String, label), sbd)
    end
end

Nodes(kind; position, color = nothing, size = nothing, marker = :disc, label = nothing,
      show = nothing, scale_by_distance = nothing) =
    Nodes(kind, position, color, size, show, marker, label, scale_by_distance)
