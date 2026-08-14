@testitem "server static + lifecycle" setup=[FreePort] begin
    using HTTP, Sockets

    mktempdir() do dir
        write(joinpath(dir, "index.html"), "<h1>hi</h1>")
        port = freeport()
        server = start_server(; dist_dir = dir, host = "::1", port = port)
        try
            r = HTTP.get("http://[::1]:$port/")                 # "/" → index.html
            @test r.status == 200
            @test String(r.body) == "<h1>hi</h1>"
            miss = HTTP.get("http://[::1]:$port/nope.js"; status_exception = false)
            @test miss.status == 404
        finally
            stop_server(server)
        end
        # after stop the port is free again (no lingering listener)
        s = Sockets.listen(Sockets.IPv6("::1"), port); close(s)
        @test true
    end
end

@testitem "starting a server drops the discovery files of servers that stopped" begin
    using CesiumLink: sweep_discovery, bound_port

    mktempdir() do dir
        held = start_server(; dist_dir = nothing)
        try
            mine = Int(Base.Libc.getpid())
            port = bound_port(held)
            live = joinpath(dir, "$mine-$port.json")
            # A port nothing listens on: port 1 is privileged, so no scene of ours holds it.
            gone = joinpath(dir, "$mine-1.json")
            # The case a check on the port alone keeps forever. A scene is usually served on a port
            # its author picked and reuses, so a file a dead process left names a port that answers
            # again today.
            reused = joinpath(dir, "999998-$port.json")
            unrelated = joinpath(dir, "notes.txt")
            unnamed = joinpath(dir, "nothing-here.json")
            for f in (live, gone, reused, unrelated, unnamed)
                write(f, "{}")
            end

            sweep_discovery(dir)

            @test isfile(live)                    # this process runs and its port answers
            @test !isfile(gone)
            @test isfile(unrelated)               # the sweep reads `.json` and nothing else
            @test isfile(unnamed)                 # a name carrying no pid and port says nothing
            if Sys.isunix()
                @test !isfile(reused)
            else
                # Windows judges a file by its port alone, so this one stands.
                @test isfile(reused)
            end
        finally
            stop_server(held)
        end
    end
end

@testitem "the traversal guard reads path elements, not a separator" begin
    using CesiumLink: under_root

    root = normpath(abspath(joinpath("a", "b", "dist")))
    @test under_root(joinpath(root, "index.html"), root)
    @test under_root(joinpath(root, "cesium", "Assets", "tile.png"), root)
    # Strictly under: neither the root itself nor a sibling whose name starts with it.
    @test !under_root(root, root)
    @test !under_root(root * "Evil", root)
    @test !under_root(joinpath(root * "Evil", "x.js"), root)
    @test !under_root(normpath(joinpath(root, "..", "secret")), root)
    # A root written with a trailing separator names the same directory, so it serves the same
    # files. A guard that compares the two strings answers no to every one of them.
    @test under_root(joinpath(root, "index.html"), root * "/")
end

@testitem "server push + ready replay" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port = port)
    try
        # Sets the current window before the client connects, so what arrives is the replay.
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 60,
                    total_frames = 8)

        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header            # replayed window
        end

        s = JSON.parse(got)
        @test s["method"] == "window"
        @test s["params"]["startFrame"] == 0
        @test haskey(s["params"]["payloads"], "tracks")    # addressed to the module by name
    finally
        stop_server(server)
    end
end

@testitem "core/need reaches its listener with a 1-based start frame, its count and its mode" setup=[FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        seen = Ref{Any}(nothing)
        # Registered AFTER start_server: reachable only because dispatch_event goes through
        # Base.invokelatest, the same world-age regression every listener has.
        on_event(server, "core", "need") do ev, reply
            seen[] = (ev.start_frame, ev.count, ev.mode)
        end

        ask(payload) = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            seen[] = nothing
            # `module` is a Julia keyword, so the event's params are built as a Dict here.
            HTTP.WebSockets.send(ws, JSON.json((; method = "event",
                params = Dict("module" => "core", "topic" => "need", "payload" => payload))))
            deadline = time() + 10
            while seen[] === nothing && time() < deadline
                sleep(0.02)
            end
            seen[]
        end

        # wire frame 12 (0-based) → 13; a viewer only ever asks to extend what it holds.
        @test ask((; startFrame = 12, count = 1)) == (13, 1, :append)
        # A viewer naming no count is given the pair interpolation needs.
        @test ask((; startFrame = 12)) == (13, 2, :append)
    finally
        stop_server(server)
    end
end

@testitem "a throwing core/need listener leaves the connection open" setup=[FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        on_event((ev, reply) -> error("ran out of frames"), server, "core", "need")

        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "event",
                params = Dict("module" => "core", "topic" => "need",
                              "payload" => Dict("startFrame" => 3)))))
            # Starvation is already a pause; it must not also cost the connection. `ready` is
            # answered on the same socket, so a declaration coming back says it is still open.
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
        end
        @test got["method"] == "modules"
    finally
        stop_server(server)
    end
end

@testitem "a core/need event is answered by appending to the delivered buffer" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # The streaming-advance recipe: answer the request with the frames it asked for, appended so
        # the viewer keeps the index space it is already interpolating against.
        on_event(server, "core", "need") do ev, reply
            push_window(server, demo_payloads(ev.count); start_frame = ev.start_frame,
                        count = ev.count, dt_seconds = 60, total_frames = 8, mode = ev.mode)
        end

        HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            # `module` is a Julia keyword, so the event's params are built as a Dict here.
            HTTP.WebSockets.send(ws, JSON.json((; method = "event",
                params = Dict("module" => "core", "topic" => "need",
                              "payload" => Dict("startFrame" => 4, "count" => 2)))))
            m = JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            @test m["method"] == "window"
            p = m["params"]
            @test p["startFrame"] == 4        # the 0-based frame the viewer asked from
            @test p["totalFrames"] == 8       # the declared range is unchanged by a top-up
            @test p["mode"] == "append"
            @test p["count"] == 2             # the count the request named
        end
    finally
        stop_server(server)
    end
end

