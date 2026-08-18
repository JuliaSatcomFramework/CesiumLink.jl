```@meta
CurrentModule = CesiumLink
```

# Coordinates

Geodetic coordinates and ECEF metres, on the ellipsoid the session runs on. Latitude is
**geodetic**: it is the angle of the surface normal, and not the angle from the centre. The two
differ by up to 0.19° on WGS84, some 21 km at the surface.

The viewer places every position through Cesium's own conversion on the declared shape. A scene that
computes ECEF itself agrees with what is drawn only if it uses the same ellipsoid. Both functions
here take a [`Server`](@ref) as their `ellipsoid`, which resolves to the shape that session
declared.

CesiumLink calls neither function, and depends on no geodesy package. Both are here so a scene needs
no such dependency to place a point.

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
