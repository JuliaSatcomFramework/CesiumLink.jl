```@meta
CurrentModule = CesiumLink
```

# Heatmap vocabulary

`CesiumLink.Heatmap` is the payload vocabulary of the vendored `heatmap` module: a continuous field,
already coloured, draped over a box of longitude and latitude. `CesiumLink` re-exports the four
names below, so `using CesiumLink` reaches them.

Julia bakes the colour. Nothing in the browser reads a value and picks a shade from it, so a
colorbar and the texels it describes cannot drift apart.

One raster covers one rectangle. The whole globe is the box `(-180, -90, 180, 90)`. A field that is
not a rectangle gives the texels outside it `alpha = 0`. A fine field over a coarse one is two
rasters, in the order they stack.

## Baking a field

```@docs
rgba_grid
heatmap_index
```

## The family and its payload

```@docs
Raster
heatmap_payload
```
