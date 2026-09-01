# Wire messages are JSON-RPC-2.0-shaped notifications with no `jsonrpc` field. See the wire
# protocol reference under `docs/src/reference/wire/`.

# The wire contract this package speaks. Time-varying scene data travels as the Core-level `window`
# message. A viewer announcing a different version is refused: every frame is binary, and a viewer
# that expects JSON receives one, fails to parse it and reports nothing at all.
const PROTOCOL_VERSION = 2

# The module contract the viewer's Core implements. A declared module whose `api_version` differs is
# skipped by the Core before its code is imported, so a stale bundle never half-runs.
const MODULE_API_VERSION = 1

"""
    commands_message(commands; seq=nothing) -> Frame

The `commands` notification wire frame: a batch of [`Command`](@ref)s the viewer applies in order,
routing each by `(module, topic)` without interpreting its payload. Arrays anywhere in a command's
payload are encoded into the frame's region on the way out. `seq` is present only when the batch
answers an event, and echoes that event's sequence number, so a module holding a reply can tell what
it was an answer to.
"""
function commands_message(commands; seq = nothing)
    region = IOBuffer()
    params = (; commands = [Command(c.module_id, c.topic, encode_arrays(c.payload, region))
                            for c in commands])
    seq === nothing || (params = (; seq, params...))
    return Frame(JSON.json((; method = "commands", params)), take!(region))
end

# The `core/dropped` command: this client's send queue was full and refused `n` frames. It is the
# only frame a client is sent about its own connection, and it asks for nothing — the client decides
# what to do, and a viewer answers with a `core/replay` event.
dropped_message(n::Integer) = commands_message([Command(CORE_DROPPED..., (; n = Int(n)))])

"""
    modules_message(mods; ellipsoid=nothing, furniture=nothing, imagery=nothing,
                    assets=nothing, lighting=false, stars=false, named_places=true,
                    country_borders=true, region_borders=false) -> Frame

The `modules` notification wire frame: the session declaration. `modules` is which ES
modules the viewer is to load, in declaration order, each with the same-origin URL the server serves
it from; `ellipsoid` is the shape the globe is built on, as `(; a, b)` radii in metres, omitted when
`nothing` so the viewer keeps its WGS84 default.

`furniture` is the set of the Core's own on-screen items, in the same shape the `core/furniture`
command carries. It is omitted when `nothing`, and the viewer then builds its default set. A viewer
builds the declared set before it paints, so a session that hides the ruler never shows one. See
[`declare_furniture`](@ref).

`imagery` is what the globe is textured with, as `start_server` resolved it: `false` for a globe
with no base layer, or one source as `(; url, layout, tiling, maxLevel, credit)`. It is omitted when
`nothing`, and the viewer then keeps its bundled Earth texture. The three states differ: absent is
the bundled texture, and `false` is no texture at all.

`assets` maps each mount name to the same-origin base it answers — `("models" => "assets/models/")`.
It is omitted when empty. A browser host does not read it, because a same-origin path already
resolves against the page; a host whose page sits on another origin builds its own URL per mount from
this map. See `ctx.assetUrl` in the module API reference.

`lighting` lights the globe from the sun at the clock's time, so a terminator runs across it. It is
omitted when `false`, which leaves the globe evenly lit.

`stars` draws the sky around the globe: the star field, the sun and the moon. It is omitted when
`false`, which leaves black behind the globe.

`named_places` draws the place names over the globe and `country_borders` the boundary lines between
countries, each above whatever basemap is on screen. Both are on by default, so each is omitted when
`true` and carried as `false` when off — the opposite way round to the two fields above, because the
wire states what departs from the default.

`region_borders` draws the boundary lines between the regions inside a country. It is off by
default, so it is omitted when `false` and carried as `true` when on. It draws only while
`country_borders` draws as well.

Sent once per connection, on `ready`, before any state addressed to a module. The viewer builds its
widget from what this carries, so nothing precedes it.
"""
function modules_message(mods; ellipsoid = nothing, furniture = nothing, imagery = nothing,
                         assets = nothing, lighting = false, stars = false, named_places = true,
                         country_borders = true, region_borders = false)
    params = (; modules = [(; m.id, url = module_url(m), apiVersion = m.api_version) for m in mods])
    ellipsoid === nothing || (params = (; params..., ellipsoid))
    furniture === nothing || (params = (; params..., furniture))
    imagery === nothing || (params = (; params..., imagery))
    assets === nothing || isempty(assets) || (params = (; params..., assets))
    lighting && (params = (; params..., lighting))
    stars && (params = (; params..., stars))
    named_places || (params = (; params..., namedPlaces = false))
    country_borders || (params = (; params..., countryBorders = false))
    region_borders && (params = (; params..., regionBorders = true))
    # A declaration carries no arrays, so its region is empty.
    return Frame(JSON.json((; method = "modules", params)))
