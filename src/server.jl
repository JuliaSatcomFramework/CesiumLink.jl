# One server, one port: static assets AND the `/ws` upgrade, so the page and its live connection are
# same-origin. Binds the loopback `127.0.0.1` by default, because this package runs on shared
# multi-user machines and `::` offers the scene to everyone who can route to the host. An SSH
# forward whose target `localhost` resolves to `::1` first needs `host = "::"` or `host = "::1"`:
# a lone IPv4 bind does not answer it.

"""
    ModuleEntry(id, path; api_version=$MODULE_API_VERSION)

One ES module the viewer is to load: its `id`, the `path` of its entry file on disk, and the module
API version it was written against. The server mounts the file's **containing directory** under
`/modules/<id>/`, so sibling files (chunks, worker bundles, images) resolve normally, and declares
the resulting URL. Register one with [`register_module!`](@ref).
"""
struct ModuleEntry
    id::String
    path::String
    api_version::Int
    # An INNER constructor so validation runs for every call form: a module whose file is missing
    # would otherwise be declared to the viewer and fail as a 404 in the browser instead of here.
    function ModuleEntry(id, path, api_version)
        i = String(id)
        # The id is a path segment of the URL the viewer imports, so it must survive being one
        # verbatim: no separators, no escaping, nothing the browser would resolve elsewhere.
        occursin(r"^[A-Za-z0-9._-]+$", i) && i ∉ (".", "..") ||
            throw(ArgumentError("a module id must match [A-Za-z0-9._-]+ (got $(repr(i)))"))
        p = normpath(abspath(String(path)))
        isfile(p) || throw(ArgumentError("no module entry file at $p"))
        return new(i, p, Int(api_version))
    end
end

ModuleEntry(id, path; api_version = MODULE_API_VERSION) = ModuleEntry(id, path, api_version)

"""
    module_url(entry::ModuleEntry) -> String

The same-origin URL the viewer imports `entry` from, under the mount its directory is served at.
"""
module_url(entry::ModuleEntry) = "/modules/$(entry.id)/$(basename(entry.path))"

"""
    Server

A running viewer server: the HTTP+WebSocket listener, the connected client set, the registered
module set, the retained scene state (the current window and the latest command per module and
topic, replayed to a client that connects later), the registered event listeners and the installed
scene. Create one with [`start_server`](@ref); do not construct it directly.
"""
mutable struct Server
    listener::Any
    clients::Set{Any}
    const clients_lock::ReentrantLock
    # The modules to declare, in registration order — which is the order the viewer draws and stacks
    # them in; reaching another module through `ctx.modules` is not subject to it. Doubles as the
    # mount table for `/modules/<id>/`. Established per connection: a client is told this set once,
    # on `ready`.
    # Guarded by `clients_lock`.
    modules::Vector{ModuleEntry}
    # Latest broadcast message per (module, topic), in recency order of last update (oldest first),
    # so a late client is replayed each retained topic and the most recently updated one is applied
    # last. The current window is retained here too, under ("core", "window"). Guarded by
    # `clients_lock`.
    retained::Vector{Pair{Tuple{String,String},Frame}}
    # Every registered event listener, in registration order — the order they run in, and the order
    # the subscription declared to the viewer is derived from. Guarded by `clients_lock`.
    listeners::Vector{EventListener}
    # The installed scene and the listeners it registered, or `nothing` and empty before one is
    # installed. A server drives at most one scene: two of them answer the same events and each
    # re-declares the overlay with its own state, so installing one takes the previous one down.
    # CesiumLink never interprets `scene` — it is whatever built it. Guarded by `clients_lock`.
    scene::Any
    scene_listeners::Vector{EventListener}
    # Where the user has put each adjustable float, keyed by float id, and the last set
    # `declare_floating` was given. A rect belongs to the user rather than to the scene, so the
    # server holds it: it is stamped onto every later declaration of that float, and the set is
    # re-sent stamped whenever the viewer reports one. Both are `Any` because `Floating` is defined
    # after this file. Guarded by `clients_lock`.
    float_rects::Dict{String,Any}
    declared_floats::Vector{Any}
    # Identity of the window the scene currently shows (ADR-0008), bumped by every push that may
    # re-index entities. Stamped on every window and echoed by every event, so a listener holding an
    # index can tell which scene it was read from. Guarded by `clients_lock`.
    window_id::Int
    # What the retained window covers and how it was pushed, as `(; start_frame, count, mode)`, or
    # `nothing` before the first push. An `:append` does not stand on its own — it may omit anything
    # the `:replace` it extends established — so a client that has received neither is asked for a
    # replacement over these frames instead of being replayed it. Guarded by `clients_lock`.
    window_span::Any
    const dist_dir::Union{String,Nothing}
    # The ellipsoid this session's coordinates are on, declared to every client, or `nothing` to
    # leave the viewer on its WGS84 default. The viewer builds its globe from the declaration, so a
    # shape that changed mid-session would leave the scene on the old one.
    const ellipsoid::Union{Nothing,NamedTuple{(:a, :b),Tuple{Float64,Float64}}}
    # What the globe is textured with, as the field the declaration carries: `nothing` to declare
    # none and leave the viewer on its bundled texture, `false` for a globe with no base layer, or
    # one resolved source. It cannot change mid-session, for the reason the ellipsoid cannot.
    const imagery::Any
    # Every directory this server serves, by mount name: `/assets/<name>/` answers out of
    # `asset_dirs[name]`. A directory of basemap tiles is the reserved name `imagery`, so a tile
    # directory and a folder of models are one mechanism (ADR-0021). The set cannot grow mid-session:
    # a VSCode webview is given its roots when its panel is created and cannot be given more later.
    const asset_dirs::Dict{String,String}
    # Every origin the page may reach off-site, widening both `img-src` and `connect-src`. A basemap
    # declared as a URL adds its own origin here.
    const trusted_origins::Vector{String}
    # Whether the globe is lit from the sun at the clock's time. It cannot change mid-session, for
    # the reason the imagery cannot.
    const lighting::Bool
    # Whether the sky around the globe is drawn. It cannot change mid-session, for the same reason.
    const stars::Bool
    # The open session recording, or `nothing`, and the wall-clock instant it was opened at — every
    # broadcast frame is stamped with its offset from that. Guarded by `clients_lock`.
    record::Union{IO,Nothing}
    record_t0::Float64
    # The host the listener was asked to bind, kept verbatim. `viewer_url` builds the page URL from
    # it, because a wildcard bind answers on every interface and is not an address a browser can be
    # sent to.
    const host::String
    # This server's file in the discovery directory, or `nothing` when none was written.
    # `stop_server` removes it.
    discovery_file::Union{String,Nothing}
