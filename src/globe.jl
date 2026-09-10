# Two things the Core draws on the globe itself: the graticule over it, and whether the globe stands
# in the depth buffer in front of what is drawn above it.
#
# Both are Core concepts rather than one module's vocabulary, for the reason the furniture is: they
# exist with no module loaded, and every module draws over them. Both entry points are therefore
# flat in `CesiumLink`, and both are declarations — retained, so a browser connecting later comes
# back to the same globe, and re-declarable, so a reader's knob is one call.

# The pairs the Core answers on itself. Both sides must agree on each one.
const CORE_GRATICULE   = ("core", "graticule")
const CORE_GLOBE_DEPTH = ("core", "globe-depth")

# The finest a graticule may be cut, in degrees.
#
# Every line is a primitive and every label a set of billboards, so the cost of a graticule is the
# number of lines in it. A tenth of a degree is 3,600 meridians and 1,799 parallels, which is a page
# that no longer answers the camera; a degree is 360 and 179, which it does.
const MIN_GRATICULE_SPACING = 1.0

# The spacing of the meridians and of the parallels, in degrees, as the wire carries them — or two
# `nothing`s, which is the graticule switched off.
graticule_spacing(::Nothing) = (nothing, nothing)
graticule_spacing(s::Real) = graticule_spacing((s, s))
function graticule_spacing(s::Union{Tuple,AbstractVector,Pair})
    length(s) == 2 || throw(ArgumentError(
        "a graticule spacing is one number of degrees, or (lon, lat) (got $(length(s)) values)"))
    lon, lat = Float64(first(s)), Float64(last(s))
    all(isfinite, (lon, lat)) ||
        throw(ArgumentError("a graticule spacing is finite (got $((lon, lat)))"))
    MIN_GRATICULE_SPACING ≤ lon ≤ 180 || throw(ArgumentError(
        "the meridians of a graticule stand $(MIN_GRATICULE_SPACING)° to 180° apart (got $lon)"))
    MIN_GRATICULE_SPACING ≤ lat ≤ 90 || throw(ArgumentError(
        "the parallels of a graticule stand $(MIN_GRATICULE_SPACING)° to 90° apart (got $lat)"))
    return (lon, lat)
end
graticule_spacing(s) = throw(ArgumentError(
    "a graticule spacing is one number of degrees, or (lon, lat), or `nothing` for no " *
    "graticule (got $(repr(s)))"))

# What the viewer reads, as the whole statement. Separated from the declaration so the shape of a
# graticule can be checked without a server to send it to.
function graticule_payload(; spacing, color, width, labels, label_color, label_font, altitude_m)
    lon, lat = graticule_spacing(spacing)
    w = Float64(width)
    w > 0 || throw(ArgumentError("a graticule line is at least one pixel wide (got $w)"))
    alt = Float64(altitude_m)
    isfinite(alt) && alt ≥ 0 ||
        throw(ArgumentError("a graticule stands at or above the ellipsoid (got $alt m)"))
    return (; lon, lat, color = String(color), width = w, labels = Bool(labels),
            labelColor = String(label_color), labelFont = String(label_font), altitudeM = alt)
end

"""
    declare_graticule(server::Server; spacing=20, color="#33333340", width=1, labels=true,
                      label_color="#222222d0", label_font="12px system-ui",
                      altitude_m=30_000) -> Int

Declare the graticule the Core draws over the globe: meridians and parallels at `spacing`, labelled
along two axes. Returns the number of clients it was queued for.

`spacing` is degrees — one number for both families, or `(lon, lat)` for the meridians and the
parallels apart. **`nothing` is the graticule switched off**, which is a state and not an absence: a
reader who takes the lines off expects them gone, and the declaration that says so is retained like
any other. Each call is a full statement, so a keyword this call does not name takes its default
rather than whatever an earlier call said about it.

Every line is cut for its own length. The chord error of a segment grows with the radius of the
circle it is cut from, so a parallel at 80° takes fewer segments than the equator for the same error
and the graticule costs what its shortest circles are worth rather than a budget shared out evenly.

**The globe hides the far half.** The viewer keeps only the runs of each line on the camera's own
side of the Earth, and hides a label the same way, so nothing is drawn through the globe. This is
the graticule's own doing and owes nothing to [`declare_globe_depth`](@ref): it is exact the moment
the camera moves, and it does not wait for a tile to load. A view with no far side — 2-D and
Columbus view — draws the whole graticule, which is what a flat map should show.

`labels` writes the longitude of a meridian where it crosses the equator and the latitude of a
parallel where it crosses the prime meridian, so the numbers stand along two axes through the middle
of the map rather than repeating across it. One label serves both at 0°, 0°.

`altitude_m` lifts the lines and their labels off the ellipsoid. It matters only to a session that
also turns [`declare_globe_depth`](@ref) on: the viewer joins two vertices with a straight chord,
which sags some 2 km inside the sphere at the cut this graticule uses, and a line below its own sag
sinks into a globe that is depth-testing against it.

`color` and `label_color` are CSS colours; one the browser cannot read draws the default instead and
says so once in the console.

```julia
declare_graticule(server; spacing = (20, 10))
declare_graticule(server; spacing = nothing)          # off, and retained as off
```
"""
declare_graticule(server::Server; spacing = 20, color = "#33333340", width = 1, labels = true,
                  label_color = "#222222d0", label_font = "12px system-ui",
                  altitude_m = 30_000) =
    send_command(server, CORE_GRATICULE...,
                 graticule_payload(; spacing, color, width, labels, label_color, label_font,
                                   altitude_m))

"""
    declare_globe_depth(server::Server, on::Bool = true) -> Int

Declare whether the globe stands in the depth buffer in front of what is drawn over it. Returns the
number of clients it was queued for.

Cesium leaves this off, so a node, an edge, a model or a label is drawn whether the globe stands
between it and the camera or not: the far half of a network shows through the Earth. Turning it on
puts the globe's own surface in the depth buffer, which hides what is behind it and leaves the near
half as it was. It is scene-wide, so a scene that draws a footprint sagging below the ellipsoid, or
a marker sitting on it, wants it off — those are the things it hides too.

Two consequences of Cesium's own drawing are worth knowing before turning it on:

  - **2-D bypasses it.** Cesium clears the globe depth in 2-D whatever this says, and that is
    correct: a flat map has no far side.
  - **Occlusion then comes from the tiles actually drawn.** With the setting on Cesium draws no
    depth plane, so a line over a tile that has not yet loaded shows through until it arrives. It is
    most visible right after a scene-mode morph, which redraws every tile.

The Core also re-asserts the setting before each frame, at the cost of one boolean test: Cesium's
own terrain picker writes it whenever a terrain provider is chosen, and a morph rebuilds enough of
the scene to be worth distrusting.

The graticule of [`declare_graticule`](@ref) needs none of this — it hides its own far half — so a
scene that draws only a graticule over the globe can leave this alone.
"""
declare_globe_depth(server::Server, on::Bool = true) =
    send_command(server, CORE_GLOBE_DEPTH..., (; on))
