# Work in map coordinates

Your data is in degrees and metres. The scene draws in ECEF metres. Convert between the two,
send the result in the layout the payload families take, and keep the conversion on the same
ellipsoid the browser draws on.

## Convert degrees to ECEF metres

[`ecef`](@ref) takes longitude and latitude in **degrees**, and a height in metres above the
ellipsoid. Scalars give a tuple.

```@repl coords
using CesiumLink
ecef(12.5, 41.9, 100)
```

Arrays give the `3 × N` matrix [`Nodes`](@ref) and [`Edges`](@ref) take. Column `i` is point
`i`, and the arguments broadcast, so a common height stays a scalar.

```@repl coords
xyz = ecef([12.5, 7.6, -71.1], [41.9, 45.1, 42.4], 0)
size(xyz)
```

[`geodetic`](@ref) is the inverse. It takes three arrays, or one `3 × N` matrix, and gives
`(lon; lat; height)` as `3 × N`.

```@repl coords
geodetic(xyz)
geodetic(4.641797e6, 1.029062e6, 4.237410e6)
```

**Latitude is geodetic.** It is the angle of the surface normal, not the angle from the
centre. The two differ by up to 0.19° on WGS84, some 21 km at the surface, and a scene built
on the wrong one still looks like a scene.

## Convert against the shape the scene is drawn on

The viewer places every position through Cesium's own conversion, on the ellipsoid the
server declared. A scene that computes ECEF itself agrees with what is drawn only if it
converts against the same shape.

Pass the server, and both directions resolve to that session's ellipsoid:

```julia
xyz = ecef(lons, lats, heights; ellipsoid = server)
```

Pass the shape itself where there is no server to hand. Anything with the fields `a` and `b`
in metres works, and [`Ellipsoids`](@ref CesiumLink.Ellipsoids) names a few bodies:

```@repl coords
Ellipsoids.WGS84
ecef(0, 0; ellipsoid = Ellipsoids.MARS)
ecef(0, 0; ellipsoid = (a = 3396190.0, b = 3376200.0))     # the same shape, stated
```

## Run a session on another ellipsoid

State the shape once, at [`start_server`](@ref). It is declared to every client, which
builds its globe on it before it decodes any payload.

```julia
server = start_server(; ellipsoid = Ellipsoids.MARS)
```

Left alone, nothing is declared and the viewer keeps its own WGS84 default.

!!! warning "A strongly flattened shape stops the render loop"
    Cesium computes the local curvature under the camera every frame, and that computation
    has no solution once the camera is `|z| ≥ b / |a²/b² − 1|` from the equatorial plane.
    Past that height the viewer stops drawing. `start_server` warns when this limit falls
    within four semi-major axes of the equatorial plane, and states the limit in metres.
    It does not refuse the shape, because the limit may sit beyond anywhere this session's
    camera goes. Julia reports it once; nothing in the browser reports it at all.

You need no geodesy package for this. If your scene already loads one, convert with it
instead, on the same two radii.

## Get the array layout right

Positions arrive as a `3 × N` matrix of ECEF metres, in the order `x; y; z`. A family whose
positions change across the window is `3 × N × keyframes`, with the keyframes last.

```julia
Nodes(:sat; position = ecef(lons, lats, alts; ellipsoid = server), size = 12)
```

[`ecef`](@ref) already produces that layout, so a scene that converts through it needs no
reshape.

## Trap: a vector of structs becomes JSON objects

The codec encodes numeric arrays. A `Vector` of a three-field struct is not `<: Number`, so
the codec walks it element by element into a JSON list. The bytes stay in the header, the
payload grows, and nothing raises.

```@repl coords
struct Point3
    x::Float64
    y::Float64
    z::Float64
end
track = [Point3(1, 2, 3), Point3(4, 5, 6)];
region = IOBuffer();
CesiumLink.encode_arrays((; position = track), region)     # no array on the wire
```

The fix costs no copy. `reinterpret(reshape, ...)` views the same memory as the `3 × N`
matrix the wire wants:

```@repl coords
region = IOBuffer();
CesiumLink.encode_arrays((; position = reinterpret(reshape, Float64, track)), region)
```

This holds for any struct whose fields share one type: a `StaticArrays` `SVector`, a
coordinate type of your own, a two-field pair. Reinterpret it, and send `Float32` for
positions. See [Send large arrays](large-arrays.md).

## Next

- [Coordinates](../reference/geodesy.md) for the whole surface and the accuracy figures.
- [Draw points, lines and areas](primitives.md) for what to do with the matrix.
