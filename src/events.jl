# Events travel up, commands travel down, and the listener registry is what connects them.
#
# Registering a listener is the only step: the server unions every pointer listener's interest into
# the subscription it declares to the viewer, and re-declares whenever the set changes. The viewer
# forwards a pointer event only when it matches an entry, so it never sends one nobody is waiting
# for, and the two cannot disagree about what is wanted.

# The debounce a hover listener asks for unless it names a shorter one. Hover is the only event that
# fires per rendered move, so it is the only one an interval applies to.
const DEFAULT_DEBOUNCE_MS = 5

const POINTER_TYPES = (:hover, :click)

# The pairs the Core addresses on its own behalf. A module's own topics are that module's business —
# these are the ones CesiumLink itself both writes and reads, so both sides must agree.
const CORE_WINDOW    = ("core", "window")
const CORE_NEED      = ("core", "need")
const CORE_POINTER   = ("core", "pointer")
const CORE_CLOCK     = ("core", "clock")
const CORE_KEYFRAME  = ("core", "keyframe")
const CORE_SUBSCRIBE = ("core", "subscribe")
const CORE_ELLIPSOID = ("core", "ellipsoid")
const CORE_STOP      = ("core", "stop")
const CORE_DROPPED   = ("core", "dropped")
const CORE_REPLAY    = ("core", "replay")

"""
    EventListener

One registered interest in the events the viewer sends: which `(module_id, topic)` pair it answers,
and — for the Core's `pointer` topic — which events it wants forwarded at all. Create one with
[`on_event`](@ref) or [`on_pointer`](@ref); the subscription declared to the viewer is derived from
the registered set.
"""
struct EventListener
    f::Any
    module_id::String
    topic::String
    # `nothing` is "don't care" throughout: for `type` the entry matches either kind, and for each
    # modifier it matches whether or not that key is held. `true` requires it, `false` forbids it.
    type::Union{Symbol,Nothing}
    alt::Union{Bool,Nothing}
    ctrl::Union{Bool,Nothing}
    shift::Union{Bool,Nothing}
    coordinate::Bool
    debounce_ms::Int
end

# A listener on any topic but `core/pointer`: no subscription narrows it, so every pointer field
# takes the value that asks for nothing.
EventListener(f, module_id::AbstractString, topic::AbstractString) =
    EventListener(f, String(module_id), String(topic), nothing, nothing, nothing, nothing,
                  false, DEFAULT_DEBOUNCE_MS)

# The modifiers, in the order the viewer reports a held set. Each is also the name of the
# `EventListener` field and the `on_event` keyword that narrows on it.
const POINTER_MODS = (:alt, :ctrl, :shift)

"""
    Command(module_id, topic, payload)

One entry of a `commands` batch: the module it is addressed to, its topic, and an opaque payload.
The viewer routes it by `(module, topic)` without interpreting the payload; the pseudo-module id
`"core"` addresses the Core itself.
"""
struct Command
    module_id::String
    topic::String
    payload::Any
end

JSON.lower(c::Command) = Dict("module" => c.module_id, "topic" => c.topic, "payload" => c.payload)

"""
    Reply

The command batch a chain of listeners is building for one event. Every listener answering an event
shares one, so a single event produces a single reply however many listeners had something to say.
"""
mutable struct Reply
    commands::Vector{Command}
end

Reply() = Reply(Command[])

"""
    command!(reply::Reply, module_id, topic, payload) -> Reply

Address a command at `(module_id, topic)` in the batch `reply` is building. The viewer routes it by
that pair without interpreting the payload, so what a topic means is the receiving module's
business. Arrays anywhere in `payload` are encoded when the batch is sent.

**Last writer wins per `(module, topic)`**: a second command for the same pair replaces the first
where it stood, since two instructions on one topic would only race each other in the module.

```julia
command!(reply, "charts", "focus", (; site = "throughput"))
```
"""
function command!(reply::Reply, module_id::AbstractString, topic::AbstractString, payload)
    m, t = String(module_id), String(topic)
    c = Command(m, t, payload)
    i = findfirst(x -> x.module_id == m && x.topic == t, reply.commands)
    i === nothing ? push!(reply.commands, c) : (reply.commands[i] = c)
    return reply
end

# Both registration verbs end here: check the listener, add it, and re-declare what the registered
# set adds up to. A listener may annotate its arguments, so the arity check is `methods(f, ...)` and
# not `hasmethod` — `hasmethod(f, Tuple{Any,Any})` is false for an annotated listener, since `Any` is
# not a subtype of the annotation. Type intersection admits it and still rejects a wrong arity.
function register!(server, listener::EventListener)
    isempty(methods(listener.f, Tuple{Any,Any})) &&
        throw(ArgumentError("an event listener is called as f(ev, reply), and " *
                            "$(repr(listener.f)) has no method taking two arguments"))
    lock(server.clients_lock) do
        push!(server.listeners, listener)
    end
    declare_subscription!(server)
    return listener