@testitem "the window rebuilt for a joining client carries the identity every client then names" setup=[DemoWindow, Joining, FreePort] begin

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        on_event(server, "core", "need") do ev, reply
            push_window(server, demo_payloads(ev.count; title = "$(ev.mode) from $(ev.start_frame)");
                        start_frame = ev.start_frame, count = ev.count, dt_seconds = 240,
                        total_frames = 10, mode = ev.mode)
        end
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :replace)
        push_window(server, demo_payloads(1); start_frame = 3, count = 1, dt_seconds = 240,
                    total_frames = 10, mode = :append)

        # The append on screen extends a replace this client never saw, so it is not what it gets.
        p = first_window(port)
        @test p["mode"] == "replace"
        @test p["startFrame"] == 2                              # the append's frames, 0-based
        @test p["count"] == 1
        @test p["payloads"]["tracks"]["title"] == "replace from 3"
        # Rebuilding mints an identity, and it is the one every client now names.
        @test p["window"] == server.window_id
    finally
        stop_server(server)
    end
end

@testitem "a client joining an appended scene is answered by a core/need listener" setup=[DemoWindow, Joining, FreePort] begin

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # The other way a scene answers for keyframes: a listener rather than the handler. The mode
        # the request names is the one it pushes, so a scene written this way rebuilds too.
        on_event(server, "core", "need") do ev, reply
            push_window(server, demo_payloads(ev.count; title = "$(ev.mode) from $(ev.start_frame)");
                        start_frame = ev.start_frame, count = ev.count, dt_seconds = 240,
                        total_frames = 10, mode = ev.mode)
        end
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :replace)
        push_window(server, demo_payloads(); start_frame = 3, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :append)

        p = first_window(port)
        @test p["mode"] == "replace"
        @test p["startFrame"] == 2
        @test p["payloads"]["tracks"]["title"] == "replace from 3"
    finally
        stop_server(server)
    end
end

@testitem "a throwing core/need listener leaves the joining client the window the server holds" setup=[DemoWindow, Joining, FreePort] begin

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # A listener that throws costs a warning rather than the session, so the rebuild yields no
        # window. Left at that this client would hold nothing and have nothing to raise a request
        # that would recover it, since the viewer asks for nothing until a first window has landed.
        on_event((ev, reply) -> error("no frames here"), server, "core", "need")
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :replace)
        push_window(server, demo_payloads(); start_frame = 3, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :append)

        p = first_window(port)
        @test p !== nothing                     # not left with no window at all
        @test p["mode"] == "append"             # what the server holds, since nothing replaced it
        @test p["startFrame"] == 2
    finally
        stop_server(server)
    end
end

@testitem "a core/need listener that pushes nothing leaves the joining client the window the server holds" setup=[DemoWindow, Joining, FreePort] begin

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # Returning without pushing is the quieter way to produce no window, and comes to the same
        # thing for the client.
        on_event((ev, reply) -> nothing, server, "core", "need")
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :replace)
        push_window(server, demo_payloads(); start_frame = 3, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :append)

        p = first_window(port)
        @test p !== nothing
        @test p["mode"] == "append"
        @test p["startFrame"] == 2
    finally
        stop_server(server)
    end
end

@testitem "with nothing to ask for a window, the retained one is replayed as it stands" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :replace)
        push_window(server, demo_payloads(); start_frame = 3, count = 2, dt_seconds = 240,
                    total_frames = 10, mode = :append)

        p = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)["params"]
        end
        @test p["mode"] == "append"
        @test p["startFrame"] == 2
    finally
        stop_server(server)
    end
end

@testitem "a pushed window carries its start frame, declared range, mode and identity" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # A `:replace` mints an identity; the `:append` that continues it repeats that one, because
        # an append preserves the index space every request against it was resolved in.
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 20, mode = :replace)
        push_window(server, demo_payloads(); start_frame = 5, count = 2, dt_seconds = 240,
                    total_frames = 20, mode = :append)

        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header
        end
        p = JSON.parse(got)["params"]
        @test p["startFrame"] == 4                  # 1-based start_frame 5 → 0-based on the wire
        @test p["totalFrames"] == 20
        @test p["mode"] == "append"
        @test p["count"] == 2
        @test p["window"] == 1                      # the identity the replace before it minted
    finally
        stop_server(server)
    end
end

@testitem "a listener's replacement window becomes the scene a reconnecting client replays" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 240,
                    total_frames = 10)
        # The listener answers the way a filter does: a replacement window covering the frame the
        # viewer was at, whose contents already reflect the control's value.
        on_event(server, "ui", "control") do ev, reply
            push_window(server, demo_payloads(1; title = "filtered=$(ev.payload.value)");
                        start_frame = ev.frame, count = 1, dt_seconds = 240, total_frames = 10,
                        mode = :replace)
            return nothing
        end

        HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "event",
                params = Dict("module" => "ui", "topic" => "control", "frame" => 3,
                              "payload" => Dict("id" => "user", "value" => false)))))
        end

        # What a reconnecting client is replayed is the observable here. The chain runs on the
        # listener task, so poll a fresh connection's replay until it shows the control's window —
        # bounded, so a listener that never ran fails rather than hangs.
        # The listener's own subscription is retained alongside the window and replayed with it, so
        # the window is picked out of the replay by method rather than by position.
        replay() = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            frames = [JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header) for _ in 1:2]
            only(m["params"] for m in frames if m["method"] == "window")
        end
        p = replay()
        deadline = time() + 10
        while p["startFrame"] != 3 && time() < deadline
            sleep(0.05)
            p = replay()
        end
        @test p["startFrame"] == 3               # the window the control produced, not the original
        @test p["mode"] == "replace"
        @test p["payloads"]["tracks"]["title"] == "filtered=false"
    finally
        stop_server(server)
    end
end

