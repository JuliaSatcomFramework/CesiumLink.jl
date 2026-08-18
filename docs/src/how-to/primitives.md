# Draw points, lines and areas

The vendored `primitives` module draws three families: points, lines that join two families by index,
and ground footprints. Build the families in Julia and send them as one payload. Register the module
once, before the first client connects:

```julia
register_module!(server, vendored(:primitives))
```

## Send one window of families

Build the families, wrap them with [`primitives_payload`](@ref), and address the result to
`:primitives`:

```julia
push_window(server, Dict(:primitives => primitives_payload(
                Nodes(:sat; position = sat_ecef, size = 12),
                Nodes(:gw; position = gw_ecef, marker = :star),
                Edges(:feeder; from = :gw, to = :sat, pairs = links)));
            start_frame = 1, count = 24, dt_seconds = 600, total_frames = 24)
```

Two rules hold at the call:

- Every family in one payload describes the same keyframes as the window that carries them.
- An [`Edges`](@ref) family must find both endpoint families in the same payload. A name nothing
  carries is refused here, rather than drawn as an empty family in the browser.

`position` is ECEF metres. To convert degrees, use [`ecef`](@ref) — see
[Work in map coordinates](coordinates.md).

## Get the array shapes right

`position` is `3 × N` for a family that stands still through the window, or `3 × N × count` for one
whose points move across it. Positions blend between keyframes; everything else switches at the
crossing.

Every other property is an **appearance knob**, and its shape says how far it varies. A colour takes
four components per entity, so its shapes carry one more axis:

| What it varies with | A one-component knob (`size`, `width`, `show`) | A colour knob (`color`, `outline`) |
|:--|:--|:--|
| nothing | a number | `(r, g, b, a)` |
| the entity | `N` | `4 × N` |
| the entity and the keyframe | `N × count` | `4 × N × count` |

The arrays of one family must agree on the keyframe count. A shape that is none of these forms raises
at the constructor, and names the family and the knob.

## Colour by value

[`rgba`](@ref) maps one value per entity onto the byte matrix the three families take:

```@repl primitives
using CesiumLink
rgba(["#2b3a67", "#33e0ff", "#ffd166"], [0.0, 0.5, 1.0])
```

State `range` yourself when the colours must stay comparable between windows. Left alone it covers
the finite values of this call only. A value that is `NaN` draws nothing, whatever `alpha` says.
Pass `alpha` as one value per entity to dim the idle entities of a family.

`rgba` takes three colormap forms: a vector of colours, a vector of `fraction => colour` stops, and
anything that answers `get(cmap, t)`. The third form makes a ColorSchemes.jl scheme work unchanged.
Pass the same value to [`Legend`](@ref), and the colour bar cannot drift from what is on screen.

!!! warning "An edge's colour is its batch key"
    Colour an [`Edges`](@ref) family by a handful of appearances only: active and idle, served and
    unserved. The colour lives in the line's material, and the renderer emits one draw command per
    distinct `(style, colour, dash_length)`. A continuous ramp over a thousand edges draws a correct
    picture through a thousand draw commands. On [`Nodes`](@ref) and [`Areas`](@ref) a colour is a
    per-entity attribute, and a ramp over thousands of entities costs one draw command.

## Choose how a line is drawn

An [`Edges`](@ref) family takes a `style`, one of `:solid`, `:dashed` and `:glow`. `:dashed` also
reads `dash_length`, the pixels of one dash period:

```julia
Edges(:feeder; from = :gw, to = :sat, pairs = feeders, style = :dashed, dash_length = 16,
      width = 2.0)
Edges(:isl; from = :sat, to = :sat, pairs = isl, style = :glow, width = 1.0)
```

A style is per family or per edge, so one family draws the active links glowing and the idle ones
solid. The style joins the colour and the dash length in the batch key, so keep the number of
appearances small.

## Draw with an image of your own

`marker` takes one of the stock glyphs — `:disc`, `:star`, `:square`, `:triangle` — or an image, which
[`marker_image`](@ref) reads off disk:

```julia
Nodes(:sat; position = sats, marker = marker_image("assets/satellite.png"), size = 20)
```

