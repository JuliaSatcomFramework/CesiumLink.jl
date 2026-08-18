# Everything on top of the globe is one ordered list. Julia owns its composition order, and
# re-declaring replaces it wholesale — removing a legend means declaring without it. The declaration
# is retained by the server, so a reconnecting browser comes back to the same overlay and to the
# values its scene was actually filtered with.
#
# Nothing about what a control *means* leaves Julia: the `ui` module builds a generic widget per
# entry, shows the declared value, and reports the user's input on its `control` topic.

module UI

# What this vocabulary takes from the rest of the package, and the whole of it. The flat half reaches
# back for one name: `start_server` registers `watch_float_rects!`.
using ..CesiumLink: Server, Reply, EventListener, DEFAULT_DEBOUNCE_MS, command!, send_command,
                    legend_stops, to_wire_index, overlay_region, overlay_style

using JSON

export AbstractControl, Title, Legend, Toggle, Select, Group, declare_overlay
export Floating, Screen, Entity, World, declare_floating
export tooltip!

# The pairs the `ui` module answers. Both sides must agree on each one, and only this file writes it.
const UI_DECLARE  = ("ui", "declare")
const UI_FLOATING = ("ui", "floating")
const UI_RECT     = ("ui", "rect")
const UI_TOOLTIP  = ("ui", "tooltip")

"""
    AbstractControl

One entry of the overlay list. Subtype it to add a widget kind of your own: give it a
[`CesiumLink.UI.kind`](@ref) that some module registered under an owner-namespaced name, a
[`CesiumLink.UI.payload`](@ref) of the fields that widget reads, and a `region` field. A `style` field
is optional and travels when it is there.

Validation belongs in an **inner** constructor, so an exact-typed call cannot slip a value past it.
A control whose declaration would reject its own value must not be recorded: the widget would then
show one state while the scene is filtered by another.

A control `id` is a name the scene author invents, so it is a `String` on both sides of the wire and
a listener compares it against the same spelling the declaration used (ADR-0029). `region` names one
of a set CesiumLink holds, so it is a `Symbol`.

```julia
struct ShellPicker <: AbstractControl
    id::String
    label::String
    value::Int
    shells::Vector{String}
    region::Symbol
end
CesiumLink.kind(::ShellPicker) = "orbits.shell-picker"
CesiumLink.payload(c::ShellPicker) = (; c.id, c.label, c.value, c.shells)
```

## Content that follows the clock

A control whose payload carries `keyframed` names the fields a **window** may supply one value per
keyframe for, and the viewer applies them on each crossing with no event and no round trip. The
values ride the window addressed to the `ui` module, keyed by the control's `id`, positional from
that window's first frame:

```julia
struct Readout <: AbstractControl
    id::String
    text::String
    region::Symbol
end
CesiumLink.kind(::Readout) = "title"
CesiumLink.payload(c::Readout) = (; c.id, c.text, keyframed = ["text"])

declare_overlay(server, [Readout("load", "—", :top_left)])
push_window(server, Dict(:ui => (; tracks = Dict("load" => (; text = ["4.2 Gbps", "5.0 Gbps"]))),
                         :tracks => scene_payload);
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```

The declaration stays the whole structure: a track supplies the fields the declaration named and no
others, a keyframe a track says nothing about keeps the value it had, and a track naming a control
that is no longer declared is dropped. Keyframe the content a widget **displays** — a caption, a
readout, a colorbar's range. A value the user also owns, such as a toggle's state or a select's
choice, stays a re-declaration, where the precedence between an interaction and the timeline is
decided rather than raced.

## Declaring one mid-playback

A track rides a window, and windows are pushed ahead of the clock. **A keyframed widget or float
declared while a scene is already playing shows its declared value until a window carrying its track
arrives** — every window already buffered was built before it existed and addresses nothing to it, so
the wait is as long as the buffer. A scene that declares one in answer to an event therefore pushes a
window too, a `:replace` covering where the clock is, and the widget reads the keyframe on screen
from the moment it appears. This is a property of keyframing, not of any one widget kind: it holds
for a [`Floating`](@ref) pinned by a click exactly as it does for a control.
"""
abstract type AbstractControl end

