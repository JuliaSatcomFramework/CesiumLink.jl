# The payload vocabulary of the vendored `models` module: one glTF model per entity of a node family,
# turned by a reference frame and an attitude. Where a model stands belongs to the family it is
# anchored to, and what it looks like belongs to the file — so this vocabulary names neither a
# position nor a colour.
#
# The namespace is `ModelFamilies` and not `Models`, because a module and a type inside it cannot
# share a name: `CesiumLink.Models` would then resolve to the namespace and the family would be
# unreachable. `CesiumLink` re-exports `Models` and `models_payload`, which is how a scene reaches
# both.

module ModelFamilies

# What this vocabulary takes from the rest of the package, and the whole of it. The knob helpers are
# the `primitives` vocabulary's own: a model family reads the array convention every other family
# reads, and there is one implementation of it.
using ..Primitives: KnobValue, agree_frames, knob_frames, sent, to_codes, to_scalars

export Models, models_payload

"""
    FRAMES

The reference frames a model family may be turned in. Each is built from the position the anchor
family carries, and an `orientation` turns the model inside it.
"""
const FRAMES = (:ecef, :enu, :nadir, :velocity)

# The same-origin path a payload names an asset by: `assets/<name>/<rest>`, `<name>` being a mount
# the server was started with. Only the shape is checked here. Whether a mount of that name answers
# is the browser's question, because it is the host that holds the map of mounts for its own origin —
# and a scene may name a file the server gained after this family was built.
function to_uri(kind, uri)
    s = String(uri)
    occursin(r"^assets/[^/]+/.+$", s) || throw(ArgumentError(
        "$kind.uri is a same-origin path shaped `assets/<name>/<rest>` (got $(repr(s))). " *
        "`start_server(; assets = Dict(\"models\" => \"/data/glb\"))` mounts a folder as " *
        "`<name>`, and every file under it answers on that path."))
    return s
end

# The camera distance the family draws in, as two metre distances. Near may be zero — a model drawn
# from the surface up is the common case — and the far distance is what keeps the family's cost at
# zero for the rest of the session.
function to_range(kind, range)
    r = collect(Float64, range)
    length(r) == 2 && all(isfinite, r) && r[1] ≥ 0 && r[2] > r[1] || throw(ArgumentError(
        "$kind.range is (near_m, far_m), the camera distance the model draws in: two finite metre " *
        "distances, neither negative, near before far (got $(repr(range)))"))
    return (r[1], r[2])
end

to_frame(kind, frame) = Symbol(frame) in FRAMES ? Symbol(frame) : throw(ArgumentError(
    "$kind.frame is one of $(FRAMES) (got $(repr(frame)))"))

# The width in pixels the model is never drawn below. Zero is the same as declaring none and is
# refused as a typo for it: a floor of no pixels is a knob that reads as set and does nothing.
to_pixels(kind, ::Nothing) = nothing
function to_pixels(kind, px)
    p = Float64(px)
    isfinite(p) && p > 0 || throw(ArgumentError(
        "$kind.minimum_pixel_size is the width in pixels the model is never drawn below, so it is " *
        "a positive number (got $(repr(px)))"))
    return p
end

# How many entities a knob describes, or 0 where it describes none: nothing, a lone value, or one
# quaternion covering the whole family.
entity_count(::Nothing, item) = 0
entity_count(::Real, item) = 0
entity_count(a::AbstractArray, item) =
    item > 1 && ndims(a) == 1 ? 0 : Base.size(a, item > 1 ? 2 : 1)

# The entity count a family covers. A model family carries no positions, so nothing here knows how
# big the anchor family is — the browser reads that from the anchor itself. What is checkable here is
# that this family's own arrays agree with each other about it.
function agree_entities(kind, counts::Pair...)
    n = 0
    for (what, c) in counts
        c == 0 && continue
        n == 0 && (n = c; continue)
        c == n && continue
        throw(ArgumentError("$kind: $what describes $c entities, another of its arrays $n"))
    end
    return n
end

