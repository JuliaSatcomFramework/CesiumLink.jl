```@meta
CurrentModule = CesiumLink
```

# Coordinates

Geodetic coordinates and ECEF metres, on the ellipsoid the session runs on. Latitude is
**geodetic**: it is the angle of the surface normal, and not the angle from the centre. The two
differ by up to 0.19° on WGS84, some 21 km at the surface.

The viewer places every position through Cesium's own conversion on the declared shape. A scene that
computes ECEF for itself therefore agrees with what is drawn only if it converts against the same
ellipsoid. Both directions here take a [`Server`](@ref) as their `ellipsoid`, which resolves to the
shape that session declared.

CesiumLink itself calls neither function. Both are here so that a scene needs no geodesy dependency
to place a point, and so the package needs none to offer one.

## The ellipsoid

A shape is anything with the fields `a` and `b` in metres. `Ellipsoids` names a few bodies, and it
is not re-exported: write `Ellipsoids.MOON`, or bring the names in with
`using CesiumLink.Ellipsoids`.

```@docs
Ellipsoids
Ellipsoids.WGS84
Ellipsoids.MOON
Ellipsoids.MARS
```

## Conversions

```@docs
ecef
geodetic
```