end

"""
    bound_port(server::Server) -> Int

The port `server` listens on. With the default `port = 0` the operating system picks the number, and
this is how to read which one it picked.

Printing a [`Server`](@ref) shows the viewer URL, which names the port. This is the number itself,
for a program that has to build something else out of it.
"""
bound_port(server::Server) = server.listener.bound_port

# The host half of a URL that reaches a server bound to `host`. A wildcard bind answers on every
# interface, so the URL names the loopback instead; an IPv6 literal takes the brackets a URL needs.
url_host(host::AbstractString) =
    host in ("::", "0.0.0.0") ? "127.0.0.1" : occursin(':', host) ? "[$host]" : host

"""
    viewer_url(server::Server) -> String

The URL to open this server's viewer page at, port and all — `http://127.0.0.1:<port>/?ws=auto` for
the default loopback bind. A wildcard bind answers on every interface, which is not an address to
send a browser to, so the URL names the loopback for that case as well.

Printing a [`Server`](@ref) shows this URL. Use the function to put it in a message of your own,
rather than a port number you chose: with the default `port = 0` there is no number to choose.

The `ws` query parameter is what tells the page to connect, and `auto` points it at the same-origin
`/ws`. A page opened without it builds an empty globe and asks this server for nothing, which reads
as a server that never sent anything.

```julia
server = start_server()
println("open ", viewer_url(server))
```
"""
function viewer_url(server::Server)
    server.listener === nothing && throw(ArgumentError("this server is stopped"))
    return "http://$(url_host(server.host)):$(bound_port(server))/?ws=auto"
end

# A server holds every frame it retains, so its fields are hundreds of thousands of characters of
# nothing a session wants to read. What a session does want is where to open the page and whether
# anything is attached to it.
function Base.show(io::IO, ::MIME"text/plain", server::Server)
    if server.listener === nothing
        print(io, "CesiumLink server (stopped)")
        return nothing
    end
    n = lock(() -> length(server.clients), server.clients_lock)
    print(io, "CesiumLink server at ", viewer_url(server), " (", n, n == 1 ? " client)" : " clients)")
    # The URI the editor extension answers on, which is how a tab closed after the server started is
    # opened again. VSCode makes it clickable in its own terminal, and no other terminal can open it.
    in_vscode_terminal() && print(io, "\n  VSCode tab: ", scene_uri(bound_port(server)))
    return nothing
end

# One line, for a server printed inside something else.
Base.show(io::IO, server::Server) =
    print(io, "Server(", server.listener === nothing ? "stopped" : viewer_url(server), ")")

# Why a listen failed, as one line. HTTP.jl binds inside a task, so the cause arrives wrapped in a
# `TaskFailedException` under a stack trace that names nothing the caller can act on.
bind_reason(e) = e isa TaskFailedException && e.task.result isa Exception ?
                 bind_reason(e.task.result) : sprint(showerror, e)