"""
    Models(kind; of, uri, range, frame=:ecef, orientation=nothing, axes=nothing, scale=nothing,
           minimum_pixel_size=nothing,
           show=nothing)

A family of glTF models, one per entity of the [`CesiumLink.Primitives.Nodes`](@ref) family `of`
names. It carries no positions of its own: a model stands where its anchor stands, and a click on it
reports that entity in the `primitives` namespace, as though no model were there.

**A model draws through commands of its own, and a node family does not.** A node family of any size
is one draw command; one model in view measured **5**, and one entity carrying an ellipsoid, a model
and a label measured **9**. Forty modelled satellites at mission zoom cost forty times that.

**`range` is what keeps the cost at zero.** It is `(near_m, far_m)`, the camera distance the model
draws in, and outside it the family draws nothing at all — **0** draw commands, measured. It has no
default: the distance beyond which a model is a smudge is the author's to choose, and choosing it is
the whole affordability of the family.

`uri` is a same-origin path shaped `assets/<name>/<rest>`, where `<name>` is a folder
[`CesiumLink.start_server`](@ref) was given — `start_server(; assets = Dict("models" => "/data/glb"))`
serves `/data/glb/sat.glb` as `assets/models/sat.glb`. The mount named here is resolved in the
browser, which is the only place that holds the map for its own host.

`frame` is one of $(FRAMES), the reference frame the model is turned in, built from the position the
anchor carries: `:enu` is east-north-up, `:nadir` turns that to point +Z at the centre of the body,
`:velocity` follows the direction the anchor moves, and `:ecef` is the fixed frame itself.
`orientation` turns the model inside that frame, as quaternions `(x, y, z, w)` — `4 × N` for a family
whose attitude stands through the window, `4 × N × count` for one that varies across it. A family in
the `:velocity` frame with no quaternion needs no attitude in Julia at all; one in `:ecef` with a
quaternion is the fully explicit case.

`axes` is one fixed `(heading, pitch, roll)` in degrees, applied last, for the file's own convention:
Cesium takes a model's +X as forward and most files disagree. `scale` multiplies the model's own
size, and `minimum_pixel_size` is the width in pixels below which the model is not allowed to shrink.

**A model at mission range is smaller than a pixel.** A spacecraft a few metres across, seen from a
camera twelve thousand kilometres up, covers nothing at all, so `scale` alone forces a choice between
a model nobody can see and one the size of a country. `minimum_pixel_size` removes the choice: the
model keeps its true `scale` and is drawn at least that many pixels wide however far away it is, so
it reads as an icon at mission zoom and becomes true-scale as the camera flies in. `show` masks per entity as it does on [`CesiumLink.Primitives.Nodes`](@ref), and the anchor's
own mask applies as well — a hidden node draws no model.

A scene that draws models declares **both** modules, in either order, because `of` names a family in
the `primitives` payload and this module alone draws nothing:

```julia
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:models))

Models(:sat_body; of = :sat, uri = "assets/models/sat.glb", range = (0, 2e6),
       frame = :enu, orientation = q, axes = (90, 0, 0), scale = 1e6)
```
"""
struct Models
    # A family name and the name of the family it anchors to, both invented by the scene author, so
    # both `String`s (ADR-0029). `frame` names one of `FRAMES`, which is CesiumLink's own set.
    kind::String
    # The `primitives` family this one is anchored to. Not checked against a payload here: the two
    # payloads may be built in either order, and only the viewer knows what is on screen.
    of::String
    uri::String
    # (near_m, far_m): outside it the family draws nothing.
    range::NTuple{2,Float64}
    frame::Symbol
    orientation::KnobValue
    axes::Union{Nothing,NTuple{3,Float64}}
    scale::Union{Nothing,Float64}
    # The width in pixels the model is never drawn below, whatever the distance.
    minimum_pixel_size::Union{Nothing,Float64}
    # Per-entity visibility, read together with the anchor family's own mask.
    show::KnobValue
    # An INNER constructor so the shape checks run for every call form: an exact-typed call would
    # otherwise reach the auto-generated one and put a malformed family on the wire.
    function Models(kind, of, uri, range, frame, orientation, axes, scale, minimum_pixel_size,
                    show)
        q, v = to_scalars(orientation), to_codes(show)
        q isa Real && throw(ArgumentError(
            "$kind.orientation is a quaternion, four numbers per entity, so it is an array of at " *
            "least four (got $(repr(orientation)))"))
        n = agree_entities(String(kind),
            "orientation" => entity_count(q, 4), "show" => entity_count(v, 1))
        agree_frames(String(kind),
            "orientation" => knob_frames(q, n, 4, "$kind.orientation"),
            "show" => knob_frames(v, n, 1, "$kind.show"))
        return new(String(kind), String(of), to_uri(kind, uri), to_range(kind, range),
                   to_frame(kind, frame), q,
                   axes === nothing ? nothing : NTuple{3,Float64}(axes),
                   scale === nothing ? nothing : Float64(scale),
                   to_pixels(kind, minimum_pixel_size), v)
    end
end

Models(kind; of, uri, range, frame = :ecef, orientation = nothing, axes = nothing, scale = nothing,
       minimum_pixel_size = nothing, show = nothing) =
    Models(kind, of, uri, range, frame, orientation, axes, scale, minimum_pixel_size, show)

"""
    models_payload(families...) -> NamedTuple

The `models` module's payload for one window, out of any number of [`Models`](@ref) families. Pass it to [`CesiumLink.push_window`](@ref) addressed to `:models` — an envelope of its
own, beside the `primitives` payload carrying the families it anchors to and never inside it.

```julia
push_window(server, Dict(
                :primitives => primitives_payload(Nodes(:sat; position = pos, size = 8)),
                :models => models_payload(
                    Models(:sat_body; of = :sat, uri = "assets/models/sat.glb",
                           range = (0, 2e6), frame = :enu, orientation = q)));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```
"""
function models_payload(families::Models...)
    seen = Set{String}()
    for f in families
        f.kind in seen &&
            throw(ArgumentError("two model families are both named $(repr(f.kind))"))
        push!(seen, f.kind)
    end
    return (; models = [lower(f) for f in families])
end

# `range` and `axes` stay tuples: the module reads plain numbers there, not encoded arrays. A knob
# the family did not set is omitted rather than sent as null, so the module's "was this delivered?"
# question is answered by the key's presence.
lower(f::Models) = (; f.kind, f.of, uri = f.uri, range = f.range, frame = String(f.frame),
                    sent(; f.orientation, f.axes, f.scale,
                         minimumPixelSize = f.minimum_pixel_size, f.show)...)

end # module ModelFamilies
