# Whether a globe can be built on a shape, and whether the viewer can draw it. It reads a pair of
# radii and is given no server, so it sits beside neither the table of bodies nor the listener.

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
