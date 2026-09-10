```@meta
CurrentModule = CesiumLink
```

# The globe

Two things the Core draws on the globe itself: the **graticule** over it, and whether the globe
stands in the depth buffer in front of what is drawn above it. Both exist with no module loaded, so
both entry points are flat in `CesiumLink`, and both are declarations — retained, so a browser
connecting later comes back to the same globe, and re-declarable, so a reader's knob is one call.

Neither is a **basemap** and neither is an **annotation layer**. See
[Basemaps and imagery](server.md) for what the globe is textured with, and `declare_furniture`'s
`annotations` keyword in [Furniture and regions](furniture.md) for the place names and the country
borders.

## The graticule

`spacing` is degrees — one number for both families, or `(lon, lat)` for the meridians and the
parallels apart. `nothing` is the graticule switched off, which is a state and not an absence.

| Keyword | Default | What it sets |
|---|---|---|
| `spacing` | `20` | degrees between meridians and parallels, or `nothing` for none |
| `color` | `"#33333340"` | the CSS colour of the lines |
| `width` | `1` | the width of a line, in pixels |
| `labels` | `true` | write the longitude and latitude of each line |
| `label_color` | `"#222222d0"` | the CSS colour of the text |
| `label_font` | `"12px system-ui"` | the CSS font of the text |
| `altitude_m` | `30_000` | metres above the ellipsoid the lines stand at |

The graticule hides its own far half: the viewer keeps only the runs of each line on the camera's
own side of the Earth, and hides a label the same way. That is exact the moment the camera moves and
owes nothing to the depth setting below. A view with no far side — 2-D and Columbus view — draws the
whole graticule.

```@docs
declare_graticule
```

## The globe in the depth buffer

```@docs
declare_globe_depth
```
