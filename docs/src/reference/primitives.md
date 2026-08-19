```@meta
CurrentModule = CesiumLink
```

# Primitives vocabulary

`CesiumLink.Primitives` is the payload vocabulary of the vendored `primitives` module. It names
points, lines, footprints, colours and sizes, and never a domain concept. `CesiumLink` re-exports
the four names below, so `using CesiumLink` reaches them.

The same rule governs every appearance knob. An array whose trailing dimension is the window's
keyframe count varies per keyframe. An array without that dimension is constant for the whole
window. A scalar covers the whole family. Positions blend between keyframes. Everything else
switches at the crossing.

## Families

```@docs
Nodes
Edges
Areas
```

## The payload

```@docs
primitives_payload
CesiumLink.Primitives.endpoint_count
```

## Stock values

```@docs
CesiumLink.Primitives.MARKERS
marker_image
CesiumLink.Primitives.STYLES
CesiumLink.Primitives.KnobValue
```