end

"""
    window_message(payloads; start_frame, count, dt_seconds, total_frames, interval_seconds=1.5,
                   start_time=nothing, mode=:replace, window=nothing) -> Frame

The `window` notification wire frame: one contiguous run of `count` keyframes out of a
longer run, carrying **every** module's data for those frames in one message (ADR-0008). `payloads`
is a `module_id => payload` mapping; a module absent from it is not updated by this window, and each
payload is opaque — whatever the module reads, with its arrays encoded on the way out.

Every payload must describe the same `count` frames. A generic transport cannot count the frames in
a payload it does not interpret, so `count` is stated rather than derived.

Timing: `dt_seconds` is the mission-time step between keyframes; `interval_seconds` is the wall-clock
time one interval plays over, so the visible pace is fixed whatever the sim step; `start_time` is an
optional ISO-8601 epoch of *absolute frame 1* (omitted when `nothing`, letting the viewer pick a
synthetic epoch).

Window and declared range: `start_frame` is the absolute index of the window's first keyframe,
**1-based here** and converted to the wire's 0-based form; `total_frames` is the keyframe count of
the whole run — the clock, the timeline ruler and scrubbing work against that declared range whatever
this window covers. `mode` is `:replace` for a control re-push (clears the viewer's buffer, may
re-index entities) or `:append` for a streaming advance (extends it, and must preserve the previous
window's index space).

`window` is the window's identity: the viewer names it in every event it sends, so an answer resolved
against a window that has since been replaced can be discarded rather than applied to renumbered
entities. Omitted when `nothing`, which leaves the viewer naming no window and its requests
unguarded. [`push_window`](@ref) assigns one, and is the usual entry point.

A static scene is a window with `count = 1` and `total_frames = 1`. A window says nothing about the
time controls: a scene whose one keyframe names no instant declares the band off with
[`declare_furniture`](@ref).
"""
function window_message(payloads; start_frame, count, dt_seconds, total_frames,
                        interval_seconds = 1.5, start_time = nothing,
                        mode = :replace, window = nothing)
    mode in (:replace, :append) ||
        throw(ArgumentError("window mode must be :replace or :append (got $(repr(mode)))"))
    count ≥ 1 || throw(ArgumentError("a window carries at least one keyframe; got count=$count"))
    start_frame ≥ 1 ||
        throw(ArgumentError("start_frame is a 1-based absolute index; got $start_frame"))
    start_frame + count - 1 ≤ total_frames ||
        throw(ArgumentError("window [$start_frame, $(start_frame + count - 1)] runs past the " *
                            "declared range of $total_frames frames"))
    params = (; startFrame = to_wire_index(Int(start_frame)), count = Int(count),
              mode = String(mode), totalFrames = Int(total_frames), dtSeconds = dt_seconds,
              intervalSeconds = interval_seconds)
    window === nothing || (params = (; params..., window))
    # `startTime` is optional and omitted (not null) when absent, so the viewer takes its synthetic
    # epoch rather than parsing a null.
    start_time === nothing || (params = (; params..., startTime = start_time))
    region = IOBuffer()
    header = JSON.json((; method = "window",
                        params = (; params..., payloads = encode_arrays(payloads, region))))
    return Frame(header, take!(region))
end
