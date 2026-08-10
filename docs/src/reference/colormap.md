```@meta
CurrentModule = CesiumLink
```

# Colours

Julia decides every colour in the scene, so a colormap is an ordinary Julia value. CesiumLink
neither registers nor names one. Three forms are understood:

- a vector of colours, spread evenly over `[0, 1]`;
- a vector of `fraction => colour` stops, taken as written;
- anything that supports `get(cmap, t)`, which is what makes a ColorSchemes.jl scheme work
  unchanged.

A colour is a ColorTypes value, a `"#rgb"`, `"#rrggbb"` or `"#rrggbbaa"` string, or a tuple of
integers in `0..255` with or without an alpha component. The only colour dependency is
ColorTypes.jl.

## Colouring a family

```@docs
rgba
```

## One colour at a time

```@docs
CesiumLink.RGBA8
CesiumLink.rgba8
CesiumLink.sample_rgba
```

## Colormap stops

```@docs
CesiumLink.colormap_stops
CesiumLink.legend_stops
```
