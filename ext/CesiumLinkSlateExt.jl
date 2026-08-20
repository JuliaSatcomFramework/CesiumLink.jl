module CesiumLinkSlateExt

# The KaimonSlate host: a scene drawn in a notebook cell, on the page socket that the notebook
# already holds. There is no second port and no iframe.
#
# Slate adds SlateExtensionsBase to every notebook worker, so `using CesiumLink` alone loads this
# extension. A cell whose last expression is a `Server` draws the globe. The author writes nothing
# else.
#
# A frame crosses whole. Slate carries raw bytes in both directions and reads neither payload.
# `slate_emit(channel, SlateBinary(bytes))` sends one binary WebSocket frame down.
# `slateCall(channel, args, undefined, [bytes])` sends one back up. Neither direction encodes.

using CesiumLink: CesiumLink, Client, Server, drain_client!, drop_client!, handle_msg, module_dirs,
                  viewer_dist
import SlateExtensionsBase as SEB

"""
One viewer's end of a Slate channel: the notebook's emitter, and the channel that carries the frames.

The render captures the emitter of the notebook namespace while the cell renders. The emitter is not
tied to a browser page, so a page that reloads gets the same emitter. It also works from any task.
The server needs that, because it sends frames from the task that runs the scene.

`server` and `provided` are for the module routes. `provided` is the number of modules whose routes
this connection already gave to Slate.
"""
struct SlateConn
    channel::String
    emit::Any
    server::Server
    provided::Ref{Int}
end

SlateConn(channel, emit, server) = SlateConn(channel, emit, server, Ref(0))

# Serve the route of a module before the frame that declares it leaves. `register_module!` declares a
# new module to the clients that are already connected, and the viewer then imports it from
# `/ext-assets/CesiumLink-module-<id>/`. A module registered after the render has no route until
# here. Only the drain task of this client calls `send_frame`, so the count needs no lock.
#
# Do not write to `bytes` after this call. `SlateBinary` holds a dense array by reference, so the
# frame carries what the array holds when Slate encodes it. `pack` gives a new vector for each
# frame, and a broadcast hands one vector to several clients and writes to none of them.
function CesiumLink.send_frame(c::SlateConn, bytes::Vector{UInt8})
    n = length(c.server.modules)
    if c.provided[] != n
        provide_mounts!(c.server)
        c.provided[] = n
    end
    return c.emit(c.channel, SEB.SlateBinary(bytes))
end

# One client for each server, for the life of this process, with the cell that draws it. The render
# repeats: a cell can display one server more than one time, and a `showable` that Slate answers
# outside a display shares nothing with the display that follows. All that the render does must
# therefore be safe to repeat, and this map makes it so. The map also holds the cell that claimed
# the server, which is what a render from a second cell refuses against.
const CLIENTS = Dict{Server,Tuple{String,Client}}()
const CLIENTS_LOCK = ReentrantLock()
# Each channel gets a new number, and no number comes back. A count of the live connections can give
# a cell that runs again the channel that another server already draws on.
const CHANNELS = Ref(0)

# Give the cell that draws `server`, and the client that carries its frames. If no cell holds the
# server, claim it for `cell`. The caller compares the cell that comes back with its own. A different
# name means that this render must refuse.
#
# This builds the client one time, adds it to the client set, and starts the one task that drains it
# to the channel. The drain task starts before a frame can enter the client queue. The socket host
# uses the same order.
#
# The channel name must contain the process id. A page mounts an output only when its bytes are
# different from the bytes that it holds, so a new worker must render a different channel. If the
# channel stays the same, the cell keeps its viewer, and that viewer speaks to a process that
# stopped. The scene then stops, and no message says why.
client_for(server::Server, cell::String, emit) = lock(CLIENTS_LOCK) do
    get!(CLIENTS, server) do
        client = Client(SlateConn("cesiumlink/$(getpid())/$(CHANNELS[] += 1)", emit, server))
        # The drain task returns when the queue closes, and also when a send fails. `drain_client!`
        # takes the client out of the server on that second path, but it cannot reach this map.
        # Forget the client here for both paths: a render that finds a client with a closed queue
        # cannot answer `ready`, and the viewer then stays empty.
        @async (drain_client!(server, client); forget!(server, client))
        lock(server.clients_lock) do
            push!(server.clients, client)
        end
        (cell, client)
    end