end

"""
    on_event(f, server::Server, module_id::AbstractString, topic::AbstractString)

Register `f` to answer the events the viewer sends on `(module_id, topic)`. The Core raises
`core/need`, `core/clock` and `core/keyframe`; anything else comes from a module's own
`ctx.notify`, under that module's id. `f` is called as `f(ev, reply)`, and one that cannot be is refused at registration.

Two Core topics say where the animation is and where it is going, which is what a scene builds
frames ahead of `core/need` from:

- `core/clock` — `ev.multiplier` is signed: its sign is the direction, its size the speed, in
  mission seconds per real second. `ev.playing` is the play/pause button. It arrives once at the
  start and again on every change.
- `core/keyframe` — `ev.index` is the **1-based** keyframe the clock just crossed into, forwards or
  backwards. It arrives only while the buffer covers the clock; an instant it does not cover raises
  `core/need` instead.

Pointer events have a subscription to narrow and are registered with [`on_pointer`](@ref) instead.

A name the scene author invents is a `String` on both sides of the wire, so a listener compares an
event against the same spelling the declaration used (ADR-0029): `ev.module_id`, `ev.topic`,
`ev.entity.kind` and a control's `id`. A `Symbol` names one choice out of a set CesiumLink itself
holds — `ev.type` and `ev.mods` are the two an event carries.

```julia
on_event(server, "ui", "control") do ev, reply
    @info "control changed" ev.payload.id ev.payload.value
end
```
"""
on_event(f, server, module_id::AbstractString, topic::AbstractString) =
    register!(server, EventListener(f, module_id, topic))

"""
    on_pointer(f, server::Server; type=nothing, alt=nothing, ctrl=nothing, shift=nothing,
               coordinate=false, debounce_ms=$DEFAULT_DEBOUNCE_MS)

Register `f` to answer the pointer events the viewer raises on `core/pointer`. `f` is called as
`f(ev, reply)`, exactly as an [`on_event`](@ref) listener is.

The keywords narrow what is wanted, and are what the declared subscription is computed from — no one
writes that list by hand:

| Keyword | Meaning |
|---|---|
| `type` | `:hover` or `:click`; `nothing` for either |
| `alt`, `ctrl`, `shift` | `true` requires that modifier held, `false` requires it not held, `nothing` does not care |
| `coordinate` | Ask for the globe coordinate under the cursor; the raycast is skipped when nobody does |
| `debounce_ms` | Hovers are forwarded at most this often; listeners on one interest share the smallest asked for |

Each modifier is its own keyword rather than a set, so a modifier cannot be named twice, has no order
to get wrong, and a misspelling is an unknown keyword Julia rejects at the call site. All three left
alone is any modifier state — a listener that does not mention modifiers wants the gesture however it
was made — so `alt = true` alone means "alt held, the rest as they come" and
`alt = ctrl = shift = false` means the bare gesture only.

The union of every listener's interest is declared to the viewer immediately and again whenever a
listener is added, so independent extensions compose without knowing about each other.

```julia
on_pointer(server; type = :click, alt = true) do ev, reply
    ev.entity === nothing && return nothing
    @info "alt-clicked" ev.entity.kind ev.entity.idx ev.frame
end
```
"""
function on_pointer(f, server; type = nothing, alt = nothing, ctrl = nothing, shift = nothing,
                    coordinate = false, debounce_ms = DEFAULT_DEBOUNCE_MS)
    type === nothing || Symbol(type) in POINTER_TYPES ||
        throw(ArgumentError("an event type is :hover or :click (got $(repr(type)))"))
    tri(x) = x === nothing ? nothing : Bool(x)
    return register!(server, EventListener(f, CORE_POINTER...,
                                           type === nothing ? nothing : Symbol(type),
                                           tri(alt), tri(ctrl), tri(shift),
                                           Bool(coordinate), Int(debounce_ms)))
end

"""
    off_event(server::Server, listener) -> Bool

Unregister the `listener` [`on_event`](@ref) or [`on_pointer`](@ref) returned, and re-declare the
subscription the remaining ones add up to. Returns whether it was still registered.

Removal is by identity, not by position: registration order is what the chain runs in, so anything
holding a listener must keep working when a listener ahead of it goes away.

```julia
l = on_pointer(server; type = :click) do ev, reply
    @info "clicked" ev.entity
end
off_event(server, l)
```
"""
function off_event(server, listener::EventListener)
    gone = lock(server.clients_lock) do
        i = findfirst(l -> l === listener, server.listeners)
        i === nothing ? false : (deleteat!(server.listeners, i); true)
    end
    gone && declare_subscription!(server)
    return gone
end

