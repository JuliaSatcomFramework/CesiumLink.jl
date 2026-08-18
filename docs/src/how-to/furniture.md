# Choose the on-screen furniture

**Furniture** is an item the Core puts on screen itself: the timeline ruler, the animation clock, the
keyframe readout and the corner buttons. It needs no module. [`declare_furniture`](@ref) states which
items are on screen:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false,
                  projection = true, region = :top_right)
```

The declaration is retained, so a browser that connects later comes back to the same furniture.

## Every call states the whole set

Two calls do not accumulate. An item a call does not name takes **its default**, not what an earlier
call said about it:

```julia
declare_furniture(server; inspector = true)   # inspector on, everything else at its default
declare_furniture(server; home = false)       # inspector off again
declare_furniture(server)                     # every item back at its default
```

So build the whole call from your own state, and send it whenever that state changes:

```julia
declare_furniture!() = declare_furniture(server;
    timeline = band[], animation = band[], keyframe = band[], inspector = panel[])
```

## The items

The first four are the **band** along the bottom edge. The other six are one **group** of buttons
that travels whole into one region.

| Keyword | Default | What it is |
|:--|:--|:--|
| `timeline` | on | The scrubbable date ruler along the bottom edge |
| `animation` | on | The clock face, shuttle ring and play/pause, at the bottom-left corner |
| `keyframe` | on | The readout naming the keyframe the values come from. Click it to move the clock there |
| `camera_follow` | on | The indicator saying who holds the camera. It shows nothing until a viewpoint arrives — see [Give a recording a tour](camera-tour.md) |
| `scene_mode` | on | The 2D / 3D / Columbus picker |
| `fullscreen` | on | The fullscreen toggle |
| `home` | on | Fly the camera back to the default view |
| `projection` | **off** | The perspective / orthographic picker |
| `nav_help` | **off** | The navigation instructions |
| `inspector` | **off** | The Cesium inspector panel |

The band is fixed to the bottom edge. Only the group takes a `region` and a `style`:

```julia
declare_furniture(server; region = :bottom_right, style = (; flex_direction = "row"))
```

`region` is one of `:top_left`, `:top_center`, `:top_right` and `:bottom_right`, and defaults to
`:top_right`. In a `style`, `_` lowers to `-`, so `flex_direction` travels as `flex-direction`.

An item turned off is destroyed rather than hidden, and one turned on is built when the declaration
asks for it. A session that never asks for the inspector never pays for it.

!!! warning "The ruler is what reaches the other keyframes"
    Do not take `timeline` down over a run of more than one keyframe. The viewer obeys the
    declaration, then warns in the browser console that the frames after the first are unreachable.
    A run of one keyframe is the case this is for — see
    [Show a scene with no clock](static-scene.md).

## Style the regions the widgets sit in

The four overlay regions hold the furniture group and every module's controls. Style them with
[`declare_regions`](@ref), which is a whole set as well: a region absent from the call returns to its
Core default.

```julia
declare_regions(server, Dict(:top_right => (; flex_direction = "column", gap = "12px"),
                             :top_left  => (; max_width = "40%")))
```

Pass an empty `Dict` to return every region to its default.

The Core owns placement, so the viewer refuses `position`, `top`, `right`, `bottom`, `left`,
`transform`, `z-index` and `inset`. A refusal warns in the browser console and drops that property
only. The rest of that region's bag still applies.

Reach for this when a corner holds more than one thing and the stacking is wrong. With one child a
region looks the same as a row or a column, so check the change against a corner that holds two.

## Next

- [Furniture and regions](../reference/furniture.md) — the full signature of both calls.
- [`core/furniture`](../reference/wire/protocol.md) — what the declaration looks like on the wire.
- [The shape of the system](../explanation/architecture.md) — why furniture is the Core's and a
  control is a module's.