@testitem "retained replay: latest per (module, topic), all topics on connect" setup=[FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # Two distinct (module, topic) pairs retain independently; a repeat on one keeps the latest.
        send_command(server, "heatmap", "field", Dict("a" => 1))
        send_command(server, "heatmap", "field", Dict("a" => 2))   # overwrites the first
        send_command(server, "ui", "declare", Dict("b" => 9))

        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            # Two retained topics → two replayed frames, in recency order of last update.
            (CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header, CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
        end
        c1 = only(JSON.parse(got[1])["params"]["commands"])
        c2 = only(JSON.parse(got[2])["params"]["commands"])
        @test c1["module"] == "heatmap" && c1["topic"] == "field"
        @test c1["payload"]["a"] == 2               # only the latest command for the pair survives
        @test c2["module"] == "ui" && c2["topic"] == "declare"
        @test c2["payload"]["b"] == 9
    finally
        stop_server(server)
    end
end

@testitem "declared answers a command, and says so for a pair holding anything else" setup=[DemoWindow] begin
    using CesiumLink: declared

    server = start_server(; host = "::1", port = 0)
    try
        @test declared(server, "heatmap", "field") === nothing      # nothing retained for the pair
        send_command(server, "heatmap", "field", Dict("a" => 2))
        @test declared(server, "heatmap", "field")["a"] == 2

        # The window shares the retention table and carries no command batch, so the pair that holds
        # it names the function to ask instead.
        push_window(server, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 60,
                    total_frames = 2)
        @test_throws "holds a window frame and no command" declared(server, "core", "window")
        @test CesiumLink.retained(server, ("core", "window")) !== nothing
    finally
        stop_server(server)
    end
end

@testitem "a window's identity is new on a replace and held across an append" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # The retained window is what a client reads the identity from, so replay it after each push.
        window() = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)             # the `modules` declaration, discarded
            JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)["params"]["window"]
        end
        push_window(server, demo_payloads(1); start_frame = 1, count = 1, dt_seconds = 240,
                    total_frames = 8)
        w0 = window()
        push_window(server, demo_payloads(1); start_frame = 2, count = 1, dt_seconds = 240,
                    total_frames = 8, mode = :append)
        # An append preserves the index space, so requests asked against the window it extends stay
        # valid — the identity must not move under them.
        @test window() == w0
        push_window(server, demo_payloads(1); start_frame = 1, count = 1, dt_seconds = 240,
                    total_frames = 8, mode = :replace)
        @test window() != w0
    finally
        stop_server(server)
    end
end

@testitem "a registered module is declared on ready and served from its own directory" setup=[FreePort] begin
    using HTTP, JSON

    mktempdir() do dir
        # The module's directory is mounted whole, so a sibling chunk resolves relative to the entry.
        mod_dir = mkpath(joinpath(dir, "heat"))
        write(joinpath(mod_dir, "heatmap.js"), "export default { setup() {} };")
        write(joinpath(mod_dir, "chunk.js"), "export const k = 1;")
        dist = mkpath(joinpath(dir, "dist"))
        write(joinpath(dist, "index.html"), "<h1>hi</h1>")

        port = freeport()
        server = start_server(; dist_dir = dist, host = "::1", port)
        try
            register_module!(server, :heatmap, joinpath(mod_dir, "heatmap.js"))
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            end
            @test got["method"] == "modules"
            @test got["params"]["modules"] == [Dict("id" => "heatmap",
                                                    "url" => "/modules/heatmap/heatmap.js",
                                                    "apiVersion" => CesiumLink.MODULE_API_VERSION)]
            # Nothing declared, so nothing is on the wire and the viewer keeps its WGS84 default.
            @test !haskey(got["params"], "ellipsoid")

            entry = HTTP.get("http://[::1]:$port/modules/heatmap/heatmap.js")
            @test entry.status == 200
            @test String(entry.body) == "export default { setup() {} };"
            @test HTTP.header(entry, "Content-Type") == "text/javascript"
            # A sibling of the entry file, reached by a relative import from it.
            @test String(HTTP.get("http://[::1]:$port/modules/heatmap/chunk.js").body) == "export const k = 1;"
            # The dist is still served, and an unregistered id is not a hole in it.
            @test String(HTTP.get("http://[::1]:$port/").body) == "<h1>hi</h1>"
            @test HTTP.get("http://[::1]:$port/modules/nope/x.js";
                           status_exception = false).status == 404
            # A module directory does not open a path out of itself.
            @test HTTP.get("http://[::1]:$port/modules/heatmap/../../dist/index.html";
                           status_exception = false).status in (403, 404)
        finally
            stop_server(server)
        end
    end
end

@testitem "modules are declared in registration order, and an id registered again keeps its place" setup=[FreePort] begin
    using JSON

    mktempdir() do dir
        for f in ("a.js", "b.js")
            write(joinpath(dir, f), "export default { setup() {} };")
        end
        server = start_server(; host = "::1", port = freeport())
        register_module!(server, :b, joinpath(dir, "b.js"))
        register_module!(server, :a, joinpath(dir, "a.js"); api_version = 7)

        # Registration order is the order the viewer draws and stacks in, so the declaration must
        # not be sorted or deduplicated by name.
        mods = JSON.parse(CesiumLink.modules_message(server.modules).header)["params"]["modules"]
        @test [m["id"] for m in mods] == ["b", "a"]
        @test mods[2]["apiVersion"] == 7

        # A scene installed a second time registers its modules a second time, from whatever path it
        # holds them at this run. The entry given last is the one declared, in the place the first
        # registration took.
        register_module!(server, :b, joinpath(dir, "a.js"))
        mods = JSON.parse(CesiumLink.modules_message(server.modules).header)["params"]["modules"]
        @test [m["id"] for m in mods] == ["b", "a"]
        @test mods[1]["url"] == "/modules/b/a.js"
        stop_server(server)
    end
end

@testitem "a module entry is rejected before it can be declared" begin
    mktempdir() do dir
        write(joinpath(dir, "m.js"), "export default { setup() {} };")
        # A missing file would reach the browser as a 404 on an import; fail where the mistake is.
        @test_throws "no module entry file at" ModuleEntry(:m, joinpath(dir, "gone.js"))
        # The id becomes a URL path segment verbatim, so anything the browser would resolve
        # elsewhere is refused rather than declared.
        @test_throws "[A-Za-z0-9._-]" ModuleEntry("a/b", joinpath(dir, "m.js"))
        @test_throws "[A-Za-z0-9._-]" ModuleEntry("..", joinpath(dir, "m.js"))
        @test_throws "[A-Za-z0-9._-]" ModuleEntry("", joinpath(dir, "m.js"))
        @test ModuleEntry(:m, joinpath(dir, "m.js")).api_version == CesiumLink.MODULE_API_VERSION
    end
