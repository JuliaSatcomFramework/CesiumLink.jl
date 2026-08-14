"""
    CesiumLink.Ellipsoids

The reference ellipsoid of a body, as the `(; a, b)` pair
[`CesiumLink.start_server`](@ref) and [`CesiumLink.ecef`](@ref) take: the semi-major
axis `a` and the semi-minor axis `b`, in metres.

This submodule is not re-exported. Reach a body by its namespace, or bring the three
names in:

```julia
using CesiumLink
start_server(; ellipsoid = Ellipsoids.MOON)

using CesiumLink.Ellipsoids
start_server(; ellipsoid = MOON)
```

Any other shape is two positive radii, so a body that is not here needs no entry:
`start_server(; ellipsoid = (a = 2439700.0, b = 2439700.0))` draws Mercury.
"""
module Ellipsoids

export WGS84, MOON, MARS

"""
    Ellipsoids.WGS84

The ellipsoid the viewer draws on unless it is told otherwise. Pass it to
[`CesiumLink.start_server`](@ref) to say so explicitly.
"""
const WGS84 = (a = 6378137.0, b = 6356752.3142451793)   # WGS 84, NIMA TR8350.2; b from f = 1/298.257223563

"""
    Ellipsoids.MOON

The Moon, as a sphere.
"""
const MOON = (a = 1737400.0, b = 1737400.0)             # IAU/IAG mean radius of the Moon

"""
    Ellipsoids.MARS

Mars. It is oblate by 20 km, which the viewer draws.
"""
const MARS = (a = 3396190.0, b = 3376200.0)             # IAU 2000 equatorial and polar radii of Mars

end # module Ellipsoids

# The check any shape gets before a globe is built on it. It sits beside the table of bodies, and
# not in the server, because it reads a pair of radii and nothing else.
#
# How far the camera is taken to travel from the equatorial plane, in semi-major axes: a shape whose
# drawing limit falls inside this is warned about, one whose limit is beyond it is left alone.
const CAMERA_REACH = 4

# The two radii as `(; a, b)` of `Float64`, or an error naming what was wrong. A shape no globe can
# be built on fails here rather than in the browser, where it arrives as a blank page. A shape that
# draws only up to a certain camera height is warned about instead of refused — that height may sit
# beyond anywhere this session's camera goes.
function ellipsoid_radii(e)
    a, b = Float64(e.a), Float64(e.b)
    isfinite(a) && a > 0 && isfinite(b) && b > 0 ||
        throw(ArgumentError("an ellipsoid's radii must be positive and finite (got a=$a, b=$b)"))
    k = abs(a^2 / b^2 - 1)
    z_limit = k == 0 ? Inf : b / k
    z_limit < CAMERA_REACH * a && @warn "this ellipsoid is flattened enough to stop the viewer's \
        render loop: Cesium's per-frame local-curvature computation has no solution once the camera \
        is |z| ≥ b / |a²/b² − 1| from the equatorial plane" a b ratio = a / b camera_limit_m = z_limit
    return (; a, b)
end