# A subscription entry names an exact modifier set or none at all, so it cannot say "alt held, the
# rest as they come". A listener that leaves some modifiers open is therefore expanded into every set
# consistent with what it did name — `alt = true` alone into four. Leaving all three open stays a
# single `nothing` entry, which is the wire's own way of saying any state. Sets come out in the order
# the viewer reports a held set, so an entry's `mods` needs no further sorting.
function mod_sets(l::EventListener)
    all(m -> getfield(l, m) === nothing, POINTER_MODS) && return Any[nothing]
    sets = [Symbol[]]
    for m in POINTER_MODS
        want = getfield(l, m)
        sets = [held ? push!(copy(s), m) : s
                for s in sets for held in (want === nothing ? (false, true) : (want,))]
    end
    return sets
end

"""
    pointer_subscription(listeners) -> Vector

The `core/subscribe` payload the registered `listeners` add up to: one entry per distinct
`(type, mods)` interest, in registration order, asking for the coordinate if any listener behind it
does and naming the smallest debounce any of them asked for. A listener that left some modifiers
open contributes one entry per set it covers, since an entry can only name a set exactly. Listeners
on other topics contribute nothing — only pointer events are subject to a subscription.
"""
function pointer_subscription(listeners)
    keys_in_order = Tuple{Union{Symbol,Nothing},Union{Vector{Symbol},Nothing}}[]
    coordinate = Dict{Any,Bool}()
    debounce = Dict{Any,Int}()
    for l in listeners
        (l.module_id, l.topic) == CORE_POINTER || continue
        for set in mod_sets(l)
            key = (l.type, set)
            if !haskey(coordinate, key)
                push!(keys_in_order, key)
                coordinate[key] = false
                debounce[key] = DEFAULT_DEBOUNCE_MS
            end
            coordinate[key] |= l.coordinate
            debounce[key] = min(debounce[key], l.debounce_ms)
        end
    end
    return [(; type = k[1] === nothing ? nothing : String(k[1]),
              mods = k[2] === nothing ? nothing : String.(k[2]),
              coordinate = coordinate[k], debounceMs = debounce[k]) for k in keys_in_order]
end

# Declare what the registered listeners add up to. Retained under ("core", "subscribe") like any
# other declaration-shaped command, so a reconnecting viewer forwards the same events again.
function declare_subscription!(server)
    entries = lock(server.clients_lock) do
        pointer_subscription(server.listeners)
    end
    return send_command(server, CORE_SUBSCRIBE..., entries)
end

# Every value in a payload reachable by name: the viewer's JSON objects become named tuples, so a
# listener writes `ev.payload.id` rather than indexing strings.
as_named(x) = x
as_named(v::AbstractVector) = Any[as_named(x) for x in v]
as_named(d::AbstractDict) = (; (Symbol(k) => as_named(v) for (k, v) in d)...)

# Both names are the drawing scene's own: the module that drew the entity, and the family it drew it
# in. A name the author invents is a `String` on both sides of the wire (ADR-0029).
const PointerEntity = NamedTuple{(:module_id, :kind, :idx),Tuple{String,String,Int}}

# The pointer-specific half of an event. The wire is 0-based and the Julia API is 1-based, so the
# entity index converts here, through `from_wire_index` in `codec.jl`.
function pointer_fields(payload)
    entities = PointerEntity[PointerEntity((String(e["module"]), String(e["kind"]),
                                            from_wire_index(Int(e["idx"]))))
                             for e in get(payload, "entities", Any[])]
    screen = get(payload, "screen", Dict{String,Any}())
    coord = get(payload, "coordinate", nothing)
    return (; type = Symbol(get(payload, "type", "hover")),
            entities,
            entity = isempty(entities) ? nothing : first(entities),
            mods = Tuple(Symbol(m) for m in get(payload, "mods", String[])),
            screen = (; x = get(screen, "x", 0), y = get(screen, "y", 0)),
            coordinate = coord === nothing ? nothing :
                (; lon = coord["lon"], lat = coord["lat"], height = coord["height"]))
end

