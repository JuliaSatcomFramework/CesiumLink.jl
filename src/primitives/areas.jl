"""
    Areas(kind; center=nothing, boundary=nothing, radius=nothing, sides=nothing, height_m=0,
          drape=nothing, color=nothing, outline=nothing, show=nothing)

Ground footprints, either computed from a centre or given vertex by vertex. `center` is `2 × N`
degrees of longitude and latitude, `radius` metres (one for the family or one per entity), and
`sides` the corner count — 6 is a hexagon, 64 reads as a circle, and a footprint computed without
one has 6. `height_m` lifts the fill off the imagery it would otherwise z-fight with, one for the
family or one per entity.

`boundary` draws the footprints from vertices instead, one entry per region. An entry is either a
`2 × V` matrix of degrees — one ring — or a vector of such matrices, **the outer ring first and every
ring after it a hole**. A ring is open: do not repeat the first vertex as the last, since the last
vertex joins the first. `boundary` replaces `center`, so `radius` and `sides` have nothing to size or
count and are rejected rather than ignored.

Every ring is checked here, because nothing downstream checks one. The browser triangulates whatever
it is given and reports nothing about a hole that lies outside its outer ring — it draws garbage
instead. So a ring must be `2 × V` with `V ≥ 3` and finite coordinates, and a hole's bounding box
must lie inside the outer ring's. That catches rings passed in the wrong order, which is the mistake
that is otherwise silent. Two holes that overlap each other are not caught: full topological
validation belongs to a GIS library.

A region in two pieces, and a region crossing ±180°, are one family entry per piece. Split them
before you call, and map the pieces back to one region when you write the tooltip.

Write a polar cap as the parallel alone, with no vertex at the pole: the pole is a point inside a
cap, not a corner of one. The constructor rejects a cap written as a box, because two vertices of
such a box are co-located.

A large footprint follows the curve of the globe, and a small one does not. A polygon drawn from its
vertices alone is a flat plane that cuts through the globe, so its middle sinks below the surface
and its edges float above it. The sag is `θ/8` of the span, for an angular span `θ`. The angle alone
decides how wrong the footprint looks, and the size of the region does not:

| Span | Angle | Sag |
|:--|:--|:--|
| 2 km — a cell | 0.018° | 8 cm |
| 56 km | 0.5° | 61 m |
| 111 km | 1° | 243 m |
| 1000 km — a country | 9° | 19.6 km, buried |

So the module measures each region and follows the ellipsoid for the ones that span enough to show
it. `drape` overrides that measurement for the whole family: `true` makes every footprint follow the
globe, `false` makes every one cut through it. A footprint that follows the globe takes `height_m`
for its whole surface, which is the only height it has anyway.

`drape` describes geometry, so it rides the same window as `center` or `boundary`. `height_m` does
too: it is a vertex coordinate, not an attribute, so a vector of one height per entity is read when
the footprints are tessellated. Give a family many heights this way rather than one family per
height, and expect a changed vector to re-tessellate exactly as a changed `center` does.

`color`, `outline` and `show` follow the array convention and switch at the keyframe crossing: a lone
value covers the family, one value per entity varies across it, and a trailing keyframe dimension
varies it over time. So one footprint may be ringed differently from the rest by passing a `4 × N`
outline. An absent `outline` draws no outline at all.

`show` masks per entity exactly as it does on [`Nodes`](@ref), and hides an area's fill and its
outline together. It is what an appending window has instead of a shorter `center`: the footprints
stand for the window's life, so a cell that stops being served is masked, never dropped.

**An area outline is one pixel wide**, and there is no width to set: polygon-outline geometry takes
its width from the WebGL maximum aliased line width, which is 1 on every implementation this runs on,
and a render state asking for more is rejected. A thick ring is a second `Areas` family at a slightly
larger radius, drawn beneath the first.

The geometry is tessellated once and recoloured in place, so **it rides only a replacing window**: a
window that omits both `center` and `boundary` leaves the standing footprints alone and changes only
what this family says about their colour and visibility, which is what an append is for.

Re-sending the same geometry on a window that does not need to is **free, and that is a guarantee
rather than luck**: the module digests what the footprints were built from and re-tessellates only
when the digest changes. A scene may build one payload and send it on every window without writing a
second geometry-less variant.

```julia
Areas(:cell; center = cell_lonlat, radius = 12_000, sides = 6, height_m = 3000,
      color = rgba(CMAP, satisfaction), outline = "#000000d9", show = served)
Areas(:region; boundary = [country_ring, [lake_outer, lake_hole]],
      color = rgba(CMAP, demand), outline = "#000000d9")
```
"""
struct Areas
    # A family name the scene author invents, so a `String` like every other one (ADR-0029).
    kind::String
    center::Union{Nothing,Matrix{Float64}}
    # One entry per region, the outer ring first and every ring after it a hole.
    boundary::Union{Nothing,Vector{Vector{Matrix{Float64}}}}
    # `4 × N` of (lon_min, lon_max, lat_min, lat_max), one column per region's outer ring.
    extent::Union{Nothing,Matrix{Float64}}
    radius::KnobValue
    sides::Int
    height_m::KnobValue
    # Whether the footprints follow the ellipsoid; `nothing` leaves it to the span they cover.
    drape::Union{Nothing,Bool}
    color::KnobValue
    outline::KnobValue
    # Per-entity visibility; hides fill and outline together.
    show::KnobValue
    # An INNER constructor, for the same reason as `Nodes`.
    function Areas(kind, center, boundary, radius, sides, height_m, drape, color, outline, show)
        ctr = center === nothing ? nothing : convert(Matrix{Float64}, center)
        ctr === nothing || Base.size(ctr, 1) == 2 ||
            throw(ArgumentError("$kind.center is 2 × N degrees of (lon, lat) (got $(Base.size(ctr)))"))
        bnd, ext = boundary === nothing ? (nothing, nothing) : to_boundary(kind, boundary)
        if bnd !== nothing
            ctr === nothing || throw(ArgumentError(
                "$kind carries both center and boundary: a boundary is the footprint, and a centre " *
                "is what a footprint is computed about"))
            radius === nothing || throw(ArgumentError(
                "$kind.radius sizes a computed footprint, and $kind.boundary is the footprint itself"))
            sides === nothing || throw(ArgumentError(
                "$kind.sides counts the corners of a computed footprint, and $kind.boundary carries " *
                "its own"))
        end
        sd = sides === nothing ? 6 : Int(sides)
        sd ≥ 3 || throw(ArgumentError("$kind needs at least 3 sides (got $sd)"))
        r, c, o, v = to_scalars(radius), to_colors(color), to_colors(outline), to_codes(show)
        h = to_scalars(height_m)
        ctr === nothing && r !== nothing &&
            throw(ArgumentError("$kind.radius describes geometry, which rides only a window that " *
                                "carries `center`"))
        drape === nothing || drape isa Bool || throw(ArgumentError(
            "$kind.drape is true or false, or nothing to decide it from the span of each region"))
        ctr === nothing && bnd === nothing && drape !== nothing &&
            throw(ArgumentError("$kind.drape describes geometry, which rides only a window that " *
                                "carries `center` or `boundary`"))
        # A window carrying no geometry addresses standing footprints, whose entity count this family
        # does not restate; the forms that need one are checked on the windows that carry it.
        n = ctr !== nothing ? Base.size(ctr, 2) : bnd === nothing ? nothing : length(bnd)
        if n !== nothing
            agree_frames(String(kind),
                "radius" => knob_frames(r, n, 1, "$kind.radius"),
                "height_m" => knob_frames(h, n, 1, "$kind.height_m"),
                "color" => knob_frames(c, n, 4, "$kind.color"),
                "outline" => knob_frames(o, n, 4, "$kind.outline"),
                "show" => knob_frames(v, n, 1, "$kind.show"))
        end
        return new(String(kind), ctr, bnd, ext, r, sd, h, drape, c, o, v)
    end
