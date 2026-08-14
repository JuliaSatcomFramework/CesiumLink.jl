module CesiumLinkSlateExt

# The KaimonSlate host: a scene drawn inside a notebook cell, over the notebook's own page socket.
# No second port and no iframe.
#
# Slate stacks SlateExtensionsBase onto every notebook worker, so `using CesiumLink` alone loads this
# extension. A cell whose last expression is a `Server` draws the globe, and the author writes
# nothing else.
#
# The frames cross whole. Slate carries raw bytes in both directions and reads neither payload:
# `slate_emit(channel, SlateBinary(bytes))` goes down as one binary WebSocket frame, and
# `slateCall(channel, args, undefined, [bytes])` comes back up as one. Neither direction encodes.

using CesiumLink: CesiumLink, Client, Server, drain_client!, drop_client!, handle_msg, module_dirs,
                  viewer_dist
import SlateExtensionsBase as SEB

"""
One viewer's end of a Slate channel: the notebook's emitter, and the channel the frames ride.

The emitter is the notebook namespace's own, captured while the cell renders. It is not tied to a
browser page — a page that reloads is served by the same emitter — and it works from any task, which
is what the server needs, since it pushes frames from whatever task the scene runs on.
"""
struct SlateConn
    channel::String
    emit::Any
end

CesiumLink.send_frame(c::SlateConn, bytes::Vector{UInt8}) = c.emit(c.channel, SEB.SlateBinary(bytes))

# One client per server, for the life of this process, and the cell that draws it. `slate_render`
# runs several times per cell run and again for every browser that connects, so everything it does
# must be idempotent — this map is what makes it so.
const CLIENTS = Dict{Server,Tuple{String,Client}}()
const CLIENTS_LOCK = ReentrantLock()
# Channels are numbered and never reused. Counting the live connections instead would hand a server
# whose cell has just re-run the channel another server is already drawing on.
const CHANNELS = Ref(0)

# The cell drawing `server` and the client its frames ride, claimed for `cell` when no cell holds it
# yet. The caller compares the cell that comes back against its own: another cell's name means this
# render must refuse.
#
# The client is built once, joined to the client set, and drained by the one task that writes to the
# channel. The drain task starts before any frame can be enqueued to the client, which is the order
# the socket host uses too.
#
# The process id in the channel is load-bearing: a page mounts an output only when its bytes differ
# from the ones it already holds, so a replaced worker must render a different channel. Without that,
# the cell keeps the viewer it has, and that viewer talks to a process that no longer exists — a
# scene that goes quiet with nothing said anywhere.
client_for(server::Server, cell::String, emit) = lock(CLIENTS_LOCK) do
    get!(CLIENTS, server) do
        client = Client(SlateConn("cesiumlink/$(getpid())/$(CHANNELS[] += 1)", emit))
        @async drain_client!(server, client)
        lock(server.clients_lock) do
            push!(server.clients, client)
        end
        (cell, client)
    end
end

# The cell this render runs in. Slate seeds it into task-local storage for the eval, beside the
# execution context. It is empty for an eval Slate raised outside a cell.
render_cell() = String(get(task_local_storage(), :slate_cell, ""))

# Serve the directories the viewer fetches from, under names the page builds by rule rather than
# from a map: the dist itself, one route per assets mount, and one per registered module. Slate
# replaces the directory when a name is declared again, so this is safe to re-run.
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

# The component that mounts the viewer. It is read from the built dist rather than from `lib/`, so
# the mount and the bundle it loads are always the same build. Slate asks for this the first time a
# `Server` is displayed, which is also the first moment the dist is needed — asking earlier would
# download the viewer artifact on `using CesiumLink`.
SEB.required_assets(::Type{Server}) = read(joinpath(viewer_dist(), "slate-component.js"), String)

function SEB.slate_render(server::Server)
    ctx = SEB.slate_context()
    # Outside a cell there is no emitter to capture and no page to draw on. Slate then shows the
    # server's own text form, which names the URL to open.
    ctx === nothing && return nothing
    cell = render_cell()
    owner, client = client_for(server, cell, ctx.emit)
    # One cell draws one server. A second cell would need a second viewer on the first one's channel,
    # and Slate holds one stream handler per channel — so the second viewer takes the frames off the
    # first, and the cell that was drawing goes quiet with nothing said anywhere. Say it here
    # instead. A cell that wants a second viewer wants a second server; a cell that only pushes to
    # this one needs no viewer at all.
    # `#cell-<id>` is the anchor Slate gives every cell, and what its own cross-references link to.
    owner == cell || return SEB.html_fragment(
        "<em>CesiumLink: cell <a href=\"#cell-$owner\"><code>$owner</code></a> already draws this " *
        "server. One cell draws one server.</em>")
    # Register the mount component with the page. Slate does this itself for a widget the notebook
    # binds, and a `Server` is displayed rather than bound, so the render asks for it. Without this
    # the cell holds an empty component descriptor that nothing ever mounts.
    SEB.ensure_widget_assets!(Server)
    channel = client.conn.channel
    provide_mounts!(server)
    # Everything the viewer sends arrives here as one binary buffer, and it is the same frame a
    # socket would have carried. `handle_msg` answers `ready` with the declaration and the retained
    # scene, so a page that reloads catches up the way any mid-session client does.
    SEB.slate_on("$channel/up",
                 args -> (handle_msg(server, client, args.__slate_buffers[1]); nothing))
    # The teardown runs later, possibly outside any cell, so it closes over what it needs instead of
    # reading the context. It fires before the cell re-evaluates, when the cell is deleted, and
    # before a namespace rebuild.
    off = ctx.off
    SEB.slate_on_cleanup(() -> release!(server, client, off))
    return SEB.component(Server; channel)
end

# Leave the client set. `drop_client!` takes the client out and closes its queue, which ends the drain
# task started with it.
function release!(server::Server, client::Client, off)
    drop_client!(server, client)
    lock(CLIENTS_LOCK) do
        held = get(CLIENTS, server, nothing)
        held !== nothing && last(held) === client && delete!(CLIENTS, server)
    end
    try
        off("$(client.conn.channel)/up")
    catch
    end
    return nothing
end

end