"""
    start_server(; dist_dir=viewer_dist(), host="127.0.0.1", port=0, title=basename(pwd()),
                 ellipsoid=nothing, imagery=nothing, assets=nothing, trusted_origins=String[],
                 lighting=false, stars=false, open=:auto) -> Server

Start the one-port HTTP+WebSocket listener and return a running [`Server`](@ref). Static files are
served from `dist_dir` (the built viewer); the WebSocket lives at `/ws`, same-origin with the page.
Stop it with [`stop_server`](@ref).

Open the page at [`viewer_url(server)`](@ref viewer_url).

`port` defaults to `0`, which asks the operating system for a free port. Two people on one machine
therefore never collide, and nobody has to pick a number. Read the port back with
[`bound_port`](@ref). Pass an explicit port only when something outside this process must reach a
number it already knows, such as an SSH forward. **An explicit port that is already taken throws** —
on Windows it does not. A socket there takes a port another socket holds, so a second server binds
the same number and a request reaches one of the two. Leave `port` at `0` on Windows.

`host` defaults to the loopback `127.0.0.1`, so the scene is reachable from this machine alone. This
package runs on shared multi-user machines, where `"::"` offers the scene to everyone who can route
to the host.

`title` names this server in the file it writes for a picker to find — see [`discovery_dir`](@ref).

`open` asks a VSCode window to show this scene in an editor tab, through the CesiumLink extension.
`:auto`, the default, asks from a terminal inside VSCode and does nothing anywhere else. `false`
never asks. `true` asks wherever it runs, and reports why it could not.

**VSCode asks the user for permission before the tab opens.** It asks again for every scene, until
the user ticks "do not ask again for this extension" in that dialog. The server does not wait for
the answer, so the scene serves while the dialog stands. Pass `open = false` to avoid the dialog.

The tab needs the CesiumLink extension. Without it, nothing opens, and the scene serves as usual.

`ellipsoid` is the shape this session's coordinates are on, as anything with the fields `a`
(semi-major) and `b` (semi-minor) in metres. [`Ellipsoids`](@ref CesiumLink.Ellipsoids) names a few
bodies. It is declared to every client, which builds its globe on it before decoding any payload, so
a scene computed against one shape is never drawn on another. Left `nothing`, nothing is declared
and the viewer keeps its own WGS84 default.

```julia
start_server(; ellipsoid = Ellipsoids.MARS)
start_server(; ellipsoid = (a = 3396190.0, b = 3376200.0))    # the same shape, stated
```

A strongly flattened shape has a drawing limit. The viewer draws through Cesium, which recomputes
the globe's local curvature at the camera on every frame, and that computation has no solution once
the camera stands

```
|z| ≥ b / |a²/b² − 1|
```

from the equatorial plane — beyond it the render loop throws and the scene stops. With
`a = 6378137.0` that limit is 2.6×10⁶ m at `b = 4.0×10⁶` (reached immediately), 8.0×10⁶ m at
`b = 5.0×10⁶` (reached on zoom-out) and 46×10⁶ m at `b = 6.0×10⁶`, which is visibly oblate and holds
at any usual range. Declaring a shape whose limit is within reach warns; it is not refused, since
the camera may never travel that far.

`imagery` is what the globe is textured with, and takes four kinds of value:

| value | the globe wears |
|---|---|
| `nothing`, the default | the viewer's bundled Earth texture |
| a path to a directory | the tile pyramid in it, served from this server under `/assets/imagery/` |
| any other string, or an [`Imagery`](@ref) | the source it names, declared as it stands |
| `:none` | nothing: no base layer, and a flat colour |

A directory is read once, here: the layout is sniffed from what it holds, the depth is probed from
its level names, and a directory that is neither pyramid throws. A URL is never fetched — a source
that answers nothing is found by the browser, which says so and draws the bundled texture instead.

```julia
start_server(; ellipsoid = Ellipsoids.MOON, imagery = "/data/moon_tiles")
start_server(; imagery = :none)                     # a bare globe, deliberately
```

`assets` names folders of your own for the server to serve, so a payload can point at a file in one.
Each mount has a name, and `/assets/<name>/<file>` is the path a scene declares — so a reader sees
which folder a file comes from without reading this call. Pass a `Dict` of name to directory, or one
bare string, which mounts under the last element of its path.

```julia
start_server(; assets = Dict("models" => "/data/glb", "textures" => "/data/png"))
start_server(; assets = "/data/glb")                # one mount, answering `assets/glb/`
```

A directory of basemap tiles is the reserved mount `imagery`, so `imagery = "/data/moon_tiles"` is
unchanged and answers `assets/imagery/`. An `assets` key of `"imagery"` throws rather than shadowing
it. Every directory must exist, and a name is one path element.

Mounts are fixed here. A VSCode webview is given the directories it may read when its panel is
created, and taking a new one needs a new panel — which drops the scene and the socket.

`trusted_origins` lists the origins the page may reach off-site, and widens both the image and the
connection policy the editor's webview runs under. Both, because one asset needs both: Cesium fetches
a tile as bytes and makes an image of them, so a tile is a connection and not an image load. A
basemap named as a URL adds its own origin to this list, so a session that names a remote basemap and
nothing else declares nothing here.

`lighting` lights the globe from the sun at the clock's time, so a terminator runs across it and the
night side goes dark. It is off by default: a scene whose colours carry its data wants an evenly lit
globe, since a shaded one dims a value by where it sits rather than by what it says. Turn it on for
a scene about where the sun is — an orbit view above all, where the terminator is the picture.

The sun's position follows the clock, so it is only where the scene's own time puts it when the
window carries a real `start_time` (see [`push_window`](@ref)). Without one the viewer picks a
synthetic epoch and the terminator stands somewhere arbitrary.

`stars` draws the sky around the globe: the star field, the sun and the moon, at that same time. It
is off by default, because black behind the globe is what keeps the eye on the scene. The star field
is Cesium's own, and Cesium draws it on a WGS84 globe only — a session on another body gets black
whatever this says.
"""
function start_server(; dist_dir = viewer_dist(), host = "127.0.0.1", port = 0,
                      title = basename(pwd()), ellipsoid = nothing, imagery = nothing,
                      assets = nothing, trusted_origins = String[],
                      lighting = false, stars = false, open = :auto)
    open === :auto || open === true || open === false ||
        throw(ArgumentError("`open` takes `:auto`, `true` or `false`, and got $(repr(open))"))
    declared_imagery, imagery_dir = resolve_imagery(imagery)
    asset_dirs = resolve_assets(assets)
    imagery_dir === nothing || (asset_dirs[IMAGERY_MOUNT] = imagery_dir)
    origins = collect(String, trusted_origins)
    # A basemap named as a URL is an origin the page must reach, so the session declares it rather
    # than making the author list it twice.
    if declared_imagery isa NamedTuple
        o = url_origin(declared_imagery.url)
        o === nothing || o in origins || push!(origins, o)
    end
    server = Server(nothing, Set{Any}(), ReentrantLock(), ModuleEntry[],
                    Pair{Tuple{String,String},Frame}[], EventListener[], nothing,
                    EventListener[], Dict{String,Any}(), Any[], 0, nothing,
                    dist_dir === nothing ? nothing : normpath(String(dist_dir)),
                    ellipsoid === nothing ? nothing : ellipsoid_radii(ellipsoid),
                    declared_imagery, asset_dirs, origins, lighting, stars, nothing, 0.0,
                    String(host), nothing)
    # A bind that did not happen must never return a `Server`. HTTP.jl binds inside a task and
    # reports a failure two ways: the task's error reaches here, or the task's ready notification
    # wins the race and `listen!` returns with `bound_port` left at zero. The second one is the
    # dangerous one — it hands back a server that answers nothing and says nothing.
    listener = try
        HTTP.listen!(host, port) do stream
            if HTTP.WebSockets.isupgrade(stream.message)
                HTTP.WebSockets.upgrade(stream) do ws
                    lock(server.clients_lock) do; push!(server.clients, ws); end
                    try
                        for msg in ws
                            handle_msg(server, ws, msg)
                        end
                    catch e
                        e isa HTTP.WebSockets.WebSocketError ||
                            @warn "ws handler error" exception = e
                    finally
                        lock(server.clients_lock) do; delete!(server.clients, ws); end
                    end
                end
            else
                serve_static(server, stream)
            end
        end
    catch e
        throw(ArgumentError("could not listen on $host:$port — $(bind_reason(e))"))
    end
    if listener.bound_port == 0
        close(listener)
        throw(ArgumentError("could not listen on $host:$port — the address is already in use"))
    end
    server.listener = listener
    # The push goes out after the discovery file, and never before it: the extension reads that
    # file to find the scene the push names.
    server.discovery_file = write_discovery(bound_port(server), title, imagery_source(server);
                                            assets = server.asset_dirs,
                                            trusted_origins = server.trusted_origins,
                                            modules = module_dirs(server))
    if open !== false
        why = push_to_editor(bound_port(server), open)
        # A tab that does not open costs one line, and never the scene. `open = true` asks for the
        # tab, so it says what happened; `:auto` stays quiet everywhere it does not apply.
        why === nothing || (open === true ? @warn("no editor tab for this scene: $why") : @debug why)
    end
    watch_float_rects!(server)
    return server