end

@testitem "the declared ellipsoid reaches the client on the session declaration" setup=[FreePort] begin
    using HTTP, JSON

    port = freeport()
    # Mars: visibly not Earth, so a globe built on it cannot be mistaken for the default.
    server = start_server(; host = "::1", port, ellipsoid = (a = 3396190.0, b = 3376200.0))
    try
        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
        end
        @test got["method"] == "modules"
        # The viewer builds its widget out of this message, so the shape has to ride on the first
        # thing it receives rather than on anything that follows.
        @test got["params"]["ellipsoid"] == Dict("a" => 3396190.0, "b" => 3376200.0)
        @test got["params"]["modules"] == []
    finally
        stop_server(server)
    end

    @test Ellipsoids.WGS84.a > Ellipsoids.WGS84.b             # semi-major, then semi-minor
    @test Ellipsoids.MOON.a == Ellipsoids.MOON.b              # the Moon is a sphere
    @test Ellipsoids.MARS.a > Ellipsoids.MARS.b
    # A body is qualified, and only qualified: the submodule is not re-exported, so `using
    # CesiumLink` supplies the namespace and none of the three names in it.
    @test !isdefined(@__MODULE__, :WGS84)
    named = start_server(; host = "::1", port = freeport(), ellipsoid = Ellipsoids.WGS84)
    @test named.ellipsoid == Ellipsoids.WGS84
    stop_server(named)

    for body in (Ellipsoids.MOON, Ellipsoids.MARS)
        s = start_server(; host = "::1", port = freeport(), ellipsoid = body)
        @test s.ellipsoid == body
        stop_server(s)
    end

    # A shape no globe can be built on fails here, not as a blank page in the browser.
    @test_throws "positive and finite" start_server(; host = "::1", port = freeport(),
                                                    ellipsoid = (a = 6378137.0, b = 0.0))
    @test_throws "positive and finite" start_server(; host = "::1", port = freeport(),
                                                    ellipsoid = (a = -1.0, b = 1.0))
end

@testitem "a shape too flattened for the render loop warns, and is still accepted" begin
    using Logging

    # Cesium's per-frame curvature computation fails once the camera is |z| ≥ b / |a²/b² − 1| from
    # the equatorial plane. At b = 4.0e6 that is 2.6e6 m — the camera is past it before the first
    # frame — so the declaration has to say so out loud.
    # It is a warning and never a rejection, so the radii still come back as declared.
    flat = (a = 6378137.0, b = 4.0e6)
    got = @test_logs (:warn, r"render loop") match_mode = :any CesiumLink.ellipsoid_radii(flat)
    @test got == flat

    # Oblate enough to see, and its limit — 46e6 m — is past any usual camera range: nothing to say.
    @test_logs min_level = Logging.Warn CesiumLink.ellipsoid_radii((a = 6378137.0, b = 6.0e6))
    @test_logs min_level = Logging.Warn CesiumLink.ellipsoid_radii(Ellipsoids.WGS84)
    @test_logs min_level = Logging.Warn CesiumLink.ellipsoid_radii((a = 1.0, b = 1.0))
end

@testitem "a client reporting a globe on another ellipsoid is an error naming both" setup=[FreePort] begin
    using JSON, Logging

    # What the viewer sends once its globe exists. `module` is a Julia keyword, so the event's
    # params are built as a Dict here.
    report(a, b) = JSON.json((; method = "event",
        params = Dict("module" => "core", "topic" => "ellipsoid",
                      "payload" => Dict("a" => a, "b" => b))))

    server = start_server(; host = "::1", port = freeport(),
                          ellipsoid = (a = 3396190.0, b = 3376200.0))
    try
        # The radii it was told: nothing to say.
        @test_logs min_level = Logging.Error CesiumLink.handle_msg(server, nothing,
            report(3396190.0, 3376200.0))
        # A viewer that fell back to WGS84 draws a plausible scene at the wrong latitude and the
        # wrong height, so the disagreement has to be said out loud.
        @test_logs (:error, r"other than the declared one") match_mode = :any CesiumLink.handle_msg(
            server, nothing, report(Ellipsoids.WGS84.a, Ellipsoids.WGS84.b))
        @test_logs (:error, r"unreadable") match_mode = :any CesiumLink.handle_msg(
            server, nothing, report(nothing, nothing))
    finally
        stop_server(server)
    end

    # Declaring nothing means WGS84, and that is what a report is compared against.
    plain = start_server(; host = "::1", port = freeport())
    try
        @test_logs min_level = Logging.Error CesiumLink.handle_msg(plain, nothing,
            report(Ellipsoids.WGS84.a, Ellipsoids.WGS84.b))
        @test_logs (:error, r"other than the declared one") match_mode = :any CesiumLink.handle_msg(
            plain, nothing, report(3396190.0, 3376200.0))
    finally
        stop_server(plain)
    end
end

@testitem "a served file revalidates, and a rebuild invalidates the tag, the body and the gzip" setup=[FreePort] begin
    using HTTP, CodecZlib

    mktempdir() do dir
        built = repeat("export const k = 1;\n", 200)      # over the floor below which gzip is skipped
        file = joinpath(dir, "app.js")
        write(file, built)
        port = freeport()
        server = start_server(; dist_dir = dir, host = "::1", port)
        try
            url = "http://[::1]:$port/app.js"
            # `decompress = false` keeps HTTP.jl from adding its own `Accept-Encoding` and from
            # unpacking the body, so what these read is what went over the wire.
            fresh = HTTP.get(url, ["Accept-Encoding" => "gzip"]; decompress = false)
            tag = HTTP.header(fresh, "ETag")
            @test !isempty(tag)
            @test String(transcode(GzipDecompressor, fresh.body)) == built

            held = HTTP.get(url, ["If-None-Match" => tag];
                            decompress = false, status_exception = false)
            @test held.status == 304
            @test isempty(held.body)

            # A rebuild writing the same number of bytes still invalidates: the tag tracks the file's
            # modification time, not only its length. The pause keeps the two mtimes apart.
            sleep(0.05)
            rebuilt = replace(built, "k = 1" => "k = 2")
            @test length(rebuilt) == length(built)
            write(file, rebuilt)

            after = HTTP.get(url, ["If-None-Match" => tag, "Accept-Encoding" => "gzip"];
                             decompress = false)
            @test after.status == 200
            @test HTTP.header(after, "ETag") != tag
            # The compressed copy taken before the rebuild is not what the second build gets served.
            @test String(transcode(GzipDecompressor, after.body)) == rebuilt
            @test String(HTTP.get(url; decompress = false).body) == rebuilt
        finally
            stop_server(server)
        end
    end