"""
    CesiumLink.kind(c::AbstractControl) -> String

The widget kind `c` declares. A built-in is `"title"`, `"legend"`, `"toggle"` or `"select"`; anything
else must be registered by some module under that exact name, or the row is skipped with a warning.
"""
function kind end

"""
    CesiumLink.payload(c::AbstractControl) -> NamedTuple

The fields the widget of `c` reads, beside its `kind` and `region`.
"""
function payload end

# The region travels in the wire's own spelling, so the viewer needs no table to read it. An empty
# style is left off the wire entirely, so a declaration says only what it means to say.
JSON.lower(c::AbstractControl) =
    (; kind = kind(c), region = replace(String(c.region), '_' => '-'), _style(c)..., payload(c)...)

_style(c::AbstractControl) =
    hasproperty(c, :style) && !isempty(c.style) ? (; style = c.style) : (;)

"""
    Title(text; region = :top_center, style = nothing)
    Title(titles::AbstractDict; region = :top_center, style = nothing)

A caption. `text` is one string; `titles` maps a **1-based** absolute keyframe index to the text for
that keyframe. A keyframe the mapping says nothing about keeps the text it had, so a title declared
only where it changes reads correctly in between.

**A keyframe-keyed title is the only content the viewer chooses for itself.** It is handed every
string up front and picks one on each crossing, with no event, no round trip and no per-frame work on
this side — everything else that changes at a crossing was delivered in a window or answered on
request. That makes a per-frame readout free where the same thing on the tooltip path costs a round
trip per keyframe, and it is worth reaching for whenever the text is a function of the keyframe
alone. A title is plain text, not markup.
"""
struct Title <: AbstractControl
    text::Union{String,Nothing}
    frames::Union{Dict{Int,String},Nothing}
    region::Symbol
    style::Dict{String,String}
    # An INNER constructor so validation runs for every call form: an outer one is bypassed by an
    # exact-typed call straight to the auto-generated inner.
    function Title(text, frames, region; style = nothing)
        (text === nothing) == (frames === nothing) &&
            throw(ArgumentError("a title is either one string or a keyframe-keyed mapping"))
        frames === nothing || all(≥(1), keys(frames)) ||
            throw(ArgumentError("title keyframes are 1-based absolute indices"))
        return new(text, frames, overlay_region(region), overlay_style(style))
    end
end

Title(text::AbstractString; region = :top_center, style = nothing) =
    Title(String(text), nothing, region; style)
Title(titles::AbstractDict; region = :top_center, style = nothing) =
    Title(nothing, Dict{Int,String}(Int(k) => String(v) for (k, v) in titles), region; style)

kind(::Title) = "title"
# A keyframe key is an index, so it converts to the 0-based form the wire carries. `to_wire_index`
# and `from_wire_index` in `codec.jl` are that conversion; every site that needs it calls one.
payload(t::Title) = t.frames === nothing ? (; text = t.text) :
    (; frames = Dict(string(to_wire_index(k)) => v for (k, v) in t.frames))

"""
    Legend(title, min, max, cmap; region = :top_left, style = nothing)

A colorbar: the gradient of the colormap `cmap` between the values `min` and `max`. Passing the same
colormap value that coloured the entities is what keeps the bar from drifting from what is on
screen — see [`CesiumLink.rgba`](@ref) for the accepted colormap forms.
"""
struct Legend <: AbstractControl
    title::String
    min::Float64
    max::Float64
    stops::Vector{Tuple{Float64,String}}
    region::Symbol
    style::Dict{String,String}
    function Legend(title, min, max, stops, region; style = nothing)
        isempty(stops) && throw(ArgumentError("a legend needs at least one colour stop"))
        # The four-argument form takes a colormap and the five-argument form takes the stops it
        # lowers to, so the fourth argument means two things. Reject the colormap here: destructuring
        # one runs off into the characters of `"#rrggbb"` and reports that instead.
        all(s -> s isa Tuple || s isa Pair, stops) ||
            throw(ArgumentError("the five-argument Legend takes colour stops, not a colormap — " *
                                "write Legend(title, min, max, cmap; region)"))
        st = [(Float64(f), String(c)) for (f, c) in stops]
        all(0 ≤ f ≤ 1 for (f, _) in st) ||
            throw(ArgumentError("legend stop fractions lie in [0, 1]"))
        return new(String(title), Float64(min), Float64(max), st, overlay_region(region),
                   overlay_style(style))
    end