end

"""
    register_module!(server::Server, id, path; api_version=$MODULE_API_VERSION) -> Server
    register_module!(server::Server, entry::ModuleEntry) -> Server

Add an ES module to the set the viewer loads. `path` names the module's entry file on disk; the
server mounts its containing directory under `/modules/<id>/` and declares that URL, so the module
and its siblings are served same-origin with the page. There is no privileged loading path: a
module shipped inside the viewer dist is registered exactly like anyone else's.

**Registration order is the order the viewer draws and stacks the modules in**, and decides nothing
else: a module reaching another through `ctx.modules` may be registered either side of it. A client
hears the set once, on `ready`. A **new** id registered after that is declared to the clients
already connected, so a scene that registers its modules after its server starts reaches them all.

An id registered twice keeps its place in that order and takes the last entry given for it, so a
scene installed again on one server registers its modules again without error. Two packages that
claim one id therefore overwrite each other: give a module the name of what it draws.

A module ships from its own package when its vocabulary names a domain concept. A module that is
told only a shape, a value or a colour is vendored instead — see [`vendored`](@ref).

```julia
register_module!(server, :primitives, joinpath(dist, "modules", "primitives", "entry.js"))
register_module!(server, :rainfade, joinpath(pkgdir(RainFade), "assets", "rainfade.js"))
```
"""
register_module!(server::Server, id, path; api_version = MODULE_API_VERSION) =
    register_module!(server, ModuleEntry(id, path, api_version))

function register_module!(server::Server, entry::ModuleEntry)
    known = lock(server.clients_lock) do
        i = findfirst(m -> m.id == entry.id, server.modules)
        # A known id is replaced in place, because registration order is the draw order. Neither the
        # path nor the file content decides this: a module staged into a fresh `mktempdir()` gets a
        # new path every run, and a module edited between two runs gets new content, and both are
        # the same scene installed again.
        i === nothing ? (push!(server.modules, entry); false) : (server.modules[i] = entry; true)
    end
    # A host that serves the page itself is given the directories it may read before the page
    # exists, so the file has to name this module by the time such a host reads it.
    #
    # Before the declaration, and never after it: the declaration is what makes a page reach for
    # this module, and a page hosted by the editor answers a module it cannot reach by reading this
    # file again.
    refresh_discovery(server)
    # A client already connected heard the set as it stood when it said `ready`, and a scene
    # registers its modules after its server starts — so tell those clients about this one. A viewer
    # loads the ids it does not already hold, which makes this a no-op for an id it does.
    known || declare_modules(server, entry.id)
    return server