end

@testitem "an .mjs module is served as JavaScript, and compresses as one" setup=[FreePort] begin
    using HTTP, CodecZlib

    mktempdir() do dir
        mod_dir = mkpath(joinpath(dir, "heat"))
        built = repeat("export const k = 1;\n", 200)      # over the floor below which gzip is skipped
        write(joinpath(mod_dir, "heatmap.mjs"), built)
        # The same bytes under an extension no content type is known for. Whether a body is
        # compressed follows from the resolved type, so this one is sent as it is — which is what
        # ties the compression below to `.mjs` being JavaScript rather than to its size.
        write(joinpath(mod_dir, "heatmap.unknown"), built)
        port = freeport()
        server = start_server(; dist_dir = dir, host = "::1", port)
        try
            register_module!(server, :heat, joinpath(mod_dir, "heatmap.mjs"))
            # A browser refuses to execute a module that does not arrive as JavaScript, so the entry
            # file of a mounted module has to carry that type whichever of the two extensions it uses.
            gz = HTTP.get("http://[::1]:$port/modules/heat/heatmap.mjs",
                          ["Accept-Encoding" => "gzip"]; decompress = false)
            @test HTTP.header(gz, "Content-Type") == "text/javascript"
            @test HTTP.header(gz, "Content-Encoding") == "gzip"
            @test length(gz.body) < length(built)
            @test String(transcode(GzipDecompressor, gz.body)) == built

            other = HTTP.get("http://[::1]:$port/modules/heat/heatmap.unknown",
                             ["Accept-Encoding" => "gzip"]; decompress = false)
            @test HTTP.header(other, "Content-Type") == "application/octet-stream"
            @test HTTP.header(other, "Content-Encoding") == ""
            @test length(other.body) == length(built)
        finally
            stop_server(server)
        end
    end
end

@testitem "a client offering gzip gets compressed bytes, one that does not gets the file" setup=[FreePort] begin
    using HTTP, CodecZlib

    mktempdir() do dir
        built = repeat("export const k = 1;\n", 200)
        write(joinpath(dir, "app.js"), built)
        # An already-compressed format: offering gzip must not make the server spend CPU on it.
        write(joinpath(dir, "tile.png"), repeat("not really a png", 200))
        port = freeport()
        server = start_server(; dist_dir = dir, host = "::1", port)
        try
            gz = HTTP.get("http://[::1]:$port/app.js", ["Accept-Encoding" => "gzip"];
                          decompress = false)
            @test HTTP.header(gz, "Content-Encoding") == "gzip"
            @test HTTP.header(gz, "Vary") == "Accept-Encoding"
            @test length(gz.body) < length(built)
            @test parse(Int, HTTP.header(gz, "Content-Length")) == length(gz.body)
            @test String(transcode(GzipDecompressor, gz.body)) == built

            plain = HTTP.get("http://[::1]:$port/app.js"; decompress = false)
            @test HTTP.header(plain, "Content-Encoding") == ""
            @test String(plain.body) == built
            @test HTTP.header(plain, "Content-Type") == "text/javascript"

            png = HTTP.get("http://[::1]:$port/tile.png", ["Accept-Encoding" => "gzip"];
                           decompress = false)
            @test HTTP.header(png, "Content-Encoding") == ""
            @test length(png.body) == 3200
        finally
            stop_server(server)
        end
    end
end

@testitem "a client announcing another protocol version is closed, not humoured" setup=[FreePort] begin
    using HTTP, JSON
    using CesiumLink: PROTOCOL_VERSION

    port = freeport()
    server = start_server(; dist_dir = nothing, host = "::1", port)
    try
        # A viewer built against another version of the framing parses no frame this server sends,
        # and reports nothing about it. Refusing it names the disagreement instead.
        HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = PROTOCOL_VERSION + 1))))
            # No declaration, no retained scene — the socket closes instead.
            @test_throws HTTP.WebSockets.WebSocketError HTTP.WebSockets.receive(ws)
        end
    finally
        stop_server(server)
    end
end

@testitem "a server picks its own port, and viewer_url says where the page is" begin
    using HTTP

    # Two servers at once, both on the default port. Neither names a number, and neither collides.
    a = start_server(; dist_dir = nothing)
    b = start_server(; dist_dir = nothing)
    try
        @test bound_port(a) > 0
        @test bound_port(b) > 0
        @test bound_port(a) != bound_port(b)
        @test viewer_url(a) == "http://127.0.0.1:$(bound_port(a))/?ws=auto"
        # The URL is one a browser can be sent to: it answers.
        @test HTTP.get(viewer_url(a); status_exception = false).status == 404
    finally
        stop_server(a)
        stop_server(b)
    end
    # A stopped server has no page to open.
    @test_throws "stopped" viewer_url(a)
end

@testitem "viewer_url names an address a browser can reach, whatever the bind" begin
    # A wildcard bind answers everywhere, so it is not itself an address; an IPv6 literal takes the
    # brackets a URL needs.
    @test CesiumLink.url_host("::") == "127.0.0.1"
    @test CesiumLink.url_host("0.0.0.0") == "127.0.0.1"
    @test CesiumLink.url_host("::1") == "[::1]"
    @test CesiumLink.url_host("127.0.0.1") == "127.0.0.1"

    server = start_server(; dist_dir = nothing, host = "::1")
    try
        @test viewer_url(server) == "http://[::1]:$(bound_port(server))/?ws=auto"
    finally
        stop_server(server)
    end