end

Legend(title, min, max, cmap; region = :top_left, style = nothing) =
    Legend(title, min, max, legend_stops(cmap), region; style)

kind(::Legend) = "legend"
payload(l::Legend) = (; l.title, l.min, l.max, l.stops)

"""
    Toggle(id, label, value; region = :bottom_right, style = nothing)

A checkbox. `value` is the `Bool` the server declares; the widget shows it and reports the box the
user clicked on the `ui` module's `control` topic, under `id`.
"""
struct Toggle <: AbstractControl
    id::String
    label::String
    value::Bool
    region::Symbol
    style::Dict{String,String}
    function Toggle(id, label, value, region; style = nothing)
        value isa Bool || throw(ArgumentError("a toggle's value is a Bool (got $(repr(value)))"))
        return new(String(id), String(label), value, overlay_region(region), overlay_style(style))
    end
end

Toggle(id, label, value; region = :bottom_right, style = nothing) =
    Toggle(id, label, value, region; style)

kind(::Toggle) = "toggle"
payload(t::Toggle) = (; t.id, t.label, t.value)

"""
    Select(id, label, value, options; region = :bottom_right, style = nothing)

A dropdown over `options`, a vector of `value => label` pairs. `value` is the option the server
declares and must be one of them: a declaration that rejects its own value must not be recorded, or
the widget would show one state while the scene is filtered by another.

An option's value travels as JSON and reaches the `control` listener as whatever JSON carries it
back. A `Symbol` option is therefore recorded as a `String` here (ADR-0029), so the value the
listener reports is one of the options this declaration holds and declaring the list again with it
is accepted.
"""
struct Select <: AbstractControl
    id::String
    label::String
    value::Any
    options::Vector{Pair{Any,String}}
    region::Symbol
    style::Dict{String,String}
    function Select(id, label, value, options, region; style = nothing)
        as_value(v) = v isa Symbol ? String(v) : v
        opts = Pair{Any,String}[as_value(v) => String(l) for (v, l) in options]
        isempty(opts) && throw(ArgumentError("a select needs at least one option"))
        val = as_value(value)
        any(isequal(val) ∘ first, opts) ||
            throw(ArgumentError("select value $(repr(value)) is not one of its options"))
        return new(String(id), String(label), val, opts, overlay_region(region),
                   overlay_style(style))
    end
end

Select(id, label, value, options; region = :bottom_right, style = nothing) =
    Select(id, label, value, options, region; style)

kind(::Select) = "select"
payload(s::Select) =
    (; s.id, s.label, s.value, options = [(; value = v, label = l) for (v, l) in s.options])

"""
    Group(controls; region = :bottom_right, style = nothing)

One box holding several controls, so related controls read as one thing rather than as a stack of
separate boxes. The group's `region` places the box; the `region` of a control inside it says
nothing. A control still reports under its own `id`, exactly as a top-level one does.

The box is a column of its children, so laying two legends side by side is one property:

```julia
Group([Legend("Sat Throughput (Gbps)", 0, 12, SAT_CMAP),
       Legend("Cell Satisfaction", 0, 1, CELL_CMAP)];
      region = :top_left, style = (; flex_direction = "row"))
```

A group does not nest: one level is what grouping related controls needs, and a box inside a box
buys nothing the region stack does not already give.
"""
struct Group <: AbstractControl
    controls::Vector{AbstractControl}
    region::Symbol
    style::Dict{String,String}
    function Group(controls, region; style = nothing)
        cs = collect(AbstractControl, controls)
        isempty(cs) && throw(ArgumentError("a group needs at least one control"))
        any(c -> c isa Group, cs) && throw(ArgumentError("a group does not nest inside a group"))
        return new(cs, overlay_region(region), overlay_style(style))
    end
