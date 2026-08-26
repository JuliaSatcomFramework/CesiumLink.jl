@testitem "a capture is written where the caller asked, and the first answer wins" setup=[Capturing, WsOpen] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            path = joinpath(dir, "shot.png")
            first_png = UInt8[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
            later_png = UInt8[7, 7, 7, 7]
            ws_open("ws://[::1]:$(bound_port(server))/ws") do ws
                @test wait_for_client(server)
                # Every viewer answers one broadcast request. One socket that sends twice arrives in
                # the order two viewers would, so the server must keep the first answer.
                answering = @async begin
                    request = capture_request(ws)
                    answer_capture!(ws, request["token"], first_png)
                    answer_capture!(ws, request["token"], later_png)
                    request
                end
                @test capture_canvas(server, path; scale = 2) == path
                @test read(path) == first_png

                request = fetch(answering)
                @test request["scale"] == 2
                @test request["token"] isa String

                # A capture is one request and not scene state, so the server retains nothing under
                # the pair and a client connecting later is asked for no picture.
                @test CesiumLink.declared(server, "core", "capture") === nothing

                # The answer nobody waited for left the socket alive, so the same viewer answers the
                # next request. The bytes say which answer this file holds.
                again = @async (r = capture_request(ws); answer_capture!(ws, r["token"], later_png))
                @test capture_canvas(server, path) == path
                @test read(path) == later_png
                wait(again)
            end
        end
    finally
        stop_server(server)
    end
end

@testitem "a capture that nobody answers throws, and leaves no request behind" setup=[Capturing, WsOpen] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            path = joinpath(dir, "shot.png")
            ws_open("ws://[::1]:$(bound_port(server))/ws") do ws
                @test wait_for_client(server)
                # This viewer reads the request and says nothing, which is what a browser that
                # crashed on the render does.
                @test_throws "no viewer answered a capture" capture_canvas(server, path;
                                                                          timeout = 0.5)
                @test !isfile(path)
                # The request goes away with the call. One kept entry per timed-out call is a leak
                # that lasts as long as the server.
                @test isempty(server.pending_captures)
            end
        end
    finally
        stop_server(server)
    end
end

@testitem "a viewer that refuses a capture reports its own reason" setup=[Capturing, WsOpen] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            path = joinpath(dir, "shot.png")
            ws_open("ws://[::1]:$(bound_port(server))/ws") do ws
                @test wait_for_client(server)
                answering = @async (r = capture_request(ws); answer_capture!(ws, r["token"], nothing))
                @test_throws "passes the maximum texture size" capture_canvas(server, path;
                                                                             scale = 64)
                wait(answering)
                # A refusal writes no file. A caller that saw the message must not also find bytes.
                @test !isfile(path)
                @test isempty(server.pending_captures)
            end
        end
    finally
        stop_server(server)
    end
end

@testitem "a capture with no viewer says so, and a bad scale is refused at the call" begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        path = joinpath(mktempdir(), "shot.png")
        @test_throws "no viewer received a capture request" capture_canvas(server, path)
        @test_throws "`scale`" capture_canvas(server, path; scale = 0)
        @test_throws "`timeout`" capture_canvas(server, path; timeout = 0)
        # `Inf` passes a test for a number above zero. The guard states the argument it refuses,
        # and JSON, which writes no infinity, would report the shape of the payload instead.
        @test_throws "`scale`" capture_canvas(server, path; scale = Inf)
        @test_throws "`timeout`" capture_canvas(server, path; timeout = Inf)
    finally
        stop_server(server)
    end
end

@testitem "a capture of zero bytes throws, and writes no file" setup=[Capturing, WsOpen] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            path = joinpath(dir, "shot.png")
            ws_open("ws://[::1]:$(bound_port(server))/ws") do ws
                @test wait_for_client(server)
                # A browser answers a canvas it cannot encode with a picture of zero bytes and no
                # error. A file of zero bytes reads as a capture that worked, so the call refuses.
                answering = @async begin
                    request = capture_request(ws)
                    answer_capture!(ws, request["token"], UInt8[])
                end
                @test_throws "empty picture" capture_canvas(server, path)
                wait(answering)
                @test !isfile(path)
                @test isempty(server.pending_captures)
            end
        end
    finally
        stop_server(server)
    end
end

@testitem "a recording holds no capture" begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            session = joinpath(dir, "session.jsonl")
            record!(server, session)
            shot = joinpath(dir, "shot.png")
            @test_throws "no viewer received a capture request" capture_canvas(server, shot)
            stop_recording!(server)
            # The header alone. A recorded request would ask a viewer that has no server behind it
            # for a picture that reaches nobody.
            @test length(readlines(session)) == 1
        end
    finally
        stop_server(server)
    end
end

@testitem "the capture button is furniture, and a session declares it on" setup=[Furnished] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        # Off by default, so no scene grows a button it did not ask for.
        declare_furniture(server)
        @test declared(server, "core", "furniture")["items"]["canvasCapture"] == false

        declare_furniture(server; canvas_capture = true)
        @test declared(server, "core", "furniture")["items"]["canvasCapture"] == true
    finally
        stop_server(server)
    end
end

@testitem "a picture beats a refusal that arrived first" setup=[Capturing, WsOpen] begin
    server = start_server(; dist_dir = nothing, host = "::1", port = 0)
    try
        mktempdir() do dir
            path = joinpath(dir, "shot.png")
            png = UInt8[0x89, 0x50, 0x4e, 0x47, 9, 9]
            url = "ws://[::1]:$(bound_port(server))/ws"
            # Two viewers, and the one that refuses answers first. A viewer that refuses returns
            # before the resize, the render and the encode, so it always answers sooner than a
            # viewer that draws. The picture must still win.
            ws_open(url) do refuser
                ws_open(url) do drawer
                    @test timedwait(() -> length(server.clients) == 2, 10.0) === :ok
                    refusing = @async begin
                        request = capture_request(refuser)
                        answer_capture!(refuser, request["token"], nothing)
                    end
                    drawing = @async begin
                        request = capture_request(drawer)
                        wait(refusing)
                        answer_capture!(drawer, request["token"], png)
                    end
                    @test capture_canvas(server, path) == path
                    @test read(path) == png
                    wait(drawing)
                end
            end
        end
    finally
        stop_server(server)
    end
end