end

"""
    stop_server(server::Server) -> Server

Remove this server's file from [`discovery_dir`](@ref), so no picker offers a scene that stopped.
Then close every client socket, then the listener, freeing the port, and close any open recording.
The file goes first: a picker reads that directory at any moment, and a row for a server that no
longer answers is what the file exists to prevent. Idempotent.
"""
function stop_server(server::Server)
    # Remove the file BEFORE any socket closes. A picker reads the directory at any moment, and a
    # row it draws for a server that stopped answering is the one thing a discovery file must never
    # cause.
    if server.discovery_file !== nothing
        try; rm(server.discovery_file; force = true); catch; end
        server.discovery_file = nothing
    end
    # Close client sockets BEFORE the listener: close(listener) waits for each upgraded handler's
    # `for msg in ws` loop to return, which for a still-open browser tab never happens.
    lock(server.clients_lock) do
        for ws in collect(server.clients)
            try; close(ws); catch; end
        end
        empty!(server.clients)
    end
    if server.listener !== nothing
        try; close(server.listener); catch; end
        server.listener = nothing
    end
    stop_recording!(server)
    return server
end

# `frame` is one binary frame, or the JSON text a hand-driven client may send instead. The protocol
# is symmetric, so what arrives upward is split the same way as what goes down: a header and the
# region its encoded arrays point into. Nothing the viewer sends carries an array today, so the
# region is normally empty, and a listener that is handed one costs nothing to support.
function handle_msg(server::Server, ws, frame)
    # A malformed frame or a throwing user tooltip callback must not tear the connection down.
    local msg, region
    try
        f = frame isa AbstractString ? Frame(frame, UInt8[]) : unpack(frame)
        msg, region = JSON.parse(f.header), f.blobs
    catch e
        @warn "ignoring unparseable ws frame" exception = e
        return nothing
    end
    method = get(msg, "method", nothing)
    if method == "ready"
        # The viewer announces its protocol version, and a mismatch closes the socket with a reason.
        # Proceeding is worse than refusing: every frame below is binary, so a viewer built against
        # another framing parses none of them and says nothing about it — the session looks to the
        # user like a server that never sent anything.
        params = get(msg, "params", Dict{String,Any}())
        proto = get(params, "protocol", PROTOCOL_VERSION)
        if proto != PROTOCOL_VERSION
            @warn "refusing a client that announced an unsupported protocol version" proto PROTOCOL_VERSION
            close(ws, HTTP.WebSockets.CloseFrameBody(1002,
                "this server speaks protocol $PROTOCOL_VERSION; the client announced $proto"))
            return nothing
        end
        # Declare the module set BEFORE the retained scene: the viewer needs to know what to load
        # before the state addressed to it arrives. Copy both under the lock, then send unlocked
        # so a slow socket doesn't stall broadcasts.
        decl, msgs, rebuild = lock(server.clients_lock) do
            span = server.window_span
            # A retained `:append` is not replayed: it extends a `:replace` this client has never
            # seen, and anything that rode that replace — an area family's footprint centres above
            # all — is absent from it. The scene is asked for a replacement over the same frames
            # instead, which is a window that stands on its own.
            rebuild = span !== nothing && span.mode === :append && window_producer(server) ?
                      span : nothing
            # The furniture rides the declaration as well as the replay below: the viewer builds the
            # declared set before its first paint, and the replayed command that follows says the
            # same thing, which the viewer applies as a no-op.
            modules_message(server.modules; server.ellipsoid, server.imagery, server.lighting,
                            server.stars, furniture = declared_furniture(server),
                            assets = declared_assets(server)),
            retained_messages(server; skip = rebuild === nothing ? () : (CORE_WINDOW,)), rebuild
        end
        HTTP.WebSockets.send(ws, pack(decl))
        # Replay the retained scene so a mid-session client catches up: every retained topic, in
        # recency order, so the most recently updated one is applied last.
        for m in msgs
            HTTP.WebSockets.send(ws, pack(m))
        end
        rebuild === nothing || rebuild_window(server, ws, rebuild)
    elseif method == "event"
        # The viewer reports upward as `event {module, topic, seq, frame, window, payload}`, and the
        # listener registry answers it: pointer events, buffer needs and a module's own `notify` are
        # all just `(module, topic)` pairs, with no special case for any of them.
        params = get(msg, "params", Dict{String,Any}())
        pair = (get(params, "module", nothing), get(params, "topic", nothing))
        if pair == CORE_ELLIPSOID
            check_reported_ellipsoid(server, get(params, "payload", Dict{String,Any}()))
        elseif pair == CORE_STOP
            # Schedule the stop; do not run it here. This task is reading the socket that the stop
            # closes. The listener chain never sees this pair either: a scene must not be able to
            # refuse a stop by registering a listener on it.
            @async try
                stop_server(server)
            catch e
                @error "a client asked this server to stop and the stop failed" exception = (e, catch_backtrace())
            end
        else
            answer_event(server, params, region)
        end
    end
    # Unknown methods are ignored (protocol).
    return nothing