end

Group(controls; region = :bottom_right, style = nothing) = Group(controls, region; style)

kind(::Group) = "group"
payload(g::Group) = (; g.controls)

"""
    declare_overlay(server::Server, items) -> Int

Declare `items` as the **whole** overlay: one ordered list of [`AbstractControl`](@ref)s, addressed
at the `ui` module's `declare` topic. Re-declaring replaces the previous list, so removing a widget
means declaring without it, and the list's order is the order the widgets stack in within a region.
Returns the number of clients it was queued for.

The declaration is retained, so a browser connecting later comes back to the same overlay. A widget
always shows the value it was declared with: after answering a `ui/control` event, declare the list
again — with the new value if it was applied, with the old one if it was not — and the widget ends up
showing the state the scene is actually in.

```julia
declare_overlay(server, [
    Title(titles; region = :top_left),
    Legend("Throughput [Gbps]", 0, 12, CMAP; region = :top_right),
    Toggle("isl", "ISL links", true),
    Select("cells", "Cells", "served", ["all" => "All", "served" => "Served"]),
])
```
"""
declare_overlay(server::Server, items) =
    send_command(server, UI_DECLARE..., collect(AbstractControl, items))

# --- floating objects -----------------------------------------------------------------------------

"""
    Screen(x, y)

A float anchored to a fixed point of the viewer, in pixels from its top-left corner. The point is the
box's own top-left, exactly: the box only moves to stay inside the viewer. It stays where it was put
however the camera moves.

[`Entity`](@ref) and [`World`](@ref) name a thing the box must not cover, so a box anchored that way
sits a short distance beside the point instead.
"""
struct Screen
    x::Float64
    y::Float64
end

"""
    Entity(module_id, kind, idx)

A float anchored to an entity, which it then follows: `idx` is the **1-based** index of entity `kind`
in the module `module_id` draws, and travels 0-based like every other entity index.

Anchoring this way is a module capability rather than a property of the vendored renderer. The
viewer asks *that* module where the entity is, so a module owning entities is anchorable exactly when
it exports `positionOf(kind, idx)` — `primitives` does. A float naming a module that does not, or one
the viewer never loaded, hides rather than failing.
"""
struct Entity
    module_id::String
    kind::String
    idx::Int
    function Entity(module_id, kind, idx)
        i = Int(idx)
        i ≥ 1 || throw(ArgumentError("an entity index is 1-based (got $(repr(idx)))"))
        return new(String(module_id), String(kind), i)
    end
end

"""
    World(lon, lat, height = 0)

A float anchored to a point on the globe, in geodetic degrees and metres like [`CesiumLink.Primitives.Areas`](@ref). The
box follows that point as the camera moves, and hides while the point does not project.
"""
struct World
    lon::Float64
    lat::Float64
    height::Float64
end

World(lon, lat) = World(lon, lat, 0)

# The anchor kind travels as a tag beside its own fields, so the viewer reads it without a table.
# An `Entity` anchor names an entity by index, so the index converts to the 0-based form the wire
# carries — `to_wire_index` and `from_wire_index` in `codec.jl` are that conversion.
JSON.lower(a::Screen) = (; anchor = "screen", a.x, a.y)
JSON.lower(a::Entity) = (; anchor = "entity", var"module" = a.module_id, a.kind,
                         idx = to_wire_index(a.idx))
JSON.lower(a::World) = (; anchor = "world", a.lon, a.lat, a.height)

const Anchor = Union{Screen,Entity,World}