end

@testitem "an explicit port another server holds throws instead of returning a dead server" begin
    held = start_server(; dist_dir = nothing)
    try
        if Sys.iswindows()
            # Windows admits the second bind. A socket there takes a port another socket holds unless
            # the first asked for exclusive use, so there is no error to report and no dead server:
            # the second one binds, and a request reaches one of the two listeners.
            second = start_server(; dist_dir = nothing, port = bound_port(held))
            try
                @test bound_port(second) == bound_port(held)
            finally
                stop_server(second)
            end
        else
            # The failure mode this replaces: a `Server` that bound nothing, answers nothing and
            # reports nothing wrong.
            @test_throws "could not listen on" start_server(; dist_dir = nothing,
                                                           port = bound_port(held))
        end
    finally
        stop_server(held)
    end
end

@testitem "a running server writes a discovery file, and stopping removes it" begin
    using JSON

    mktempdir() do runtime
        # The real runtime directory belongs to the user's own sessions. Point the discovery
        # directory at a temporary one for this test, and put it back afterwards.
        was = get(ENV, "XDG_RUNTIME_DIR", nothing)
        ENV["XDG_RUNTIME_DIR"] = runtime
        try
            @test discovery_dir() == joinpath(runtime, "cesiumlink")

            one = start_server(; dist_dir = nothing, title = "the first scene")
            two = start_server(; dist_dir = nothing, title = "the second scene")
            try
                files = readdir(discovery_dir())
                @test length(files) == 2

                pid = Int(Base.Libc.getpid())
                # Named by pid and port, so two servers in one process each keep their own file.
                @test "$pid-$(bound_port(one)).json" in files
                @test "$pid-$(bound_port(two)).json" in files

                entry = JSON.parse(read(joinpath(discovery_dir(),
                                                 "$pid-$(bound_port(one)).json"), String))
                @test entry["port"] == bound_port(one)
                @test entry["pid"] == pid
                @test entry["title"] == "the first scene"
                # An ISO 8601 instant in UTC, so a picker can order and show it.
                @test occursin(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", entry["started"])
                # These servers pass `dist_dir = nothing` and serve no assets over HTTP. The file
                # still names the tree the package resolved, because a reader that hosts the page
                # itself mounts that directory.
                @test entry["dist"] == CesiumLink.viewer_dist()

                # A scene binds to loopback, and one machine's loopback is shared by everyone on
                # it, so the file must not name the port to every other user. `/run/user/<uid>` is
                # already 700; the two fallbacks sit under world-readable directories.
                if Sys.isunix()
                    @test filemode(discovery_dir()) & 0o777 == 0o700
                    @test filemode(joinpath(discovery_dir(),
                                            "$pid-$(bound_port(one)).json")) & 0o777 == 0o600
                end
            finally
                stop_server(one)
                stop_server(two)
            end
            # Both gone: nothing offers a scene that stopped.
            @test isempty(readdir(discovery_dir()))
        finally
            was === nothing ? delete!(ENV, "XDG_RUNTIME_DIR") : (ENV["XDG_RUNTIME_DIR"] = was)
        end
    end
end

@testitem "a scene reaches an editor from a VSCode terminal alone" begin
    mktempdir() do dir
        # A stand-in for the VSCode command line, which records what it was asked to do. Nothing
        # else tells a test whether the push ran: the real call is detached and its window is on
        # somebody's screen.
        seen = joinpath(dir, "seen")
        code = joinpath(dir, "code")
        write(code, "#!/bin/sh\necho \"\$@\" > \"$seen\"\n")
        Sys.isunix() && chmod(code, 0o755)
        ran() = begin
            # The push is detached, so give the process time to write before reading the answer.
            for _ in 1:200
                isfile(seen) && break
                sleep(0.05)
            end
            isfile(seen) ? strip(read(seen, String)) : nothing
        end

        withenv("PATH" => dir * ":" * get(ENV, "PATH", ""),
                "VSCODE_IPC_HOOK_CLI" => nothing, "TERM_PROGRAM" => nothing) do
            # A plain SSH session must see nothing at all. This is the branch a user meets on every
            # machine that has no editor, the harness and CI among them.
            @test CesiumLink.push_to_editor(50004, :auto) == "the environment names no VSCode terminal"
            @test !isfile(seen)

            if Sys.isunix()
                # `true` asks wherever it runs, and a terminal that names no socket is answered by
                # the desktop command line.
                @test CesiumLink.push_to_editor(50004, true) === nothing
                # The port is a path segment: a query reaches the handler percent-encoded.
                @test ran() == "--open-url vscode://disberd.cesiumlink/open/50004"
            end
        end

        # The socket names the window to ask, and the push needs it.
        rm(seen; force = true)
        withenv("PATH" => dir * ":" * get(ENV, "PATH", ""),
                "VSCODE_IPC_HOOK_CLI" => "/run/user/1000/vscode-ipc.sock",
                "TERM_PROGRAM" => nothing) do
            Sys.isunix() || return
            @test CesiumLink.push_to_editor(50005, :auto) === nothing
            @test ran() == "--openExternal vscode://disberd.cesiumlink/open/50005"
        end

        # A terminal of a local window names no socket, and the command line that answers there is
        # the desktop one, which knows `--open-url` and not `--openExternal`.
        rm(seen; force = true)
        withenv("PATH" => dir * ":" * get(ENV, "PATH", ""),
                "VSCODE_IPC_HOOK_CLI" => nothing, "TERM_PROGRAM" => "vscode") do
            Sys.isunix() || return
            @test CesiumLink.push_to_editor(50009, :auto) === nothing
            @test ran() == "--open-url vscode://disberd.cesiumlink/open/50009"
        end

        # A terminal of another editor is not one of ours.
        withenv("PATH" => dir * ":" * get(ENV, "PATH", ""),
                "VSCODE_IPC_HOOK_CLI" => nothing, "TERM_PROGRAM" => "Apple_Terminal") do
            @test CesiumLink.push_to_editor(50006, :auto) == "the environment names no VSCode terminal"
        end

        # VSCode's command line on Windows is `code.cmd`, which is a script for the command
        # interpreter: started directly it fails as a program that is not a valid application. The
        # name is checked on every platform, because the machine that meets this is not the one that
        # runs the tests.
        uri = CesiumLink.scene_uri(50008)
        @test CesiumLink.editor_command("C:\\VSCode\\bin\\code.cmd", uri, "--open-url").exec ==
              ["cmd", "/c", "C:\\VSCode\\bin\\code.cmd", "--open-url", uri]
        @test CesiumLink.editor_command("/usr/bin/code", uri, "--open-url").exec ==
              ["/usr/bin/code", "--open-url", uri]
        # The socket is what says which command line answers, and so which option it takes.
        @test withenv(() -> CesiumLink.editor_flag(), "VSCODE_IPC_HOOK_CLI" => "/run/x.sock") ==
              "--openExternal"
        @test withenv(() -> CesiumLink.editor_flag(), "VSCODE_IPC_HOOK_CLI" => nothing) ==
              "--open-url"
        @test CesiumLink.editor_cli_names() ==
              (Sys.iswindows() ? ("code.cmd", "code.exe", "code") : ("code",))

        # Another program named `code`, earlier on PATH, must not take the push. A window reaches
        # its editor through a `remote-cli` directory, and only that program accepts the flag.
        if Sys.isunix()
            editor_dir = joinpath(dir, "remote-cli")
            mkdir(editor_dir)
            editor_seen = joinpath(dir, "editor-seen")
            editor_code = joinpath(editor_dir, "code")
            write(editor_code, "#!/bin/sh\necho \"\$@\" > \"$editor_seen\"\n")
            chmod(editor_code, 0o755)
            rm(seen; force = true)
            withenv("PATH" => join((dir, editor_dir, get(ENV, "PATH", "")), ":"),
                    "VSCODE_IPC_HOOK_CLI" => "/run/user/1000/vscode-ipc.sock",
                    "TERM_PROGRAM" => nothing) do
                @test CesiumLink.push_to_editor(50007, :auto) === nothing
                for _ in 1:200
                    isfile(editor_seen) && break
                    sleep(0.05)
                end
                @test isfile(editor_seen)
                @test strip(read(editor_seen, String)) ==
                      "--openExternal vscode://disberd.cesiumlink/open/50007"
                @test !isfile(seen)
            end
        end
    end

    @test_throws "`open` takes `:auto`, `true` or `false`" start_server(; dist_dir = nothing,
                                                                       open = :yes)
end

@testitem "the discovery directory falls back to a per-user location" begin
    was = get(ENV, "XDG_RUNTIME_DIR", nothing)
    app_was = get(ENV, "LOCALAPPDATA", nothing)
    delete!(ENV, "XDG_RUNTIME_DIR")
    ENV["LOCALAPPDATA"] = joinpath(homedir(), "AppData", "Local")
    try
        # `LOCALAPPDATA` is read on Windows and nowhere else, so this also holds the Unix path to
        # the cache directory while that variable is set.
        @test discovery_dir() == (Sys.iswindows() ?
                                  joinpath(ENV["LOCALAPPDATA"], "cesiumlink") :
                                  joinpath(homedir(), ".cache", "cesiumlink"))
    finally
        was === nothing || (ENV["XDG_RUNTIME_DIR"] = was)
        app_was === nothing ? delete!(ENV, "LOCALAPPDATA") : (ENV["LOCALAPPDATA"] = app_was)
    end
end

@testitem "the declaration carries the lighting flag, and omits it when the globe is evenly lit" setup=[FreePort] begin
    using HTTP, JSON

    # The declaration a server sends on `ready`, as the client reads it.
    function declared(; kw...)
        port = freeport()
        server = start_server(; host = "::1", port, dist_dir = nothing, kw...)
        try
            return HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)["params"]
            end
        finally
            stop_server(server)
        end
    end

    @test !haskey(declared(), "lighting")
    @test declared(; lighting = true)["lighting"] == true
    # The sky around the globe rides the same declaration, and is off by the same default.
    @test !haskey(declared(), "stars")
    @test declared(; stars = true)["stars"] == true
