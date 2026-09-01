# A session recording: every wire frame a server broadcast, in order, each stamped with how long
# after the recording opened it was sent. Replaying one drives a real viewer through the same
# session with whatever produced the frames absent — a simulator, a data source, a live feed.
#
# The file is JSON Lines. The first line is a header naming the modules the recorded session
# declared and the scene it declared them into; every line after it is
#   {"t": <seconds>, "msg": {"method": …, "params": …}, "blobs": "<base64 of the region>"}
# `msg` is the frame's header spliced in verbatim, as an inline object, so `jq '.msg.params'` reads
# a recording without a `fromjson` first. The array bytes ride beside it as base64.

const RECORDING_VERSION = 2

"""
    record!(server::Server, path) -> Server

Start writing every frame `server` broadcasts to `path`, and return the server. Whatever the server
is already retaining is written first, at offset zero, so a recording started mid-session still
stands on its own: it opens with the scene as it is and continues with everything sent afterwards.

The modules registered at this moment are named in the recording's header, since the module set is
declared per connection and so is never itself broadcast. The header carries the scene they were
declared into for the same reason: the globe's `ellipsoid`, the `furniture`, `lighting`, `stars` and
`region_borders` when set, and `named_places` and `country_borders` when off, so the standalone
player rebuilds the session rather than being told it again in its address bar (ADR-0024). A
basemap joins them only when it is an absolute URL — a mounted directory is served by this server,
and nothing answers for it once the recording travels. Recording again replaces the sink.

A [`replay`](@ref) through a Julia server does not read any of it. A server fixes its globe at
`start_server`, so a recorded Moon session is replayed by `start_server(; ellipsoid, imagery)`.

```julia
record!(server, "session.jsonl")
# … drive the scene …
stop_recording!(server)
```
"""
function record!(server::Server, path)
    # The scene under the server's lock, the sink under the recording's own — the two are never held
    # at once, and this is the only function that takes both.
    header = lock(server.clients_lock) do
        (; recording = RECORDING_VERSION,
         modules = [(; m.id, path = m.path, apiVersion = m.api_version) for m in server.modules],
         recorded_scene(server)...)
    end
    held = retained_messages(server)
    lock(server.record_lock) do
        # Opened only once the previous sink is closed: recording twice to one path would otherwise
        # truncate the file a live handle still points into.
        server.record === nothing || close(server.record)
        io = open(String(path), "w")
        println(io, JSON.json(header))
        server.record = io
        server.record_t0 = time()
        for msg in held
            record_frame!(server, msg; at = 0.0)
        end
    end
    return server
end

# The declaration's scene fields that still mean something with this server gone, in the shape the
# declaration carries them (ADR-0024). The module URLs and the `assets` map are left out: both are
# same-origin paths into this server, and only the page replaying the file knows where those
# directories were copied to.
function recorded_scene(server)
    p = (;)
    server.ellipsoid === nothing || (p = (; p..., ellipsoid = server.ellipsoid))
    im = recorded_imagery(server.imagery)
    im === nothing && server.imagery !== nothing &&
        @warn "every basemap this session declared is a directory this server mounts, so none of \
            them travels with the recording — the player draws its bundled Earth texture unless \
            it is given `?imagery=` for wherever the tiles are copied to"
    im === nothing || (p = (; p..., imagery = im))
    server.lighting && (p = (; p..., lighting = true))
    server.stars && (p = (; p..., stars = true))
    # The names and the country borders are on by default, so the header states one only when it is
    # off. The region borders are off by default, so the header states them only when they are on.
    server.named_places || (p = (; p..., namedPlaces = false))
    server.country_borders || (p = (; p..., countryBorders = false))
    server.region_borders && (p = (; p..., regionBorders = true))
    # The furniture rides the header as well as the retained command written under it, for the reason
    # it rides the live declaration: the viewer builds the declared set before it paints, and the
    # command that follows says the same thing, which the viewer applies as a no-op. The retention
    # stays the one source of the set — `declared_furniture` reads it.
    f = declared_furniture(server)
    f === nothing || (p = (; p..., furniture = f))
    return p
end

# A basemap travels only when its tiles do, and the recorder filters a set one entry at a time
# (ADR-0024, ADR-0034). An absolute URL is reachable from anywhere. The bundled pyramid is in every
# viewer, so it travels wherever the file goes. Anything else is the relative URL of a mount, which
# returns 404 off this server. A record of it is worse than no record at all.
#
# When the first entry drops, the next survivor takes its place, because entry 0 is what the globe
# wears at startup. When every entry drops, the file records no basemap at all, and the player keeps
# its bundled texture.
function recorded_imagery(imagery)
    imagery === false && return false
    imagery isa AbstractVector || return nothing
    kept = filter(d -> get(d, :bundled, false) || csp_source(get(d, :url, "")) !== nothing, imagery)
    length(kept) == length(imagery) ||
        @warn "a basemap served from this server cannot be reached once the server stops, so it \
            is left out of the recording" left_out = length(imagery) - length(kept)
    return isempty(kept) ? nothing : kept
end