"""
    Floating(id; anchor, html=nothing, mount=nothing, closable=true, adjustable=false,
             keyframed=nothing, style=nothing)

A box of server-authored content at a point on screen rather than in a corner region. Declare a set
of them with [`declare_floating`](@ref).

- **`id`** is how a later declaration updates or removes this float, and how a window's tracks
  address its keyframed fields. It is chosen here and is **not** the anchor: a float showing a plot
  has no entity, and one anchored to an entity still needs an identity independent of it.
- **`anchor`** is a [`Screen`](@ref), an [`Entity`](@ref) or a [`World`](@ref) point.
- **`html`** is a fragment mounted in its own shadow root, so its `<style>` reaches nothing else and
  no `<script>` in it runs. **`mount`** names a module instead, which is handed a plain element and
  owns everything inside it — plain rather than shadowed, because a library that installs its
  stylesheet in `document.head` gets nothing of it across a shadow boundary. Exactly one of the two.
- **`closable`** draws a close button. Clicking it notifies the server on the `ui` module's
  `close` topic, carrying this `id`; **the float goes away when the server declares the set without
  it**, so a scene that wants dismissal registers that listener. Without this, every scene
  reimplements "click empty space to dismiss" in its own click listener.
- **`adjustable`** lets the user move the box by a strip along its top and resize it from its
  bottom-right corner. On release the viewer reports the box on the `ui` module's `rect` topic,
  carrying `id` and the box in container pixels. **The user then owns where that box sits**: a drag
  re-anchors the float to a [`Screen`](@ref) point, so it stops following whatever it named, and it
  ignores the anchor and the size of every later declaration for as long as the box lives. The
  server records the rect and stamps it onto every later declaration of that float, so a browser
  that reloads or connects later opens the box where the user left it. The rect is forgotten when a
  declaration omits that float, and every rect is forgotten when [`CesiumLink.install_scene!`](@ref) replaces
  the scene. Declaring the set without that float and declaring it again therefore puts it back
  where the declaration says.
- **`keyframed`** names the fields a window may supply one value per keyframe for, as
  [`AbstractControl`](@ref) documents. It defaults to `("html",)` for an html float and to nothing
  for a mounted one, whose per-keyframe data reaches it through the window addressed to that module
  rather than through this box.

```julia
declare_floating(server, [
    Floating("pinned"; anchor = Entity("primitives", "sat", 12), html = "<b>Satellite 12</b>"),
    Floating("load"; anchor = Screen(320, 180), mount = "charts", style = (; width = "360px")),
])
```

**A large fragment is a size decision.** An SVG plot is easily 20–50 KB, and keyframed across a
window's frames that is material against a window otherwise measured in hundreds of KB — unlike a
tooltip's kilobyte. The track carries only the frames the window covers, so how finely the content
changes is the scene author's choice.
"""
struct Floating
    id::String
    anchor::Anchor
    html::Union{String,Nothing}
    mount::Union{String,Nothing}
    closable::Bool
    adjustable::Bool
    keyframed::Vector{String}
    style::Dict{String,String}
    # An INNER constructor so validation runs for every call form: an outer one is bypassed by an
    # exact-typed call straight to the auto-generated inner.
    function Floating(id, anchor, html, mount, closable, adjustable, keyframed, style)
        (html === nothing) == (mount === nothing) &&
            throw(ArgumentError("a float shows either html or a mounted module, not both and not " *
                                "neither"))
        fields = String[String(f) for f in keyframed]
        bad = setdiff(fields, ["html"])
        isempty(bad) ||
            throw(ArgumentError("a float's only keyframed field is html (got $(join(bad, ", ")))"))
        mount === nothing || isempty(fields) ||
            throw(ArgumentError("a mounted float takes its per-keyframe data from the window " *
                                "addressed to that module, so it keyframes no field here"))
        return new(String(id), anchor, html === nothing ? nothing : String(html),
                   mount === nothing ? nothing : String(mount), Bool(closable), Bool(adjustable),
                   fields, overlay_style(style))
    end
end