end

Areas(kind; center = nothing, boundary = nothing, radius = nothing, sides = nothing, height_m = 0,
      drape = nothing, color = nothing, outline = nothing, show = nothing) =
    Areas(kind, center, boundary, radius, sides, height_m, drape, color, outline, show)

# Every region's rings, structurally checked, with the bounding box of each outer ring. The extents
# come out of the same pass because the hole check is a comparison of two of them, and the module
# reads them to choose how finely it tessellates.
function to_boundary(kind, boundary)
    boundary isa AbstractVector || throw(ArgumentError(
        "$kind.boundary is one entry per region: a 2 × V ring, or a vector of rings"))
    regions = Vector{Vector{Matrix{Float64}}}(undef, length(boundary))
    extents = Matrix{Float64}(undef, 4, length(boundary))
    for (i, region) in enumerate(boundary)
        rings = to_rings(kind, i, region)
        outer = ring_extent(rings[1])
        for j in 2:length(rings)
            hole = ring_extent(rings[j])
            (hole[1] ≥ outer[1] && hole[2] ≤ outer[2] && hole[3] ≥ outer[3] && hole[4] ≤ outer[4]) ||
                throw(ArgumentError(
                    "$kind.boundary[$i] ring $j lies outside ring 1, so it is not a hole in it. " *
                    "The outer ring comes first, every ring after it is a hole"))
        end
        regions[i] = rings
        extents[:, i] .= outer
    end
    return regions, extents
