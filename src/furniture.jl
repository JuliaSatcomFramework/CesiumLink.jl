# Furniture is an item the Core puts on screen itself, before any module loads: the animation clock,
# the timeline ruler, the keyframe readout and the corner buttons (ADR-0015). The server states the
# whole set in one declaration, and the overlay regions those items and every module's controls sit
# in are styled the same way.
#
# Both entry points are flat in `CesiumLink` rather than in `CesiumLink.UI`. A region exists and can
# be contributed to with no `ui` module loaded, so it is a Core concept and not one module's
# vocabulary. The region helpers below live here for the same reason; `UI` reaches them by name.

# The pairs the Core answers on itself. Both sides must agree on each one.
const CORE_FURNITURE = ("core", "furniture")
const CORE_REGIONS   = ("core", "regions")

# The furniture set the session states, as the declaration carries it, or `nothing` when the session
# declares none. It reads the retained `core/furniture` command, so the declaration and the replay
# that follows it say the same thing and the retention stays the one source of the set.
declared_furniture(server::Server) = declared(server, CORE_FURNITURE...)

# Where a widget may sit. Each names a region the Core positions and stacks controls within; a
# module never absolute-positions its own overlay.
const OVERLAY_REGIONS = (:top_left, :top_center, :top_right, :bottom_right)

function overlay_region(r)
    s = Symbol(r)
    s in OVERLAY_REGIONS ||
        throw(ArgumentError("an overlay region is one of $(OVERLAY_REGIONS) (got $(repr(r)))"))
    return s
end

# A region travels in the wire's own spelling, so the viewer needs no table to read it.
wire_region(r) = replace(String(overlay_region(r)), '_' => '-')

"""
    overlay_style(style) -> Dict{String,String}

The CSS a control carries, as the viewer merges it: `_` lowers to `-` in a property name, so
`(; flex_direction = "row")` travels as `flex-direction`. `nothing` is no CSS at all.
"""
overlay_style(::Nothing) = Dict{String,String}()
overlay_style(style) =
    Dict{String,String}(replace(String(k), '_' => '-') => string(v) for (k, v) in pairs(style))

"""
    declare_furniture(server::Server; timeline=true, animation=true, keyframe=true,
                      camera_follow=true, scene_mode=true, fullscreen=true, home=true,
                      projection=false, basemap=true, annotations=true, nav_help=false,
                      inspector=false, canvas_capture=false, region=:top_right,
                      style=nothing) -> Int

Declare which of the Core's own on-screen items are shown, as the **whole** set. Returns the number
of clients it was queued for.

Each call is a full statement, not a patch. Two calls do not accumulate: an item this call does not
name takes its default, whatever an earlier call said about it. So `declare_furniture(server)`
returns every item to its default. The declaration is retained, so a browser connecting later comes
back to the same furniture: it rides the session declaration that browser is built from, so the set
is on screen at the first paint and no item the session hides appears at all.

The first four items are the **band** along the bottom edge: the timeline ruler, the animation
clock, the readout naming the keyframe the scene's values come from, and the indicator that says who
holds the camera. The other nine are one **group** of buttons that travels whole into `region`, one
of `$(OVERLAY_REGIONS)`. `style` is CSS merged over the group's own rule, with `_` lowered to `-` as
everywhere else.

`canvas_capture` is the button that makes a **canvas capture**: a left click copies one to the
clipboard, and a right click opens the popup that downloads one. It is off by default, so no scene
grows a button it did not ask for. The button and [`capture_canvas`](@ref) are independent doors on
the same picture, and a session that leaves this button off still captures from Julia.

`basemap` is the picker the reader chooses a basemap with. It is on by default and hides itself
while the session declares fewer than two. One declared basemap is therefore already the whole
opt-out. This keyword is for a session that declares a set and needs no picker over it. See
[`Imagery`](@ref).

`annotations` is the cell that opens onto the place names and the country borders, one checkbox
each. Both layers are drawn by default, so the cell is on by default too: it is the only way a
reader takes one off. Turning the cell off leaves whatever [`start_server`](@ref) declared on the
globe, since a tick is the reader's own view and never travels back to the server.

`camera_follow` governs the indicator only, not the camera. The viewer shows it once a viewpoint
arrives, and offers the way back to a user who took the camera with a drag. A session that declares
it off still ignores viewpoints after the user takes the camera; it just says nothing about it. See
[`declare_camera`](@ref).

The defaults here mirror the viewer's own table (the wire protocol reference, `core/furniture`),
which is what a session that declares nothing shows.

A scene whose one keyframe names no instant — a statistic drawn on the globe rather than a state at
a time — takes the whole band down:

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

The viewer obeys a declaration that hides the ruler over a longer range, and warns that it strands
the frames after the first.
"""
function declare_furniture(server::Server;
                           timeline = true, animation = true, keyframe = true,
                           camera_follow = true, scene_mode = true, fullscreen = true,
                           home = true, projection = false, basemap = true, annotations = true,
                           nav_help = false, inspector = false, canvas_capture = false,
                           region = :top_right, style = nothing)
    # Every item ships every time, in the wire's camelCase. Omitting one is not a patch.
    items = (; timeline, animation, keyframe, cameraFollow = camera_follow,
             sceneMode = scene_mode, fullscreen, home,
             projection, basemap, annotations, navHelp = nav_help, inspector,
             canvasCapture = canvas_capture)
    payload = (; items, region = wire_region(region))
    css = overlay_style(style)
    # An empty style is left off the wire entirely, so a declaration says only what it means to say.
    isempty(css) || (payload = (; payload..., style = css))
    return send_command(server, CORE_FURNITURE..., payload)
end

"""
    declare_regions(server::Server, bags::AbstractDict) -> Int

Declare the CSS of the Core's overlay regions, as the **whole** set: a region absent from `bags`
returns to its Core default. Keys are region names, values are CSS bags with `_` lowered to `-`.
Returns the number of clients it was queued for.

```julia
declare_regions(server, Dict(:top_right => (; flex_direction = "column", gap = "12px")))
```

The Core owns placement (ADR-0004), so the viewer refuses `position`, `top`, `right`, `bottom`,
`left`, `transform`, `z-index` and `inset`. A refusal warns in the browser console and drops that
property only; the rest of that region's bag still applies.
"""
declare_regions(server::Server, bags::AbstractDict) =
    send_command(server, CORE_REGIONS...,
                 Dict(wire_region(k) => overlay_style(v) for (k, v) in bags))