end

@testitem "core/stop stops the server, and no listener can refuse it" setup=[FreePort] begin
    using HTTP, JSON, Sockets

    stop_frame = JSON.json((; method = "event",
        params = Dict("module" => "core", "topic" => "stop", "payload" => Dict())))

    mktempdir() do runtime
        # The real runtime directory belongs to the user's own sessions.
        was = get(ENV, "XDG_RUNTIME_DIR", nothing)
        ENV["XDG_RUNTIME_DIR"] = runtime
        try
            port = freeport()
            server = start_server(; dist_dir = nothing, host = "::1", port)
            listener = server.listener
            file = server.discovery_file
            @test isopen(listener)
            @test isfile(file)

            # A scene must not be able to refuse a stop, so the listener chain never sees the pair.
            refused = Ref(false)
            on_event(server, "core", "stop") do ev, reply
                refused[] = true
            end

            # A second client, connected and holding the socket, to watch it drop.
            dropped = Ref(false)
            @async HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                try
                    HTTP.WebSockets.receive(ws)     # nothing is sent; this ends when the socket goes
                catch
                end
                dropped[] = true
            end
            deadline = time() + 10
            while length(server.clients) < 1 && time() < deadline
                sleep(0.02)
            end
            @test length(server.clients) == 1

            # The stop client sends no `ready`: an `event` needs no handshake.
            try
                HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                    HTTP.WebSockets.send(ws, stop_frame)
                end
            catch
                # The server closes this socket under the client, which is the point.
            end

            deadline = time() + 10
            while server.listener !== nothing && time() < deadline
                sleep(0.02)
            end
            @test server.listener === nothing
            @test !isopen(listener)
            @test !isfile(file)
            @test refused[] == false

            deadline = time() + 10
            while !dropped[] && time() < deadline
                sleep(0.02)
            end
            @test dropped[]

            # The port is free again, so nothing holds it.
            s = Sockets.listen(Sockets.IPv6("::1"), port); close(s)

            # A second stop is a no-op, not an error — on the wire path and under it.
            @test CesiumLink.handle_msg(server, nothing, stop_frame) === nothing
            @test stop_server(server) === server
        finally
            was === nothing ? delete!(ENV, "XDG_RUNTIME_DIR") : (ENV["XDG_RUNTIME_DIR"] = was)
        end
    end