"""
    build_event(params, region = UInt8[]) -> NamedTuple

The event a listener receives, from the `event` notification's `params`. Every event carries the
sequence number the answering batch echoes and where the clock was when it was raised — the
**1-based** `frame` and the identity of the `window` on screen — so a listener answers against the
scene the user was looking at. `core/pointer` adds the pick, the modifiers, the cursor and the
coordinate; `core/need` adds the **1-based** `start_frame`, the frame `count` asked for and the
`mode` the window is wanted in; `core/clock` adds the signed `multiplier` and `playing`;
`core/keyframe` adds the **1-based** `index` crossed into; everything else carries the module's own
`payload`.

A `core/need` naming `mode = :replace` is asking for a window that stands on its own, which is what a
client joining a scene already mid-run is answered with. A listener that always appends leaves such a
client with the window the server already holds: the server warns, and sends the retained `:append`
rather than nothing. That client then draws the part of the scene that window covers.

A pointer event's `entities` is everything under the cursor, nearest first, each a
`(module_id, kind, idx)`; `entity` is the nearest of them or `nothing`. The viewer reports the whole
stack because only a listener knows what these kinds mean — a highlight drawn over the shape it
belongs to is nearest and is rarely what the user aimed at, so a listener that cares scans for the
kind it wants rather than testing `entity` alone.

`region` is the frame's array bytes. Every encoded array in a module's `payload` names an offset into
it, the same way a payload travelling downward does, so a listener is handed the array rather than
the object that carried it. The four core topics are read field by field into the names above and
carry no payload of their own, so nothing in them is decoded.

A crossing carries its own `index` rather than leaving a listener to read `frame`: the opening
window crosses into its first keyframe before the clock has ticked once, and `frame` is `nothing`
until it has.
"""
function build_event(params, region = UInt8[])
    module_id = String(get(params, "module", ""))
    topic = String(get(params, "topic", ""))
    payload = get(params, "payload", Dict{String,Any}())
    frame = get(params, "frame", nothing)
    window = get(params, "window", nothing)
    base = (; module_id, topic,
            seq = get(params, "seq", nothing),
            frame = frame === nothing ? nothing : from_wire_index(Int(frame)),
            window = window === nothing ? nothing : Int(window))
    (module_id, topic) == CORE_POINTER && return (; base..., pointer_fields(payload)...)
    if (module_id, topic) == CORE_NEED
        return (; base..., start_frame = from_wire_index(Int(get(payload, "startFrame", 0))),
                count = Int(get(payload, "count", 2)),
                mode = Symbol(get(payload, "mode", "append")))
    end
    if (module_id, topic) == CORE_CLOCK
        return (; base..., multiplier = Float64(get(payload, "multiplier", 1)),
                playing = Bool(get(payload, "playing", false)))
    end
    (module_id, topic) == CORE_KEYFRAME &&
        return (; base..., index = from_wire_index(Int(get(payload, "index", 0))))
    return (; base..., payload = as_named(decode_arrays(payload, region)))
end

# Whether a listener wants this event. The subscription is a union, so an event forwarded for one
# listener reaches every listener on the same topic; each one's own narrowing is applied here.
function wants(l::EventListener, ev)
    haskey(ev, :type) || return true
    l.type === nothing || l.type === ev.type || return false
    for m in POINTER_MODS
        want = getfield(l, m)
        want === nothing || want == (m in ev.mods) || return false
    end
    return true
end

"""
    dispatch_event(server, params, region = UInt8[]) -> Reply

Run every listener registered for the event `params` describes, in registration order, over one
shared [`Reply`](@ref), and return it. A listener that throws loses its own contribution and is
logged; the ones behind it still run, because one broken extension must not take the rest down.

A listener returning `:halt` stops the chain there. What the listeners ahead of it contributed is
still in the reply and is still sent — halting withholds the listeners behind it, not the answer.
"""
function dispatch_event(server, params, region = UInt8[])
    module_id = get(params, "module", nothing)
    topic = get(params, "topic", nothing)
    (module_id === nothing || topic === nothing) && return Reply()
    listeners = lock(server.clients_lock) do
        EventListener[l for l in server.listeners
                      if l.module_id == module_id && l.topic == topic]
    end
    reply = Reply()
    isempty(listeners) && return reply
    ev = build_event(params, region)
    for l in listeners
        wants(l, ev) || continue
        try
            # invokelatest: a listener is typically registered after the listener task started, so a
            # direct call would run in that task's stale world age and miss the method.
            Base.invokelatest(l.f, ev, reply) === :halt && break
        catch e
            # With the backtrace: a listener that throws contributes nothing to the batch, and the
            # viewer shows no error of its own. The warning is the only report, so it must say where.
            @warn "event listener threw" module_id topic exception = (e, catch_backtrace())
        end
    end
    return reply
end

"""
    answer_event(server, params, region = UInt8[]) -> Reply

Run the listener chain over the event `params` describes and send what it contributed as one
`commands` batch, echoing the event's `seq` so a module can tell what the batch answers. Returns
the [`Reply`](@ref) the chain built, whether or not it was sent.

A chain that pushed a `:replace` window has its batch **dropped**: a replace may renumber entities,
so indices resolved against the scene the event was raised on address nothing now, and the fresh
state is already on its way.
"""
function answer_event(server, params, region = UInt8[])
    before = lock(server.clients_lock) do; server.window_id; end
    reply = dispatch_event(server, params, region)
    after = lock(server.clients_lock) do; server.window_id; end
    after == before && send_reply(server, reply; seq = get(params, "seq", nothing))
    return reply
end
