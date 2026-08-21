# `setup=[FreePort]` brings `freeport` into scope: a port number nothing is listening on. A test
# that must know the port before the server starts asks for one, because `port = 0` lets the OS
# choose and only the started server can then say which. There is a race between the probe and the
# `start_server` that follows it, and no way to close it from here — the OS hands out a port the
# probe already returned only under a load the suite does not create.
@testsnippet FreePort begin
    using Sockets

    freeport() = (s = Sockets.listen(Sockets.IPv6("::1"), 0);
                  p = Int(Sockets.getsockname(s)[2]); close(s); p)
end

# `setup=[Wire]` brings `lowered` and `header` into scope: the two ways a test looks inside a frame.
# Every frame the server sends is binary, so a test client splits one before it reads anything.
@testsnippet Wire begin
    using CesiumLink, JSON

    # A payload as it travels: the JSON value the header carries, and the region behind it. Decode
    # an array in the first with `decode_arrays(w, region)`.
    function lowered(payload)
        region = IOBuffer()
        return JSON.parse(JSON.json(CesiumLink.encode_arrays(payload, region))), take!(region)
    end

    # The parsed message of one frame received off a socket.
    header(bytes) = JSON.parse(CesiumLink.unpack(bytes).header)
end

# Shared demo window payload for the window and server-push test items. `setup=[DemoWindow]` on a
# @testitem brings `demo_payloads` into scope. The explicit `using CesiumLink` keeps the snippet
# self-contained across test runners.
@testsnippet DemoWindow begin
    using CesiumLink
    # One module's payload for `count` keyframes: a 3×2×count position track — two entities moving
    # over the window, the shape the trailing-keyframe-dimension convention gives.
    demo_payloads(count = 2; title = "demo") =
        Dict(:tracks => (; position = reshape(Float32.(1:(6count)), 3, 2, count), title))
end

# `setup=[Furnished]` brings `declared` into scope: the payload the server holds for a
# `(module, topic)` pair, which is what a client connecting later reads. It is not exported, so a
# test item that asks what the session declares says so here.
@testsnippet Furnished begin
    using CesiumLink
    using CesiumLink: declared
end

# `setup=[WsOpen]` brings `ws_open` into scope: a websocket connection whose block's value comes
# back to the caller. `HTTP.WebSockets.open` returns that value under HTTP 2 and the handshake
# `Response` under HTTP 1, so a test that reads what its block returned goes through here.
@testsnippet WsOpen begin
    using HTTP

    function ws_open(f, url)
        out = Ref{Any}(nothing)
        HTTP.WebSockets.open(url) do ws
            out[] = f(ws)
        end
        return out[]
    end
end

# `setup=[Joining]` brings `first_window` into scope: the `params` of the first window a client that
# has just connected is sent, or `nothing` if none arrives. Reading on a task and waiting on a
# deadline rather than blocking on `receive` is what makes "this client was sent no window at all" a
# failure instead of a hang.
@testsnippet Joining begin
    using CesiumLink, HTTP, JSON

    function first_window(port; timeout = 10.0)
        got = Ref{Any}(nothing)
        HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            reader = @async try
                for msg in ws
                    m = JSON.parse(CesiumLink.unpack(msg).header)
                    if get(m, "method", nothing) == "window"
                        got[] = m["params"]
                        break
                    end
                end
            catch
                # The socket closing under the reader is how this task ends when nothing arrives.
            end
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            timedwait(() -> got[] !== nothing, timeout)
        end
        return got[]
    end
end

# `setup=[CesiumTable]` brings `REFERENCE` and `TOLERANCE_M` into scope: the geodetic ↔ ECEF table
# Cesium itself computed, keyed by ellipsoid name, each entry carrying the two radii and the points.
@testsnippet CesiumTable begin
    using CesiumLink, JSON

    const REFERENCE = JSON.parsefile(joinpath(pkgdir(CesiumLink), "tools", "baseline",
                                              "ellipsoid-reference.json"))["ellipsoids"]

    # The two implementations must agree to a millimetre. An angle is compared as the distance it
    # moves a point on the ellipsoid, which is also what makes the poles comparable: longitude there
    # is arbitrary, and arbitrary times cos(90°) is nothing.
    const TOLERANCE_M = 1e-3
end