end

# Once its globe exists, a viewer reports the radii it was actually built on. It was told them, so
# these can differ only if the declaration never reached the widget — and a scene drawn on a shape
# other than the one its coordinates were computed against is smoothly plausible, wrong by a
# kilometre and says nothing. So the two are compared here and a disagreement names both.
# A micrometre of tolerance — far under any difference between two real ellipsoids, and
# far over anything the JSON round trip could introduce.
function check_reported_ellipsoid(server::Server, payload)
    declared = server.ellipsoid === nothing ? Ellipsoids.WGS84 : server.ellipsoid
    a, b = get(payload, "a", nothing), get(payload, "b", nothing)
    if !(a isa Real && b isa Real)
        @error "a client reported an unreadable ellipsoid" payload
    elseif !(isapprox(a, declared.a; atol = 1e-6) && isapprox(b, declared.b; atol = 1e-6))
        @error "a client built its globe on an ellipsoid other than the declared one" declared reported = (; a, b)
    end
    return nothing
end

"""
    window_id!(server::Server, mode) -> Int

The identity to stamp on a window pushed with `mode`: a `:replace` takes one the server has not used
before, an `:append` repeats the one it extends (an append preserves the index space, so requests
asked against the window it continues stay valid). Recorded as the server's current window, which is
the identity every event's `window` field is to be compared against.

[`push_window`](@ref) calls this for you. Call it directly only when building the frame by hand
through [`window_message`](@ref) — the `window` it returns is a keyword of the latter.
"""
window_id!(server::Server, mode) = lock(server.clients_lock) do
    mode === :replace ? (server.window_id += 1) : server.window_id
end

# Whether this scene can produce a window on demand: whether a listener is registered for
# `core/need`. With none, a request would reach nobody and there is nothing to answer a joining
# client with but what is retained.
window_producer(server::Server) =
    any(l -> (l.module_id, l.topic) == CORE_NEED, server.listeners)

# Ask the scene for a window covering `span`'s frames that a client which has received nothing can
# draw, and send that client what it is holding if none arrives.
#
# A producer that throws or answers with nothing costs a warning rather than the session everywhere
# else, and here that would leave this client with no window at all — and nothing to recover it,
# since the viewer raises no request of its own until a first window has landed. The retained
# `:append` is at worst a scene that draws in part and says so; silence is not. A new window identity
# is what says one arrived: a `:replace` mints one, and a producer that threw, sent nothing, or
# appended instead leaves it where it was.
function rebuild_window(server::Server, ws, span)
    before = lock(server.clients_lock) do; server.window_id; end
    request_window(server, span.start_frame, span.count, :replace)
    held = lock(server.clients_lock) do
        server.window_id == before || return nothing
        retained(server, CORE_WINDOW)
    end
    held === nothing && return nothing
    @warn "the scene produced no replacing window for a joining client; sending the one it holds" span
    HTTP.WebSockets.send(ws, pack(held))
    return nothing
end

# Ask this scene for `count` keyframes from the **1-based** `start_frame` as a window of `mode`, by
# the route a viewer's own `core/need` takes: the registered listeners. The chain contributes no
# commands here — a window is the whole of the answer, and there is no event `seq` for a batch to
# echo.
function request_window(server::Server, start_frame::Integer, count::Integer, mode::Symbol)
    m, t = CORE_NEED
    dispatch_event(server, Dict{String,Any}("module" => m, "topic" => t,
        "payload" => Dict{String,Any}("startFrame" => to_wire_index(Int(start_frame)),
                                      "count" => Int(count), "mode" => String(mode))))
    return nothing
end

# Declare the module set to the clients already connected, and replay whatever is retained for the
# module `id` behind it.
#
# The set is otherwise declared once per client, on `ready`. A scene registers its modules just
# after `start_server` returns, so a page that connected before that heard a set without them, and a
# module a page never hears of is a module that never draws. The viewer loads the ids it does not
# already hold: a module already running holds scene state, and importing it again would orphan it.
#
# The retained frames go out behind the declaration for the same reason a connecting client is
# replayed: a frame addressed to this module before it was registered reached a viewer with nothing
# to route it to, and was dropped there.
function declare_modules(server::Server, id::AbstractString)
    decl, msgs = lock(server.clients_lock) do
        isempty(server.clients) && return nothing, Frame[]
        return modules_message(server.modules; server.ellipsoid, server.imagery, server.lighting,
                               server.stars, furniture = declared_furniture(server),
                               assets = declared_assets(server)),
               Frame[f for (key, f) in server.retained if first(key) == id]
    end
    decl === nothing && return nothing
    broadcast_all!(server, decl; record = false)
    for m in msgs
        broadcast_all!(server, m; record = false)
    end
    return nothing
end