"""
    stop_recording!(server::Server) -> Server

Close the recording sink, if any. Idempotent, and called for you by [`stop_server`](@ref).
"""
function stop_recording!(server::Server)
    lock(server.record_lock) do
        server.record === nothing && return nothing
        close(server.record)
        server.record = nothing
    end
    return server
end

# Append one broadcast frame to the open recording, `at` seconds into it. Takes `record_lock` alone:
# a recording is a sink and not a client, so a slow disk holds up nothing the server's own lock
# guards. Two frames broadcast from one task are recorded in the order that task sent them. Two
# tasks broadcasting at the same instant may reach the file in one order and the client queues in
# the other, which is an order neither task states anyway.
#
# Flushed per frame: a recording is readable while the session it describes is still running, and
# survives the process being killed.
function record_frame!(server::Server, msg::Frame; at = time() - server.record_t0)
    lock(server.record_lock) do
        io = server.record
        io === nothing && return nothing
        # The header is spliced in rather than parsed and re-serialized: that keeps it byte-for-byte
        # what the clients received, and spares a multi-megabyte window a round trip through JSON.
        println(io, "{\"t\":", round(at; digits = 3), ",\"msg\":", msg.header,
                ",\"blobs\":\"", base64encode(msg.blobs), "\"}")
        flush(io)
    end
    return nothing
end

"""
    replay(server::Server, path; speed=1.0) -> Server

Send the session recorded at `path` through `server`, pacing the frames as they were recorded, and
return the server. `speed` scales that pacing: `2.0` plays twice as fast, and a very large value
plays as fast as the frames can be sent.

Each frame is broadcast to whoever is connected and retained exactly as the live call that produced
it would have retained it, so a viewer that connects part-way through is caught up to where the
replay has reached. Any module the recording names and the server does not already have registered
is registered from the path recorded for it — which has to still be there, so hand a recording that
has travelled a server with those modules already registered.

A replay re-sends what the session sent, the answers its listeners gave included; what it does not
do is *run* those listeners. Operating a control the recorded overlay declares, or hovering an
entity the recorded scene draws, reaches nobody unless a listener is registered here. The server
also takes on the window identity the recording stamped, so a replay owns the scene: do not push
windows of your own onto a server that is replaying one.

This blocks for as long as the session lasted; run it in a task to keep driving the server while it
plays.

```julia
server = start_server()
@async replay(server, "session.jsonl")
```
"""
function replay(server::Server, path; speed = 1.0)
    speed > 0 || throw(ArgumentError("replay speed must be positive (got $speed)"))
    open(String(path), "r") do io
        header = JSON.parse(readline(io))
        version = get(header, "recording", nothing)
        version == RECORDING_VERSION ||
            throw(ArgumentError("$path is not a version $RECORDING_VERSION recording"))
        for m in get(header, "modules", ())
            id = String(m["id"])
            # Keep the module the server already has. The recorded path is a path on the machine
            # that made the recording, and registering it here would replace a module that loads
            # with one whose file may not exist.
            any(e -> e.id == id, server.modules) && continue
            register_module!(server, ModuleEntry(id, m["path"], m["apiVersion"]))
        end
        t0 = time()
        for line in eachline(io)
            rec = JSON.parse(line)
            # Paced against the start rather than against the previous frame, so a slow send does
            # not push everything after it later still.
            behind = Float64(rec["t"]) / speed - (time() - t0)
            behind > 0 && sleep(behind)
            replay_frame!(server, frame_of(rec))
        end
    end
    return server
end

# One recorded line as the frame to send.
frame_of(rec::AbstractDict) = Frame(JSON.json(rec["msg"]), base64decode(rec["blobs"]))

# Broadcast and retain one recorded wire frame the way the call that originally sent it did: a
# window under ("core", "window") along with the span and identity it carries, a command batch under
# one key per command in it. A `modules` frame is not replayed — the module set is declared per
# connection out of what is registered, which `replay` has already seen to.
function replay_frame!(server::Server, f::Frame)
    msg = JSON.parse(f.header)
    method = get(msg, "method", nothing)
    params = get(msg, "params", Dict{String,Any}())
    if method == "window"
        lock(server.clients_lock) do
            server.window_span = (; start_frame = from_wire_index(Int(params["startFrame"])),
                                  count = Int(params["count"]), mode = Symbol(params["mode"]))
            id = get(params, "window", nothing)
            id === nothing || (server.window_id = Int(id))
        end
        send_message(server, CORE_WINDOW..., f)
    elseif method == "commands"
        cmds = get(params, "commands", ())
        # Rebuilt rather than re-encoded: the commands already name offsets into this frame's
        # region, and encoding them again would move them.
        # Every retained single-command frame carries the whole batch's region. A batch
        # holds a few small command payloads; split the region per command if one ever holds a
        # raster.
        for c in cmds
            retain!(server, (String(c["module"]), String(c["topic"])),
                    Frame(JSON.json((; method, params = (; commands = [c]))), f.blobs))
        end
        # Re-emitted without the `seq` the recorded batch may carry: a sequence number is an event's,
        # and it belongs to the connection that raised it. Here the batch answers nothing.
        broadcast_all!(server, Frame(JSON.json((; method, params = (; commands = cmds))), f.blobs))
    end
    return nothing
end