# `setup=[Pyramid]` brings `pyramid` into scope: a tile directory on disk, of either layout. The
# mount never reads a tile, so a tile here is a line of bytes under a `.png` name rather than an
# image.
@testsnippet Pyramid begin
    using CesiumLink

    # Fill `dir` with levels 0 to `depth`, two tiles in each. `layout` is `:xyz`, which is levels
    # alone, or `:tms`, which adds the `tilemapresource.xml` a TMS pyramid is known by. `ext` is the
    # name the tiles carry, which an XYZ pyramid declares and so must be read rather than assumed.
    function pyramid(dir; layout = :xyz, depth = 2, ext = "png")
        for z in 0:depth, (x, y) in ((0, 0), (1, 1))
            mkpath(joinpath(dir, string(z), string(x)))
            write(joinpath(dir, string(z), string(x), "$y.$ext"), "tile $z/$x/$y")
        end
        layout === :tms && write(joinpath(dir, "tilemapresource.xml"), "<TileMap/>")
        return dir
    end
end

# `setup=[HeatmapField]` brings the box, its cell centres, a grey colormap and `demand_field` into
# scope. A field that is symmetric hides a wrong reshape and a wrong flip equally well, so the field
# is asymmetric in both axes: the latitude term is monotonic, which catches a vertical flip, and the
# longitudinal lobes catch a horizontal offset.
@testsnippet HeatmapField begin
    using CesiumLink

    # The box every grid covers, and the cell centres of a 6 × 5 grid over it.
    const EXTENT = (-20.0, 10.0, 40.0, 50.0)
    const LONS = [-15.0, -5.0, 5.0, 15.0, 25.0, 35.0]
    const LATS = [14.0, 22.0, 30.0, 38.0, 46.0]
    const GRAY = ["#000000", "#ffffff"]

    demand_field() = [0.4 * sind(3 * lon) + lat / 90 for lon in LONS, lat in LATS]
end

# `setup=[SlateCell]` brings `FakeSlate`, `render_in`, `asset_routes` and `fake_module` into scope:
# a stand-in for the notebook that the Slate host draws in. Slate gives a cell its execution context
# as a NamedTuple in task-local storage under `:slate_ctx`, and the cell id under `:slate_cell`.
# SlateExtensionsBase calls that a convention and reads both keys with plain accessors, so a test
# writes both keys itself. Everything under the render is then the real thing: the server, the
# client, the drain task, `send_frame` and `handle_msg`.
@testsnippet SlateCell begin
    using CesiumLink
    using SlateExtensionsBase: SlateExtensionsBase

    # What the notebook would hold: the frames that went down, the handlers that the render put up,
    # and the teardowns that it registered. `fail` makes the next send throw, which is what a page
    # that goes away looks like from Julia.
    struct FakeSlate
        emitted::Vector{Tuple{String,Any}}
        handlers::Dict{String,Any}
        cleanups::Vector{Any}
        fail::Ref{Bool}
    end

    FakeSlate() = FakeSlate(Tuple{String,Any}[], Dict{String,Any}(), Any[], Ref(false))

    # Keep these five names. SlateExtensionsBase reads the context by field name, and a render that
    # finds no `emit` gives back `nothing` rather than a viewer.
    slate_ctx(f::FakeSlate) = (;
        region = nothing, side = "", regions = Symbol[], notebook = "nb",
        emit = (ch, v) -> (f.fail[] && error("the page is gone"); push!(f.emitted, (ch, v)); nothing),
        on = (ch, h) -> (f.handlers[ch] = h; nothing),
        off = ch -> (delete!(f.handlers, ch); nothing),
        cleanup = h -> (push!(f.cleanups, h); nothing))

    # Render `server` as the cell named `cell` renders it, and give back what that cell then holds.
    # Hold the context for this call alone. Slate sets it for one cell eval, and every eval in a
    # notebook worker is a cell eval. A test item that left it behind would make every server the
    # items after it start a notebook server, on a worker they share.
    function render_in(f::FakeSlate, server, cell::AbstractString)
        task_local_storage(:slate_ctx, slate_ctx(f)) do
            task_local_storage(() -> SlateExtensionsBase.slate_render(server),
                               :slate_cell, String(cell))
        end
    end

    # The routes that the extension serves, keyed by name.
    asset_routes() = getfield(SlateExtensionsBase, :_ASSETS)

    # A file that stands in for a viewer module.
    fake_module(name) = (p = joinpath(mktempdir(), name); write(p, "export default {}"); p)
end