end

to_rings(kind, i, region::AbstractMatrix) = to_rings(kind, i, [region])
to_rings(kind, i, region) = throw(ArgumentError(
    "$kind.boundary[$i] is a 2 × V ring, or a vector of rings with the outer ring first"))

function to_rings(kind, i, region::AbstractVector)
    isempty(region) && throw(ArgumentError("$kind.boundary[$i] carries no ring"))
    rings = Vector{Matrix{Float64}}(undef, length(region))
    for (j, r) in enumerate(region)
        r isa AbstractMatrix || throw(ArgumentError(
            "$kind.boundary[$i] ring $j is a 2 × V matrix of degrees (got $(typeof(r)))"))
        m = convert(Matrix{Float64}, r)
        Base.size(m, 1) == 2 && Base.size(m, 2) ≥ 3 || throw(ArgumentError(
            "$kind.boundary[$i] ring $j is 2 × V degrees of (lon, lat) with at least 3 vertices " *
            "(got $(Base.size(m)))"))
        all(isfinite, m) || throw(ArgumentError(
            "$kind.boundary[$i] ring $j has a coordinate that is not finite"))
        check_vertices_distinct(kind, i, j, m)
        rings[j] = m
    end
    return rings
end

# Checks that no two consecutive vertices are co-located. Cesium subdivides an edge by normalizing
# the difference between its two vertices, so a co-located pair throws there and stops the whole
# scene. The ring closes itself, so the last vertex and the first are a consecutive pair too.
function check_vertices_distinct(kind, i, j, m)
    V = Base.size(m, 2)
    for a in 1:V
        b = a == V ? 1 : a + 1
        co_located(@view(m[:, a]), @view(m[:, b])) && throw(ArgumentError(
            "$kind.boundary[$i] ring $j vertices $a and $b are co-located: " *
            "($(m[1, a]), $(m[2, a])) and ($(m[1, b]), $(m[2, b])). Note that ±180° is one " *
            "meridian, and that every longitude at a pole is the same point"))
    end
    return nothing
end

# `==` misses two cases that real data carries: -180° and +180° are one meridian, and at a pole the
# longitude carries no information.
function co_located(p, q)
    abs(p[2]) ≥ 90 && abs(q[2]) ≥ 90 && return sign(p[2]) == sign(q[2])
    isapprox(p[2], q[2]; atol = 1e-9) || return false
    return abs(mod(p[1] - q[1] + 180, 360) - 180) ≤ 1e-9
end

# One ring's bounding box, as (lon_min, lon_max, lat_min, lat_max).
ring_extent(ring) = (extrema(@view ring[1, :])..., extrema(@view ring[2, :])...)