# Broadcast to every client; drop any that error mid-send. Named so as not to shadow Base.broadcast!.
# Sends while holding the lock — a slow client stalls all broadcasts; fine for localhost.
#
# `record = false` keeps a frame out of an open recording. A recording names its module set in its
# header, and a player resolves each module against a base of its own from that header alone — so a
# declaration replayed from the body of the recording would send the player at a URL that only the
# live server answers.
function broadcast_all!(server::Server, msg::Frame; record = true)
    n = 0
    # Laid out once for every client: the layout is the same for all of them, and a window's region
    # is the bulk of the message.
    bytes = pack(msg)
    lock(server.clients_lock) do
        record && record_frame!(server, msg)
        for ws in collect(server.clients)
            try
                HTTP.WebSockets.send(ws, bytes); n += 1
            catch
                delete!(server.clients, ws)
            end
        end
    end
    return n
end

"""
    send_command(server::Server, module_id, topic, payload) -> Int

Broadcast a one-command `commands` batch addressed at `(module_id, topic)` and retain it as the
latest command for that pair, so a client connecting later is replayed it. Arrays anywhere in
`payload` are encoded on the way out. Returns the number of clients reached.

Retention makes a declaration-shaped topic — `core/subscribe`, `ui/declare` — restore itself on
reconnect; an event-shaped one is harmless to replay because the next event overwrites it.
"""
function send_command(server::Server, module_id::AbstractString, topic::AbstractString, payload)
    m, t = String(module_id), String(topic)
    msg = commands_message([Command(m, t, payload)])
    retain!(server, (m, t), msg)
    return broadcast_all!(server, msg)
end

"""
    send_reply(server::Server, reply::Reply; seq=nothing) -> Int

Broadcast everything a listener chain contributed to `reply` as **one** `commands` batch, applied by
the viewer in the order the chain built it, and retain each command as the latest for its
`(module, topic)`. `seq` echoes the sequence number of the event being answered. An empty reply
sends nothing. Returns the number of clients reached.

One event yields one message however many listeners spoke, so the viewer applies every contribution
at one instant rather than tearing across several.
"""
function send_reply(server::Server, reply::Reply; seq = nothing)
    isempty(reply.commands) && return 0
    # Retained one command at a time: the retention table is keyed by (module, topic), so a batch
    # stored under several keys would replay its every command once per key.
    # Each command's arrays are encoded twice, once into its own frame and once into the
    # batch. Reply payloads are small; hand the batch's region to the retained frames if one is not.
    for c in reply.commands
        retain!(server, (c.module_id, c.topic), commands_message([c]))
    end
    return broadcast_all!(server, commands_message(reply.commands; seq))
end

"""
    send_message(server::Server, module_id, topic, msg) -> Int

Retain and broadcast an already-serialized wire frame under the retention key `(module_id, topic)`.
[`push_window`](@ref) and [`send_command`](@ref) are the usual entry points; this one exists for a
caller that holds the frame itself — to measure its size, or to time serialization separately from
the broadcast. `module_id`/`topic` must describe what `msg` carries, since they are the retain key:
a window goes under `("core", "window")`, a command under the pair it addresses.

`msg` is a [`Frame`](@ref), or a JSON string for a message built by hand — which carries no arrays
and so travels with an empty region.
"""
send_message(server::Server, module_id::AbstractString, topic::AbstractString,
             msg::AbstractString) = send_message(server, module_id, topic, Frame(msg))

function send_message(server::Server, module_id::AbstractString, topic::AbstractString, msg::Frame)
    retain!(server, (String(module_id), String(topic)), msg)
    return broadcast_all!(server, msg)
end

# Store `msg` as the retained state for `key`, replacing any earlier message for the same
# (module, topic) and moving it to the most-recent position so replay order tracks last-update order.
function retain!(server::Server, key::Tuple{String,String}, msg::Frame)
    lock(server.clients_lock) do
        i = findfirst(p -> first(p) == key, server.retained)
        i === nothing || deleteat!(server.retained, i)
        push!(server.retained, key => msg)
    end
    return nothing
end

"""
    CesiumLink.retained(server, key) -> Union{Frame,Nothing}

The wire frame the server holds under `key`, a `(module_id, topic)` pair, or `nothing` when it holds
none. This is the frame a client that connects now is replayed for that pair.

Read the payload of a command with [`declared`](@ref CesiumLink.declared) instead. This returns the
whole frame, which is what the window needs: the window is retained under `("core", "window")` and
carries no command, so `declared` refuses that pair.

A [`Frame`](@ref CesiumLink.Frame) carries its JSON-RPC text as `header`, so reading one field of a
window is a parse
away:

```julia
frame = CesiumLink.retained(server, ("core", "window"))
JSON.parse(frame.header)["params"]["count"]
```

Reads under the server's lock, which is re-entrant, so a caller already holding it may call this.
"""
function retained(server::Server, key::Tuple{String,String})
    lock(server.clients_lock) do
        i = findfirst(p -> first(p) == key, server.retained)
        i === nothing ? nothing : last(server.retained[i])
    end
end

