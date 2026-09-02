"""
    MARKERS

The stock marker glyphs a node family may be drawn with. These are the names the package owns and
validates. They are not the whole set a [`Nodes`](@ref) family may name: `marker` also takes an
image of your own, and the name of a sprite a browser module registered.
"""
const MARKERS = (:disc, :square, :diamond, :triangle, :triangle_down, :triangle_right,
                 :triangle_left, :pentagon, :hexagon, :star, :cross, :x)

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

# Where a label sits against the point the offset lands on: across the text, then down it.
const LABEL_ACROSS = (:left, :center, :right)
const LABEL_DOWN = (:top, :center, :bottom, :baseline)

# A range of camera distances, in the two shapes the viewer reads one in: `(near_m, far_m)` for a
# visibility range, and four values for a ramp that runs between the two distances. `form` names the
# shape in the error, since the two four-value fields ramp different things. The near distance must
# stay below the far one. Cesium refuses a display condition whose range does not grow, and a ramp
# over such a range has nothing to interpolate.
near_far(what, form, ::Nothing, n) = nothing
function near_far(what, form, v, n)
    v isa Union{Tuple,AbstractVector} && length(v) == n && all(x -> x isa Real, v) ||
        throw(ArgumentError("$what is $form (got $(repr(v)))"))
    far = n == 2 ? v[2] : v[3]
    v[1] < far || throw(ArgumentError(
        "$what needs its near metres below its far ones (got $(v[1]) and $far)"))
    return Tuple(Float64(x) for x in v)
end

"""
    Label(texts; align = (:left, :bottom), offset = (0, -14), font = "13px sans-serif",
          color = nothing, background = nothing, scale_by_distance = nothing,
          fade_by_distance = nothing, show_between = nothing)

The texts a [`Nodes`](@ref) family writes beside its entities, and the look it writes them in. Pass
one as the `label` keyword of `Nodes`. `texts` holds one string per entity. Every other field covers
the whole family. A label is a style and never a position. A plain `Vector{String}` in that keyword
is this style with every default kept.

Each label follows the node it belongs to. `offset` moves it from there in pixels, `x` to the right
and `y` down, and `align` says which part of the text lands on that point. `(:left, :bottom)` puts
the bottom left corner of the text there, so the text hangs up and to the right of the node.
`(:center, :bottom)` centres the text over the node. `font` is a CSS font string.

`color` fills the glyphs over the black outline every label keeps, and takes the colour forms
`Nodes` takes for `color`. `background` draws a box behind the text in the colour you give it.
Without it the text stands on the scene.

Three fields read the camera distance, in metres. `scale_by_distance` is
`(near_m, near_scale, far_m, far_scale)`, `fade_by_distance` is
`(near_m, near_alpha, far_m, far_alpha)`, and `show_between` is `(near_m, far_m)`, the distances the
text is drawn between. All three need the near metres below the far ones.

```julia
Nodes(:city; position = pos, label = Label(names; align = (:center, :bottom), offset = (0, -18)))
Nodes(:gw; position = gw, label = Label(names; color = "#ffd166", show_between = (0, 5.0e6)))
```
"""
struct Label
    text::Vector{String}
    align::Tuple{Symbol,Symbol}
    # Pixels from the node, `x` to the right and `y` down, which is the browser's screen axis.
    offset::NTuple{2,Float64}
    font::String
    color::Union{Nothing,Array{UInt8}}
    background::Union{Nothing,Array{UInt8}}
    scale_by_distance::Union{Nothing,NTuple{4,Float64}}
    fade_by_distance::Union{Nothing,NTuple{4,Float64}}
    show_between::Union{Nothing,NTuple{2,Float64}}
    # An INNER constructor, for the reason `Nodes` has one: an exact-typed call would otherwise
    # reach the auto-generated one and put an unchecked style on the wire.
    function Label(text, align, offset, font, color, background, scale_by_distance,
                   fade_by_distance, show_between)
        align isa Union{Tuple,AbstractVector} && length(align) == 2 &&
            Symbol(align[1]) in LABEL_ACROSS && Symbol(align[2]) in LABEL_DOWN ||
            throw(ArgumentError("Label.align is one of $LABEL_ACROSS across the text and one of " *
                                "$LABEL_DOWN down it (got $(repr(align)))"))
        offset isa Union{Tuple,AbstractVector} && length(offset) == 2 &&
            all(x -> x isa Real, offset) ||
            throw(ArgumentError("Label.offset is (x_px, y_px) from the node, y downward " *
                                "(got $(repr(offset)))"))
        return new(collect(String, text), (Symbol(align[1]), Symbol(align[2])),
                   NTuple{2,Float64}(offset), String(font), to_colors(color), to_colors(background),
                   near_far("Label.scale_by_distance", "(near_m, near_scale, far_m, far_scale)",
                            scale_by_distance, 4),
                   near_far("Label.fade_by_distance", "(near_m, near_alpha, far_m, far_alpha)",
                            fade_by_distance, 4),
                   near_far("Label.show_between", "(near_m, far_m)", show_between, 2))
    end
