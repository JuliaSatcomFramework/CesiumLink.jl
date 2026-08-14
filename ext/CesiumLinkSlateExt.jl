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

using CesiumLink: CesiumLink, Server, handle_msg, module_dirs, viewer_dist
import SlateExtensionsBase as SEB

# A connection that is not a socket is written to through `send_frame`, which arrives with the
# per-client send queue (ADR-0030). Until the package carries that seam this host can receive and
# cannot draw, so it says so in the cell rather than mounting a viewer that stays black.
const HAS_SEND_FRAME = isdefined(CesiumLink, :send_frame)

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

if HAS_SEND_FRAME
    CesiumLink.send_frame(c::SlateConn, bytes::Vector{UInt8}) =
        c.emit(c.channel, SEB.SlateBinary(bytes))
end

# One connection per server, for the life of this process. `slate_render` runs several times per cell
# run and again for every browser that connects, so everything it does must be idempotent — this map
# is what makes it so.
const CONNS = Dict{Server,SlateConn}()
const CONNS_LOCK = ReentrantLock()
# Channels are numbered and never reused. Counting the live connections instead would hand a server
# whose cell has just re-run the channel another server is already drawing on.
const CHANNELS = Ref(0)

# The channel a server's frames ride. The process id in it is load-bearing: a page mounts an output
# only when its bytes differ from the ones it already holds, so a replaced worker must render a
# different channel. Without that, the cell keeps the viewer it has, and that viewer talks to a
# process that no longer exists — a scene that goes quiet with nothing said anywhere.
conn_for(server::Server, emit) = lock(CONNS_LOCK) do
    get!(() -> SlateConn("cesiumlink/$(getpid())/$(CHANNELS[] += 1)", emit), CONNS, server)
end

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
    HAS_SEND_FRAME || return SEB.html_fragment(
        "<em>CesiumLink: this notebook host needs the per-client send queue (ADR-0030).</em>")
    conn = conn_for(server, ctx.emit)
    provide_mounts!(server)
    attach!(server, conn)
    # Everything the viewer sends arrives here as one binary buffer, and it is the same frame a
    # socket would have carried. `handle_msg` answers `ready` with the declaration and the retained
    # scene, so a page that reloads catches up the way any mid-session client does.
    SEB.slate_on("$(conn.channel)/up",
                 args -> (handle_msg(server, conn, args["__slate_buffers"][1]); nothing))
    # The teardown runs later, possibly outside any cell, so it closes over what it needs instead of
    # reading the context. It fires before the cell re-evaluates, when the cell is deleted, and
    # before a namespace rebuild.
    off = ctx.off
    SEB.slate_on_cleanup(() -> release!(server, conn, off))
    return SEB.component(Server; channel = conn.channel)
end

# Join and leave the client set. A connection reaching the set is what makes the server broadcast to
# it, and the set holds whatever the send queue wraps a connection in (ADR-0030) — so these two are
# the pair to write when this host is rebased onto that queue.
attach!(server::Server, conn::SlateConn) = lock(server.clients_lock) do
    push!(server.clients, conn)
end

function release!(server::Server, conn::SlateConn, off)
    lock(server.clients_lock) do
        delete!(server.clients, conn)
    end
    lock(CONNS_LOCK) do
        get(CONNS, server, nothing) === conn && delete!(CONNS, server)
    end
    try
        off("$(conn.channel)/up")
    catch
    end
    return nothing
end

end
