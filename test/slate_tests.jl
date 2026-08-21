# The Slate host, without a notebook and without a browser. `setup=[SlateCell]` stands in for the
# notebook; the rest of the path is the real thing. The browser half of this host is covered by
# `lib/slate/transport.test.mjs`, which the npm suite runs.

@testitem "a cell that shows a server draws it one time" setup=[SlateCell] begin
    slate = FakeSlate()
    server = start_server()
    try
        first = render_in(slate, server, "cell-a")
        # The render repeats: Slate answers `showable` outside the display that follows, and a cell
        # can show one server more than one time. Each render must give the same viewer.
        second = render_in(slate, server, "cell-a")
        @test first isa AbstractDict
        @test first == second
        @test length(slate.handlers) == 1

        channel = only(keys(slate.handlers))
        @test endswith(channel, "/up")
        # The channel must name the process. A page mounts an output only when its bytes are
        # different from the bytes that it holds, so a worker that restarts must render a different
        # channel. If not, the cell keeps a viewer that speaks to a process that stopped.
        @test occursin("cesiumlink/$(getpid())/", channel)
    finally
        stop_server(server)
    end
end

@testitem "a second cell is refused, and the refusal names the cell that draws the server" setup=[SlateCell] begin
    slate = FakeSlate()
    server = start_server()
    try
        render_in(slate, server, "cell-a")
        refusal = render_in(slate, server, "cell-b")
        # Slate keeps one handler for each channel, so a second viewer takes the frames of the first
        # and stops it with no message. The refusal is that message.
        @test !(refusal isa AbstractDict)
        @test occursin("cell-a", string(refusal))
        @test length(slate.handlers) == 1
    finally
        stop_server(server)
    end
end

@testitem "a module registered after the render gets its route" setup=[SlateCell] begin
    slate = FakeSlate()
    server = start_server()
    try
        render_in(slate, server, "cell-a")
        @test !haskey(asset_routes(), "CesiumLink-module-route_late")

        # `register_module!` declares the module to the clients that are already connected. The page
        # then imports it from its own route, so the route must exist before that frame leaves.
        register_module!(server, :route_late, fake_module("late.js"))
        timedwait(() -> !isempty(slate.emitted), 10.0)
        @test !isempty(slate.emitted)
        @test haskey(asset_routes(), "CesiumLink-module-route_late")
    finally
        stop_server(server)
        # A route stays for the life of the process, and the test items share one. This item asserts
        # that its own route is absent before it registers it, so it must take the route back out.
        delete!(asset_routes(), "CesiumLink-module-route_late")
    end
end

@testitem "a send that fails costs the client, and the next render opens a new channel" setup=[SlateCell] begin
    slate = FakeSlate()
    server = start_server()
    try
        render_in(slate, server, "cell-a")
        dead = only(keys(slate.handlers))

        slate.fail[] = true
        register_module!(server, :evict_late, fake_module("late.js"))
        # The drain task returns when a send throws. It must also forget the client, or a later
        # render finds a client whose queue is closed, and the viewer then stays empty.
        timedwait(() -> isempty(server.clients), 10.0)
        @test isempty(server.clients)

        slate.fail[] = false
        render_in(slate, server, "cell-a")
        @test length(server.clients) == 1
        @test length(setdiff(keys(slate.handlers), [dead])) == 1
    finally
        stop_server(server)
        delete!(asset_routes(), "CesiumLink-module-evict_late")
    end
end

@testitem "the teardown of the cell drops the client and frees the channel" setup=[SlateCell] begin
    slate = FakeSlate()
    server = start_server()
    try
        render_in(slate, server, "cell-a")
        @test length(server.clients) == 1
        @test !isempty(slate.cleanups)

        foreach(f -> f(), slate.cleanups)
        @test isempty(server.clients)
        @test isempty(slate.handlers)

        # The claim goes with the client, so another cell can draw this server now.
        again = render_in(slate, server, "cell-b")
        @test again isa AbstractDict
    finally
        stop_server(server)
    end
end

@testitem "a server started in a cell opens no port" setup=[SlateCell] begin
    slate = FakeSlate()
    # Slate sets the context for the whole cell eval, and `start_server` runs in that eval.
    server = task_local_storage(() -> start_server(), :slate_ctx, slate_ctx(slate))
    try
        @test server.listener === nothing
        # No port means no page, so nothing may offer one: no URL, no port and no discovery file.
        @test server.discovery_file === nothing
        @test_throws "this server is not listening" viewer_url(server)
        @test_throws "this server is not listening" CesiumLink.bound_port(server)
        @test occursin("not listening", sprint(show, server))
        # The cell draws the scene all the same, on the socket the notebook already holds.
        @test render_in(slate, server, "cell-a") isa AbstractDict
    finally
        stop_server(server)
    end
end

@testitem "a cell that asks for a port gets one" setup=[SlateCell] begin
    slate = FakeSlate()
    server = task_local_storage(() -> start_server(; listen = true), :slate_ctx, slate_ctx(slate))
    try
        @test server.listener !== nothing
        @test CesiumLink.bound_port(server) > 0
    finally
        stop_server(server)
    end
end