end

@testitem "a module registered while a client is connected is declared to it" setup=[FreePort] begin
    using HTTP, JSON

    # A frame that never comes must fail this test rather than hang it: a server that stops
    # declaring is exactly the regression here, and `receive` waits for as long as the socket lives.
    function next_header(ws; seconds = 10)
        task = @async CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header
        timedwait(() -> istaskdone(task), seconds) === :ok ||
            error("no frame arrived within $seconds s")
        return JSON.parse(fetch(task))
    end

    mktempdir() do dir
        entry = joinpath(dir, "rainfade.js")
        write(entry, "export default {}")
        port = freeport()
        server = start_server(; dist_dir = nothing, host = "::1", port)
        try
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                # A scene registers its modules after its server starts, so a page can be connected
                # by then. Without a second declaration that page never loads the module.
                @test isempty(next_header(ws)["params"]["modules"])
                # Broadcast live, to a viewer that has nothing to route it to and drops it.
                CesiumLink.send_command(server, "rainfade", "state", Dict("x" => 1))
                next_header(ws)
                register_module!(server, :rainfade, entry)
                (next_header(ws), next_header(ws))
            end
            decl, replayed = got
            @test decl["method"] == "modules"
            @test [m["id"] for m in decl["params"]["modules"]] == ["rainfade"]
            # A frame addressed to the module before it was registered reached a viewer with nothing
            # to route it to, so it goes out again behind the declaration.
            @test replayed["method"] == "commands"
            @test only(replayed["params"]["commands"])["module"] == "rainfade"
        finally
            stop_server(server)
        end
    end
end

@testitem "showing a server names the page rather than its fields" begin
    server = start_server(; dist_dir = nothing)
    try
        shown = withenv("VSCODE_IPC_HOOK_CLI" => nothing, "TERM_PROGRAM" => nothing) do
            sprint(show, MIME"text/plain"(), server)
        end
        @test shown == "CesiumLink server at $(viewer_url(server)) (0 clients)"
        # A VSCode terminal gets the URI that opens the tab again, and nothing else does.
        in_editor = withenv("TERM_PROGRAM" => "vscode") do
            sprint(show, MIME"text/plain"(), server)
        end
        @test endswith(in_editor, "\n  VSCode tab: vscode://disberd.cesiumlink/open/$(bound_port(server))")
        @test sprint(show, server) == "Server($(viewer_url(server)))"
    finally
        stop_server(server)
    end
    @test sprint(show, MIME"text/plain"(), server) == "CesiumLink server (stopped)"
    @test sprint(show, server) == "Server(stopped)"
end

@testitem "a client that stops reading drops frames instead of blocking the broadcast" begin
    using CesiumLink: Client, CLIENT_QUEUE, broadcast_all!, commands_message, Command,
                      drain_client!, unpack
    using JSON

    # A connection that writes nothing until it is released: a client that stopped reading, with no
    # socket to stall. `send_frame` is the one thing a client kind has to answer, so a test kind
    # needs this and nothing else.
    struct Held
        go::Base.Event
        got::Vector{Vector{UInt8}}
    end
    CesiumLink.send_frame(c::Held, bytes::Vector{UInt8}) = (wait(c.go); push!(c.got, bytes); nothing)

    # The `n` of the `core/dropped` command among the frames received, or `nothing`.
    function dropped_count(frames)
        for bytes in frames
            for c in get(JSON.parse(unpack(bytes).header)["params"], "commands", ())
                (c["module"], c["topic"]) == ("core", "dropped") && return c["payload"]["n"]
            end
        end
        return nothing
    end

    server = start_server(; dist_dir = nothing)
    try
        conn = Held(Base.Event(), Vector{UInt8}[])
        client = Client(conn)
        lock(server.clients_lock) do; push!(server.clients, client); end
        @async drain_client!(server, client)

        msg = commands_message([Command("test", "topic", (; i = 1))])
        # More frames than the queue holds, at a client that takes none of them. Every broadcast
        # returns: the queue refuses what does not fit rather than waiting for the client.
        queued = [broadcast_all!(server, msg; record = false) for _ in 1:(CLIENT_QUEUE + 8)]
        refused = count(iszero, queued)
        @test refused ≥ 1

        # The lock is free while that client is stuck, which is what a second page's module fetches
        # queue behind.
        @test trylock(server.clients_lock)
        unlock(server.clients_lock)

        # Release the client and let it catch up. The next frame that fits is then preceded by the
        # marker that says what it lost.
        notify(conn.go)
        deadline = time() + 30
        while Base.n_avail(client.out) > 0 && time() < deadline
            sleep(0.05)
        end
        broadcast_all!(server, msg; record = false)
        while dropped_count(copy(conn.got)) === nothing && time() < deadline
            sleep(0.05)
        end
        @test dropped_count(copy(conn.got)) == refused
    finally
        stop_server(server)
    end
end

@testitem "a client that heard about dropped frames is replayed the retained scene" begin
    using CesiumLink: Client, send_command, retained_messages, unpack
    using JSON

    server = start_server(; dist_dir = nothing)
    try
        send_command(server, "test", "colour", Dict("c" => "red"))
        # No drain task and no connection: the frames stay in the queue, which is where this reads
        # what the client was sent.
        client = Client(nothing)
        replay = JSON.json((; method = "event",
                            params = Dict("module" => "core", "topic" => "replay")))
        CesiumLink.handle_msg(server, client, replay)

        @test Base.n_avail(client.out) == length(retained_messages(server))
        sent = JSON.parse(unpack(take!(client.out)).header)
        @test only(sent["params"]["commands"])["payload"]["c"] == "red"
    finally
        stop_server(server)
    end
end