end

Label(texts; align = (:left, :bottom), offset = (0, -14), font = "13px sans-serif",
      color = nothing, background = nothing, scale_by_distance = nothing,
      fade_by_distance = nothing, show_between = nothing) =
    Label(texts, align, offset, font, color, background, scale_by_distance, fade_by_distance,
          show_between)

# The strings a `label` knob carries, in whichever of its two forms it arrives.
label_texts(::Nothing) = nothing
label_texts(l::Label) = l.text
label_texts(v) = collect(String, v)

"""
    Nodes(kind; position, color=nothing, size=nothing, marker=:disc, label=nothing,
          show=nothing, scale_by_distance=nothing)

A family of points or stock sprites. `position` is ECEF metres, `3 × N` for a family that stands
still through the window or `3 × N × count` for one whose positions are interpolated across it.

`color`, `size` and `show` follow the array convention and switch at the keyframe crossing:
a lone value covers the family, one value per entity varies across it, and a trailing keyframe
dimension varies it over time. `marker` names what each entity is drawn with: one of `$(MARKERS)` — a
white glyph the per-entity colour tints — an image of your own from [`marker_image`](@ref), an
`assets/<mount>/<file>` path the server serves, or the owner-namespaced name of a sprite a browser
module registered (`"orbits.pulse"`). The same tint multiplies a supplied image, which the default
white leaves as you drew it. `label` is one string per entity, or a [`Label`](@ref) that
carries those strings and says how they are drawn. `scale_by_distance` is
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
    # A stock glyph name, an `assets/<mount>/<file>` path, a `data:` URI, or the name of a
    # sprite a peer module registered in the browser.
    marker::String
    # A plain string array is the default style. A `Label` says what the strings look like.
    label::Union{Nothing,Vector{String},Label}
    scale_by_distance::Union{Nothing,NTuple{4,Float64}}
    # An INNER constructor so the shape checks run for every call form: an exact-typed call would
    # otherwise reach the auto-generated one and put a malformed family on the wire.
    function Nodes(kind, position, color, size, show, marker, label, scale_by_distance)
        pos = convert(Array{Float32}, position)
        ndims(pos) in (2, 3) && Base.size(pos, 1) == 3 ||
            throw(ArgumentError("$kind.position is 3 × N or 3 × N × keyframes (got $(Base.size(pos)))"))
        n = Base.size(pos, 2)
        mk = to_source(marker, "$kind.marker", MARKERS)
        texts = label_texts(label)
        texts === nothing || length(texts) == n ||
            throw(ArgumentError("$kind has $(length(texts)) labels for $n entities"))
        c, s, v = to_colors(color), to_scalars(size), to_codes(show)
        agree_frames(String(kind),
            "position" => (ndims(pos) == 3 ? Base.size(pos, 3) : 0),
            "color" => knob_frames(c, n, 4, "$kind.color"),
            "size" => knob_frames(s, n, 1, "$kind.size"),
            "show" => knob_frames(v, n, 1, "$kind.show"))
        sbd = scale_by_distance === nothing ? nothing : NTuple{4,Float64}(scale_by_distance)
        return new(String(kind), pos, c, s, v, mk, label isa Label ? label : texts, sbd)
    end
end

Nodes(kind; position, color = nothing, size = nothing, marker = :disc, label = nothing,
      show = nothing, scale_by_distance = nothing) =
    Nodes(kind, position, color, size, show, marker, label, scale_by_distance)