end

# A cell draws its scene on the notebook's own socket, so a server started in one opens no port
# unless the author asks for it. Slate sets the context for the whole cell eval, and `start_server`
# runs in that eval, so this check is true exactly where the cell host applies. A REPL that merely
# has SlateExtensionsBase loaded has no context and keeps its port.
function __init__()
    CesiumLink.NOTEBOOK_CHECK[] = () -> SEB.slate_context() !== nothing
    return nothing
end

# The cell that this render runs in. Slate puts the cell in task-local storage for the eval, with
# the execution context. It is empty for an eval that Slate starts outside a cell.
render_cell() = String(get(task_local_storage(), :slate_cell, ""))

# Serve the directories that the viewer reads from: the dist, one route for each assets mount, and
# one for each registered module. The page builds these names with a rule, so it needs no map. Slate
# replaces the directory when a name is declared again, so this function is safe to run again.
function provide_mounts!(server::Server)
    SEB.provide_assets!("CesiumLink", viewer_dist())
    for (name, dir) in server.asset_dirs
        SEB.provide_assets!("CesiumLink-mount-$name", dir)
    end
    for (id, dir) in module_dirs(server)
        SEB.provide_assets!("CesiumLink-module-$id", dir)
    end
    return nothing
end

# The component that mounts the viewer. It comes from the built dist and not from `lib/`, so the
# component and the bundle that it loads always come from the same build. Slate asks for it the
# first time that a cell shows a `Server`. That is also the first moment that the dist is necessary.
# An earlier read would download the viewer artifact on `using CesiumLink`.
SEB.required_assets(::Type{Server}) = read(joinpath(viewer_dist(), "slate-component.js"), String)

function SEB.slate_render(server::Server)
    ctx = SEB.slate_context()
    # Outside a cell there is no emitter to capture and no page to draw on. Slate then shows the
    # text form of the server, which gives the URL to open when the server has a port.
    ctx === nothing && return nothing
    cell = render_cell()
    owner, client = client_for(server, cell, ctx.emit)
    # One cell draws one server. A second cell needs a second viewer on the channel of the first,
    # but Slate holds one stream handler for each channel. The second viewer thus takes the frames
    # from the first, and the first cell stops with no message. Show the message here instead. A
    # cell that wants a second viewer wants a second server. A cell that only sends to this server
    # needs no viewer.
    # `#cell-<id>` is the anchor that Slate gives to each cell, and that its cross-references use.
    owner == cell || return SEB.html_fragment(
        "<em>CesiumLink: cell <a href=\"#cell-$owner\"><code>$owner</code></a> already draws this " *
        "server. One cell draws one server.</em>")
    # Register the mount component with the page. Slate does this for a widget that the notebook
    # binds. A cell shows a `Server` but does not bind it, so this render must ask. Without the
    # registration, the cell holds an empty component descriptor, and nothing mounts it.
    SEB.ensure_widget_assets!(Server)
    channel = client.conn.channel
    provide_mounts!(server)
    # All that the viewer sends arrives here as one binary buffer. It is the same frame that a
    # socket carries. `handle_msg` answers `ready` with the declaration and the retained scene, so a
    # page that reloads catches up like a client that connects in mid-session.
    SEB.slate_on("$channel/up",
                 args -> (handle_msg(server, client, args.__slate_buffers[1]); nothing))
    # The teardown runs later, and possibly outside any cell. It therefore holds what it needs in a
    # closure, and does not read the context. It runs before the cell evaluates again, when the cell
    # is deleted, and before a rebuild of the namespace.
    off = ctx.off
    SEB.slate_on_cleanup(() -> release!(server, client, off))
    return SEB.component(Server; channel)
end

# Forget the client that draws `server`, if the map still holds this one. The next render then builds
# a new client on a new channel.
function forget!(server::Server, client::Client)
    lock(CLIENTS_LOCK) do
        held = get(CLIENTS, server, nothing)
        held !== nothing && last(held) === client && delete!(CLIENTS, server)
    end
    return nothing
end

# Leave the client set. `drop_client!` removes the client and closes its queue, which stops the drain
# task that started with the client.
function release!(server::Server, client::Client, off)
    drop_client!(server, client)
    forget!(server, client)
    try
        off("$(client.conn.channel)/up")
    catch
    end
    return nothing
end

end
