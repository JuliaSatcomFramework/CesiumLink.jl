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
