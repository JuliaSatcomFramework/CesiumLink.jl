# Put a box on screen

A [`Floating`](@ref) object is a box of server-authored content at a point on screen, with an
identity of its own and a lifetime you control. Use one when the content must stay while the cursor
moves on. For content that follows the cursor, use the tooltip instead — see
[Show a value on hover](tooltips.md).

The `ui` module draws the boxes, so register it once:

```julia
register_module!(server, vendored(:ui))
```

## Declare the set

[`declare_floating`](@ref) states the **whole** set. Re-declaring replaces it, so you remove a box by
declaring the set without it:

```julia
declare_floating(server, [
    Floating("pinned"; anchor = Entity("primitives", "sat", 12), html = "<b>Satellite 12</b>"),
    Floating("load"; anchor = Screen(320, 180), mount = "charts", style = (; width = "360px")),
])
```

A float shows either `html` or a `mount`, never both and never neither:

- `html` is a server-authored fragment in its own shadow root. Its `<style>` reaches nothing else,
  and no `<script>` in it runs, so `html` carries static markup and nothing more.
- `mount` names a module. The `ui` module hands it a plain element, and that module owns everything
  inside it. Use a mount whenever the box needs code to run in it: a chart, a canvas, a widget that
  answers the pointer, or content that redraws itself on a keyframe. A mounted module also reports
  under the float's own id, so the Julia side cannot tell it from a built-in control.

The mounted element is plain rather than shadowed, because a library that installs its stylesheet in
`document.head` gets nothing of it across a shadow boundary. The
[Satellites over a region](../examples/region-count.md) example mounts a chart this way.

The set is retained, so a browser that connects later comes back to the same boxes. A float whose
declaration is unchanged keeps the box it already has, so a move or a restyle does not tear down a
mounted module.

## Choose an anchor

| Anchor | Where the box goes |
|:--|:--|
| `Screen(x, y)` | The box's own top-left, in pixels from the viewer's top-left corner |
| `Entity(module_id, kind, idx)` | Beside entity `idx` of family `kind`, re-projected every frame |
| `World(lon, lat, height = 0)` | Beside a point on the globe, in degrees and metres |

`Entity` and `World` name a thing the box must not cover, so the box sits a short distance beside the
point and flips near an edge. `Screen` is the top-left exactly.

`idx` is **1-based**, like every entity index in the Julia API.

The viewer asks the anchor's module where the entity is, so a module is anchorable exactly when it
exports `positionOf(kind, idx)`. The vendored `primitives` module does. A float that names a module
without it, or a point that no longer projects, hides its box rather than failing.

## Pin a box on a click

Hold the set yourself and declare it again on every change:

```julia
pins = Dict{Int,Floating}()

on_pointer(server; type = :click) do ev, reply
    ev.entity === nothing && return nothing
    i = ev.entity.idx
    pins[i] = Floating("pin$i";
                       anchor = Entity("primitives", ev.entity.kind, i),
                       html = "<b>$(ev.entity.kind) $i</b>")
    declare_floating(server, values(pins))
end

# The close affordance asks. This is what makes the box leave.
on_event(server, "ui", "close") do ev, reply
    delete!(pins, parse(Int, replace(ev.payload.id, "pin" => "")))
    declare_floating(server, values(pins))
end
```

`closable` defaults to `true` and draws the close affordance. A click on it notifies the server and
removes nothing locally. Without the `close` listener the box never goes away.

## Let the user move the box

Pass `adjustable = true` for a drag strip along the top and a resize corner at the bottom-right:

```julia
Floating("load"; anchor = Screen(320, 180), mount = "charts", adjustable = true)
```

From then on the user owns where that box sits.

- A drag re-anchors the float to a [`Screen`](@ref) point, so it stops following whatever it named.
- The viewer reports the box on release. The server records that rect per float id and stamps it onto
  every later declaration of that float. The anchor becomes the screen point, and the size joins the
  float's own `style`. You need no listener for this.
- **A declared rect seeds a box when the box is created. It cannot move a box already on screen.**
  A new `anchor` or `style` for a float the user dragged changes nothing they can see.

To put a dragged box back where your declaration says, declare the set without that float and declare
it again. A rect lives exactly as long as its float, and every rect is forgotten when
[`install_scene!`](@ref) replaces the scene.

## Change the content on every keyframe

An `html` float keyframes its content by default. Supply one value per keyframe in the window
addressed to `:ui`, keyed by the float's id. The values are positional from that window's first
frame:

```julia
push_window(server, Dict(:ui => (; tracks = Dict("pinned" => (; html = fragments))),
                         :primitives => scene);
            start_frame = 1, count = 24, dt_seconds = 600, total_frames = 24)
```

The viewer applies the value on each crossing, with no event and no round trip. A keyframe a track
says nothing about keeps the value it had.

Two conditions to plan for:

- A float declared while a scene plays shows its declared content until a window that carries its
  track arrives. Every buffered window was built before the float existed. If you declare one in
  answer to an event, push a `:replace` window over where the clock is.
- A mounted float keyframes no field here. Its per-keyframe data reaches it through the window
  addressed to that module.

Watch the size. An SVG plot is easily 20–50 KB, and one per keyframe is a large share of a window
otherwise measured in hundreds of kilobytes. The track carries only the frames the window covers, so
you choose how finely the content changes.

## Next

- [UI vocabulary](../reference/ui.md) — `Floating`, the anchors and `declare_floating`.
- [Events and commands](../reference/events.md) — the `ui/close` and `ui/rect` topics.
- [Why the server decides](../explanation/server-authoritative.md) — why a rect is the exception.