"""
    CesiumLink.declared(server, module_id, topic) -> Any

The payload of the command the server holds under `(module_id, topic)`, or `nothing` when it holds
none. This is what a client that connects now is sent for that pair, so it answers "what does this
session say about X" without a wire frame in hand.

The server keeps one command per pair, so the answer is one payload.

Only a command is readable here. The retention table also holds the window, under
`("core", "window")`, and a window carries no command batch — ask [`retained`](@ref) for that frame
and read its `params`. A pair holding any other kind of frame throws an `ArgumentError`.

```julia
declare_furniture(server; timeline = false)
CesiumLink.declared(server, "core", "furniture")["items"]["timeline"]   # false
```
"""
function declared(server::Server, module_id, topic)
    msg = retained(server, (String(module_id), String(topic)))
    msg === nothing && return nothing
    m = JSON.parse(msg.header)
    # Say which frame the pair holds. Reaching for a batch that is not there fails several hops in,
    # on a missing key that names neither the pair asked for nor the function to ask instead.
    m["method"] == "commands" || throw(ArgumentError(
        "($module_id, $topic) holds a $(m["method"]) frame and no command; read it with `retained`"))
    # `only` rather than `first`: one command per pair is what `retain!` stores, and a batch here
    # means the retention key and the frame disagree.
    return only(m["params"]["commands"])["payload"]
end

# Every retained wire frame in replay order — oldest update first, so the most recent one is applied
# last. `skip` leaves out the keys a caller means to send itself.
function retained_messages(server::Server; skip = ())
    lock(server.clients_lock) do
        [last(p) for p in server.retained if !(first(p) in skip)]
    end
end

"""
    push_window(server, payloads; start_frame, count, dt_seconds, total_frames,
                interval_seconds=1.5, start_time=nothing, mode=:replace) -> Int

Broadcast one **window** — a contiguous run of `count` keyframes carrying every module's data for
those frames — and record it as the current scene (replayed to any client that connects later).
`payloads` is a `module_id => payload` mapping; a module absent from it is not updated by this
window. `start_frame` is **1-based**. See [`window_message`](@ref) for the timing, window and
declared-range keywords. Returns the number of clients reached.

The window carries an identity the server assigns: a `:replace` gets a new one, an `:append` keeps
the one it extends. An event naming an identity that is no longer current is answered with nothing,
since a `:replace` may renumber the entities its indices addressed.

**Pushing a `:replace` from inside a listener voids that listener's reply.** The chain's whole batch
is dropped — the tooltip it also contributed included — because its indices describe the scene the
event was raised on and that scene is gone. A listener that both re-pushes and has something to say
says it with [`send_command`](@ref) after the push, or splits the two into separate gestures. An
`:append` renumbers nothing and leaves the reply intact.

Only a `:replace` stands on its own, so a client connecting once the scene is on an `:append` is not
replayed that window **when the scene answers `core/need`**: the scene is asked for a replacement
covering the same frames, and that window is broadcast like any other. The clients already watching
are re-based on it and ask for what they are then missing. A scene that registers no `core/need`
listener has nothing to ask, so the retained `:append` is replayed as it stands.

```julia
push_window(server, Dict(:tracks => track_payload(1, 2));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240, mode = :replace)
```
"""
function push_window(server::Server, payloads; mode = :replace, kw...)
    window = window_id!(server, mode)
    msg = window_message(payloads; mode, window, kw...)
    # Retained under one key, so a client connecting later is replayed the window on screen — unless
    # it is an `:append`, which the span recorded here is what lets `ready` rebuild instead.
    lock(server.clients_lock) do
        server.window_span = (; start_frame = Int(kw[:start_frame]),
                              count = Int(kw[:count]), mode = Symbol(mode))
    end
    retain!(server, CORE_WINDOW, msg)
    return broadcast_all!(server, msg)
end

"""
    serve_scene!(server, source...; kw...) -> scene

Install the scene `source` describes: build whatever drives it, register its listeners and push its
opening window. Whatever scene the server was already driving is taken down first — see
[`install_scene!`](@ref).

CesiumLink defines no method. A scene is built by the package that knows the data, which adds a
method dispatching on its own type; `push_window` stays the verb for broadcasting a window, and is
what a scene's listeners call every time one is asked for.
"""
function serve_scene! end

"""
    install_scene!(server::Server, scene, listeners) -> scene

Record `scene` and the `listeners` it registered as the one scene this server drives, and take down
whatever was installed before it: the previous scene's listeners are unregistered, and it is logged
that they were.

A server drives at most one scene. Two of them answer every event between them, each holding its own
state and each re-declaring the overlay with its own values, so a control ends up flipping between
two answers forever. Installing replaces rather than refusing, because re-running a scene after
editing it is the normal way to work on one — refusing would make a restart the only way to see the
edit, and doing nothing would silently leave the old scene running in its place.

Every rect the user gave a float is forgotten here. A rect is keyed by float id, and the next scene
is free to use the same ids for other boxes, so a rect that outlived its scene would put a box
somewhere the user never put it.

`scene` is opaque: CesiumLink stores it as `server.scene` and never reads it.
"""
function install_scene!(server::Server, scene, listeners)
    previous = lock(server.clients_lock) do
        gone = server.scene_listeners
        server.scene = scene
        server.scene_listeners = collect(EventListener, listeners)
        empty!(server.float_rects)
        empty!(server.declared_floats)
        gone
    end
    isempty(previous) ||
        @info "replacing the scene installed on this server" listeners = length(previous)
    # Outside the lock: `off_event` takes it, and re-declares the subscription the survivors add up to.
    foreach(l -> off_event(server, l), previous)
    return scene
end
