# Geodetic coordinates ↔ ECEF metres, on the ellipsoid the session runs on.
#
# The viewer places every position through Cesium's own conversion on the declared shape, so a scene
# that computes ECEF for itself agrees with what is drawn only if it converts against the same
# ellipsoid. Both directions here are checked against Cesium's numbers over a fixed table of points
# (`lib/ellipsoid-reference.mjs`, `tools/baseline/ellipsoid-reference.json`).
#
# Latitude is **geodetic** — the angle of the surface normal, not the angle from the centre. The two
# differ by up to 0.19° on WGS84, some 21 km at the surface, and a scene built on the wrong one still
# looks like a scene.

# The two radii to convert against, as `Float64` `(a, b)`. A `Server`, or the `nothing` one holds
# when it declared no shape, resolves to WGS84: that is the shape its viewer builds the globe on, so
# nothing but two positive radii ever reaches the arithmetic.
_radii(e) = (Float64(e.a), Float64(e.b))
_radii(::Nothing) = _radii(Ellipsoids.WGS84)
_radii(server::Server) = _radii(server.ellipsoid)

# The first eccentricity squared, which is what both directions actually use.
_ecc2(a, b) = 1 - (b / a)^2

# Where the reference table stops improving: a fourth pass moves no answer in it, on either shape.
const BOWRING_PASSES = 3

# Broadcasting over scalars yields the tuple itself; over arrays, an array of tuples, which becomes
# the 3 × N matrix the payload families take.
_columns(p::Tuple) = p
_columns(p) = [p[i][c] for c in 1:3, i in eachindex(p)]

"""
    ecef(lon, lat, height = 0; ellipsoid = Ellipsoids.WGS84)

Cartesian ECEF metres for geodetic coordinates: `lon` and `lat` in **degrees**, `height` in metres
above the ellipsoid. Scalars give `(x, y, z)`; arrays give the `3 × N` matrix [`Nodes`](@ref) and
[`Edges`](@ref) take, broadcast over whichever arguments are arrays.

`ellipsoid` is the shape to convert against, as anything with the fields `a` and `b` in metres — or
a [`Server`](@ref), which resolves to the ellipsoid that session declared (or
[`Ellipsoids.WGS84`](@ref) when it declared none, that being what its viewer draws on). Passing the
server is what keeps a scene
from converting against one shape and being drawn on another.

Exact in closed form, and latitude is geodetic — the angle of the surface normal, not the angle from
the centre. Over the reference table it agrees with Cesium's `Ellipsoid.cartographicToCartesian` to
under 10 nm.

```julia
ecef(12.5, 41.9, 100; ellipsoid = server)
ecef([12.5, 7.6], [41.9, 45.1])            # 3 × 2
```

CesiumLink itself calls neither this function nor [`geodetic`](@ref). The two are here so that a
scene needs no geodesy dependency to place a point, and so the package needs none to offer one. A
scene that already loads `CoordRefSystems`, `Geodesy` or a comparable package can convert with that
one instead, against the same two radii.

See also [`geodetic`](@ref), the inverse.
"""
function ecef(lon, lat, height = 0; ellipsoid = Ellipsoids.WGS84)
    a, b = _radii(ellipsoid)
    return _columns(_ecef.(lon, lat, height, a, _ecc2(a, b)))
end

function _ecef(lon, lat, height, a, e2)
    slat, clat = sincosd(Float64(lat))
    slon, clon = sincosd(Float64(lon))
    # The prime vertical radius of curvature: the distance along the surface normal from the point
    # to the polar axis.
    n = a / sqrt(1 - e2 * slat^2)
    return ((n + height) * clat * clon, (n + height) * clat * slon,
            (n * (1 - e2) + height) * slat)
end

"""
    geodetic(x, y, z; ellipsoid = Ellipsoids.WGS84)
    geodetic(xyz::AbstractMatrix; ellipsoid = Ellipsoids.WGS84)

Geodetic `(lon, lat, height)` — degrees, degrees, metres above the ellipsoid — for ECEF metres.
Scalars give a tuple; arrays, or a `3 × N` matrix of columns, give a `3 × N` matrix of
`(lon; lat; height)`. `ellipsoid` is as for [`ecef`](@ref), whose inverse this is.

Latitude comes from Bowring's method, run for $(BOWRING_PASSES) passes and stopped there rather than
on a convergence test. Height is then closed form, with no equator-or-pole split to make.

Over the reference table — both poles, the equator, the antimeridian, heights from 11 km below the
surface to 20 200 km above it, on WGS84 and on a shape flattened far past any planet's — it agrees
with Cesium's `Cartographic.fromCartesian` to under 2 µm in height and under 1e-9°, which is a tenth
of a millimetre at the surface.

Longitude of a point on the polar axis is arbitrary; `0` is returned for it. Latitude is unreliable
within `e² a` of that axis, 43 km on WGS84, which is deep inside the body.
"""
function geodetic(x, y, z; ellipsoid = Ellipsoids.WGS84)
    a, b = _radii(ellipsoid)
    return _columns(_geodetic.(x, y, z, a, _ecc2(a, b)))
end

function geodetic(xyz::AbstractMatrix; kw...)
    size(xyz, 1) == 3 ||
        throw(ArgumentError("ECEF positions are 3 × N (got $(size(xyz)))"))
    return geodetic(view(xyz, 1, :), view(xyz, 2, :), view(xyz, 3, :); kw...)
end

function _geodetic(x, y, z, a, e2)
    x, y, z = Float64(x), Float64(y), Float64(z)
    p = hypot(x, y)
    p == 0 && z == 0 &&
        throw(ArgumentError("the centre of the ellipsoid has no geodetic coordinates"))
    f = 1 - sqrt(1 - e2)    # flattening
    b = a * (1 - f)
    ep2 = e2 / (1 - e2)     # the second eccentricity squared

    # Bowring's method. Each pass reads the geodetic latitude off the parametric one, then puts the
    # answer back to sharpen the parametric latitude for the next pass. A fixed count keeps this
    # free of a convergence test to fall short of.
    β = atan(z, (1 - f) * p)
    lat = β                 # the loop writes `lat`, so the binding must outlive it
    for _ in 1:BOWRING_PASSES
        sβ, cβ = sincos(β)
        lat = atan(z + ep2 * b * sβ^3, p - e2 * a * cβ^3)
        slat, clat = sincos(lat)
        β = atan((1 - f) * slat, clat)
    end

    slat, clat = sincos(lat)
    # Exact, and with no equator-or-pole split to make: `p cos(lat) + z sin(lat)` is the height plus
    # `N (1 - e² sin²lat)`, and the term taken off is that same quantity written without `N`.
    height = p * clat + z * slat - a * sqrt(1 - e2 * slat^2)
    return (atand(y, x), rad2deg(lat), height)
end