Floating(id; anchor, html = nothing, mount = nothing, closable = true, adjustable = false,
         keyframed = nothing, style = nothing) =
    Floating(id, anchor, html, mount, closable, adjustable,
             keyframed === nothing ? (html === nothing ? () : ("html",)) : keyframed, style)

# `f` with a different anchor and style, everything else as declared. Written here rather than at
# each call site: the full positional form has two adjacent `Bool`s, and swapping them type-checks.
Floating(f::Floating; anchor = f.anchor, style = f.style) =
    Floating(f.id, anchor, f.html, f.mount, f.closable, f.adjustable, f.keyframed, style)

# A float says only what it means to say: the content kind it does not have, an empty style, an
# empty keyframed list and an unadjustable box are all left off the wire.
JSON.lower(f::Floating) =
    (; f.id, anchor = f.anchor, f.closable,
     (f.adjustable ? (; f.adjustable) : (;))...,
     (f.html === nothing ? (; f.mount) : (; f.html))...,
     (isempty(f.keyframed) ? (;) : (; f.keyframed))...,
     (isempty(f.style) ? (;) : (; f.style))...)

"""
    declare_floating(server::Server, items) -> Int

Declare `items` as the **whole** set of floating objects, addressed at the `ui` module's `floating`
topic. Re-declaring replaces the set, so removing one float means declaring without it, and a float
whose declaration is unchanged keeps the box it already had — including a mounted module, which is
not torn down and rebuilt by a move or a restyle. Returns the number of clients it was queued for.

The set is retained, so a browser connecting later comes back to the same floats. Nothing about them
is remembered beyond the declaration itself: pinning something is declaring a float, and unpinning it
is declaring the set without that float.

**Where the user has put an adjustable box beats what `items` says about it.** The server records
the rect the viewer reports for a float and stamps it onto every later declaration of that float:
the anchor becomes the [`Screen`](@ref) point the user dragged the box to, and the size joins the
float's own `style`. A scene therefore needs no listener of its own to keep a dragged box in place —
see [`Floating`](@ref) for how a rect is forgotten.

```julia
on_pointer(server; type = :click) do ev, reply
    ev.entity === nothing && return nothing
    pins[ev.entity.idx] = Floating("pin\$(ev.entity.idx)";
                                   anchor = Entity("primitives", ev.entity.kind, ev.entity.idx),
                                   html = "<b>\$(ev.entity.kind) \$(ev.entity.idx)</b>")
    declare_floating(server, values(pins))
end

# The close button sends `ui/close` with the float's id. The viewer removes nothing.
# This listener drops the float from the set, then declares the set again.
on_event(server, "ui", "close") do ev, reply
    delete!(pins, parse(Int, replace(ev.payload.id, "pin" => "")))
    declare_floating(server, values(pins))
end
```
"""
function declare_floating(server::Server, items)
    set = collect(Floating, items)
    lock(server.clients_lock) do
        server.declared_floats = set
        # A rect lives exactly as long as the float it belongs to. Declaring the set without a float
        # and declaring it again is therefore how a scene puts that box back where it says.
        filter!(p -> any(f -> f.id == first(p), set), server.float_rects)
    end
    return send_floats(server, set)
end

# The declared set `items` with every recorded rect stamped on. A drag re-anchors the float to the
# screen and a resize joins its style, so an override needs no field of its own on the wire. The
# style is merged rather than replaced: the size is the user's, the rest is still the author's.
function stamp_rects(items, rects)
    stamped(f, r) = Floating(f; anchor = Screen(r.x, r.y),
                             style = merge(f.style, Dict("width" => "$(r.w)px",
                                                         "height" => "$(r.h)px")))
    return Floating[haskey(rects, f.id) ? stamped(f, rects[f.id]) : f for f in items]
end

# Broadcast `set` as the `ui` module's declared floats, stamped with what the user has done to them.
# What the server retains is therefore what the user last saw, which is what a browser connecting
# later is replayed.
function send_floats(server::Server, set)
    rects = lock(server.clients_lock) do
        copy(server.float_rects)
    end
    return send_command(server, UI_FLOATING..., stamp_rects(set, rects))
