```@meta
CurrentModule = CesiumLink
```

# Furniture and regions

**Furniture** is an item the Core puts on screen itself. It exists in a session that declares no
modules at all. The server states the whole set in one declaration.

An **overlay region** is a corner the Core positions and stacks widgets within. A region exists with
no `ui` module loaded, so both entry points here are flat in `CesiumLink` rather than in
`CesiumLink.UI`. The four regions are `:top_left`, `:top_center`, `:top_right` and `:bottom_right`.

## Declaring furniture

Furniture divides into two parts. The **band** is fixed to the bottom edge, because Cesium builds
its ruler as a bottom bar. The **group** travels whole into the region the declaration names.

| Keyword | Part | Default | Item |
|---|---|---|---|
| `timeline` | band | `true` | the timeline ruler |
| `animation` | band | `true` | the animation clock |
| `keyframe` | band | `true` | the readout naming the keyframe the values come from |
| `camera_follow` | band | `true` | the indicator saying who holds the camera, and the way back |
| `scene_mode` | group | `true` | the scene-mode picker |
| `fullscreen` | group | `true` | the fullscreen toggle |
| `home` | group | `true` | the home button |
| `projection` | group | `false` | the projection toggle |
| `nav_help` | group | `false` | the navigation help |
| `inspector` | group | `false` | the inspector |
| `canvas_capture` | group | `false` | the button that copies or downloads a **canvas capture** |
| `region` | — | `:top_right` | which region the group travels into |
| `style` | — | `nothing` | CSS merged over the group's own rule |

```@docs
declare_furniture
```

## Declaring the regions

```@docs
declare_regions
overlay_style
```

## Capturing the canvas

A **canvas capture** is one PNG of the viewer's canvas. The furniture, the overlay and the floats
are HTML above the canvas, so a capture holds none of them.

The feature has two doors. `capture_canvas` asks from Julia and writes the file. The
`canvas_capture` furniture button copies a capture to the clipboard, or downloads one; the clipboard
needs a real click, so only the button reaches it.

```@docs
capture_canvas
```