Two rules the browser imposes:

- Give the image a square canvas. One `size` is the width and the height together, so a wide image is
  drawn squeezed.
- Pass the image itself. `marker_image` returns a `data:` URI, and the viewer runs under a policy
  that refuses an image fetched from a server. A refused image draws nothing at all.

`color` tints the image: the browser scales each of the image's channels by yours. White, the
default, leaves the image as you drew it, and a colour with a lower alpha fades it. Scaling only
darkens a channel, so draw the glyph light and let `color` do the rest.

## Hide entities instead of dropping them

A family's membership is fixed for the life of a window. To vary the drawn set within one window,
pass `show`, a mask of one value per entity: zero hides, anything else draws.

```julia
Areas(:cell; center = cells, radius = 12_000, color = fill, show = served)
```

A masked entity keeps its index, so an [`Edges`](@ref) pair or a float anchor that names it stays
valid. It is not pickable while hidden, so no tooltip reports it. Masking also costs far less than a
per-keyframe rebuild: `show` and `width` are written onto lines that stand, while `pairs`, `color`
and `style` are what a line is built from.

## Hang a line off points nobody sees

An [`Edges`](@ref) family draws from a masked endpoint, so a whole [`Nodes`](@ref) family may carry
`show = false` and serve only as the vertices of a line mesh:

```julia
Nodes(:sat; position = sats, size = 6, color = "#00e5ff"),
Nodes(:track; position = vertices, show = false),
Edges(:trail; from = :track, to = :track, pairs = segments, style = :glow, color = "#00e5ff80")
```

`vertices` is `3 × (S · V) × count`, one moving point per satellite per vertex of its trail, and
`segments` joins consecutive vertices of one satellite. This is how a trail along an orbit is drawn.
The renderer blends a position between keyframes, so the whole trail slides with the satellite rather
than jumping at each crossing.

Keep the vertex family's layout stable: entity `s + (j - 1) · S` is satellite `s` at vertex `j` in
every keyframe, so `segments` is written once and stands for the whole window. The
[Satellites](../examples/satellites.md) example draws its trails this way.

## Draw a footprint from its vertices

Use `center` with `radius` and `sides` for a computed footprint. Use `boundary` when you already hold
the vertices:

```julia
Areas(:region; boundary = [country_ring, [lake_outer, lake_hole]],
      color = rgba(CMAP, demand), outline = "#000000d9")
```

Pass one entry per region. An entry is a `2 × V` matrix of degrees, or a vector of such matrices.
Where an entry holds several rings, put the **outer ring first**; every ring after it is a hole. Keep
each ring open: the last vertex joins the first, so do not repeat it.

Two more rules apply:

- `boundary` replaces `center`, so `radius` and `sides` are refused rather than ignored.
- Split a region in two pieces, or one that crosses ±180°, into one entry per piece. Map the pieces
  back to one region when you write the tooltip.

## Recolour standing footprints

[`Areas`](@ref) geometry is tessellated once, so it rides only a replacing window. A later window
that omits both `center` and `boundary` leaves the footprints alone and changes only their colour,
outline and mask:

```julia
Areas(:cell; color = rgba(CMAP, satisfaction), show = served)
```

Re-sending the same geometry costs nothing: the module digests what the footprints were built from,
and re-tessellates only when that digest changes.

## Send a vector of position structs

A struct is not a number, so the codec walks it and writes JSON objects instead of an array. If your
positions are a `Vector` of a three-field struct, take a matrix view of it first:

```julia
Nodes(:sat; position = reinterpret(reshape, Float64, positions))
```

`reinterpret(reshape, S, v)` gives the `3 × N` matrix [`Nodes`](@ref) wants, with no copy. `S` is the
field type the struct's fields share. A struct whose fields have different types has no such view, so
build the matrix yourself.

## Next

- [Primitives vocabulary](../reference/primitives.md) — every keyword of the three families.
- [Colours](../reference/colormap.md) — the colormap forms and `rgba`.
- [Windows, keyframes and identity](../explanation/windows.md) — why a family cannot change size
  inside a window.