end

# CesiumLink's own listener on the `ui` module's `rect` topic: record where the user left the box and
# re-send the declared set, stamped.
#
# The re-send is what makes a reload work. `retained` holds one message per (module, topic), so a
# stamp reaches a late client only when a declaration is actually sent — a scene that declares its
# floats on a click would otherwise leave the retained copy stale until the next click.
#
# The re-broadcast moves nobody's live box: a declared rect seeds a box when it is created and is
# ignored for one already on screen.
function watch_float_rects!(server::Server)
    record = function (ev, reply)
        p = ev.payload
        set = lock(server.clients_lock) do
            # The size travels as CSS, so it is rounded to whole pixels here rather than reaching a
            # style as `360.0px`.
            server.float_rects[String(p.id)] = (; x = Float64(p.x), y = Float64(p.y),
                                                w = round(Int, p.w), h = round(Int, p.h))
            server.declared_floats
        end
        # Nothing declared yet, so there is nothing to stamp. Sending here would declare the empty
        # set and take every box off the screen.
        isempty(set) || send_floats(server, set)
        # Never `:halt`: a scene watching the same topic must still run.
        return nothing
    end
    # Registered straight onto the registry rather than through `on_event`, which re-declares the
    # pointer subscription. This listener asks for no pointer event, so it would declare exactly what
    # the previous declaration said and a server driving no scene would retain that empty list.
    lock(server.clients_lock) do
        push!(server.listeners, EventListener(record, UI_RECT...))
    end
    return server
end

# The `ui` module's tooltip, which is a command like any other — it is addressed here rather
# than beside `command!` because knowing that a module called `ui` has a `tooltip` topic is this
# file's business and not the event chain's.

# The fragments already contributed, or none when this is the first contribution. Anything else
# sitting on `ui/tooltip` is not a fragment list and is replaced rather than added to.
function tooltip_so_far(reply::Reply)
    i = findfirst(c -> (c.module_id, c.topic) == UI_TOOLTIP, reply.commands)
    i === nothing && return String[]
    html = reply.commands[i].payload isa NamedTuple ?
        get(reply.commands[i].payload, :html, nothing) : nothing
    return html isa Vector{String} ? html : String[]
end

"""
    tooltip!(f, reply::Reply; bare=false) -> Reply

Contribute a tooltip fragment, written to the `IO` handed to `f`. Julia is the only author of
tooltip content: a tooltip is a hover listener contributing HTML through the same command mechanism
as anything else, addressed at the `ui` module on its `tooltip` topic.

Several listeners may each contribute. The fragments accumulate **as a list**, in chain order, and
travel as one `ui/tooltip` command, so one hover paints one tooltip however many listeners spoke.
The list is the only boundary there is: `ui` mounts each fragment in its own shadow root, so inside
its own fragment a contributor owns markup and styling completely without reaching another's.

`bare` drops the `ui` module's own chrome so the contributed markup owns the whole box.

A tooltip is stateless: it follows the cursor and is replaced wholesale on the next pointer move.
Content that should stay put while the cursor moves on is a [`Floating`](@ref) object instead, which
has an identity, an anchor of its own and a lifetime the server controls — and several of those can
stand at once.

The HTML reaches the browser unsanitised — this is a trusted local viewer.

```julia
on_pointer(server; type = :hover) do ev, reply
    ev.entity === nothing && return nothing
    tooltip!(reply) do io
        print(io, "<b>", titlecase(ev.entity.kind), " #", ev.entity.idx, "</b>")
    end
end
```
"""
function tooltip!(f, reply::Reply; bare = false)
    io = IOBuffer()
    f(io)
    html = push!(copy(tooltip_so_far(reply)), String(take!(io)))
    return command!(reply, UI_TOOLTIP..., (; html, bare = Bool(bare)))
end

end # module UI
