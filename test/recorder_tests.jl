@testitem "a replay puts a client where the recorded session would have" setup=[DemoWindow, FreePort] begin
    using HTTP, JSON, Sockets

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        entry = joinpath(dir, "thing.js")
        write(entry, "export default {}")

        source = start_server(; dist_dir = nothing, host = "::1", port = freeport())
        try
            register_module!(source, :thing, entry)
            record!(source, path)
            push_window(source, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 60,
                        total_frames = 4)
            send_command(source, "ui", "declare", (; items = ["caption"]))
        finally
            stop_server(source)
        end
        @test length(readlines(path)) == 3          # the header, one window and one command

        port = freeport()
        target = start_server(; dist_dir = nothing, host = "::1", port)
        try
            replay(target, path; speed = 1000)

            # What the recorded session put on a viewer's screen is what a viewer connecting to the
            # replay is sent: the same modules to load, the same scene, the same overlay.
            # Read on a task against a deadline rather than blocking on `receive`, so a frame the
            # replay failed to send is a failure here instead of a hang.
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                frames = Any[]
                @async try
                    for msg in ws
                        push!(frames, JSON.parse(CesiumLink.unpack(msg).header))
                        length(frames) == 3 && break
                    end
                catch
                    # The socket closing under the reader is how this task ends.
                end
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                timedwait(() -> length(frames) == 3, 10.0)
                frames
            end
            @test [m["method"] for m in got] == ["modules", "window", "commands"]
            @test only(got[1]["params"]["modules"])["id"] == "thing"
            @test got[2]["params"]["startFrame"] == 0
            @test haskey(got[2]["params"]["payloads"], "tracks")
            @test only(got[3]["params"]["commands"])["topic"] == "declare"
            # The window's own identity travels with it, so an event resolved against the replayed
            # scene names the window the recording stamped.
            @test got[2]["params"]["window"] == target.window_id == 1
        finally
            stop_server(target)
        end
    end
end

@testitem "a recording started mid-session opens with the scene as it stands" setup=[DemoWindow] begin
    using JSON

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        source = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            push_window(source, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 60,
                        total_frames = 2)
            send_command(source, "ui", "declare", (; items = ["caption"]))
            record!(source, path)
        finally
            stop_server(source)
        end

        # Nothing was broadcast after recording began, so the whole file is the scene that was
        # already standing — a session joined late still replays into something drawable.
        recorded = [JSON.parse(l) for l in readlines(path)[2:end]]
        # `msg` is an inline object, not a JSON string, so `jq '.msg.params'` reads a recording
        # without a `fromjson` first.
        @test [r["msg"]["method"] for r in recorded] == ["window", "commands"]
        @test all(r["t"] == 0 for r in recorded)
        # The window's arrays are in `blobs` beside the header rather than base64 inside it.
        pos = recorded[1]["msg"]["params"]["payloads"]["tracks"]["position"]
        @test sort(collect(keys(pos))) == ["\$wire", "off", "shape"]
        @test !isempty(recorded[1]["blobs"])
    end
end

@testitem "the header carries the scene the session declared" begin
    using JSON

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        server = start_server(; dist_dir = nothing, host = "::1", port = 0,
                              ellipsoid = (a = 1737400.0, b = 1737400.0),
                              imagery = "https://tiles.invalid/{z}/{x}/{y}.png",
                              lighting = true, stars = true)
        try
            declare_furniture(server; timeline = false)
            record!(server, path)
        finally
            stop_server(server)
        end
        header = JSON.parse(readline(path))
        # The standalone player builds its globe from these, so a replay of this session is the
        # session: the same shape, the same basemap, the same sun and the same sky.
        @test header["ellipsoid"] == Dict("a" => 1737400, "b" => 1737400)
        @test header["imagery"]["url"] == "https://tiles.invalid/{z}/{x}/{y}.png"
        @test header["lighting"] == true
        @test header["stars"] == true
        # The furniture is here as well as in the retained command written under it, so the player
        # builds the declared set before it paints rather than flashing the default one first.
        @test header["furniture"]["items"]["timeline"] == false
    end
end

@testitem "a scene that declares nothing states nothing" begin
    using JSON

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        server = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            record!(server, path)
        finally
            stop_server(server)
        end
        header = JSON.parse(readline(path))
        # Absent and `false` are two different declarations, so a default session must state neither:
        # a recorded `imagery` of `false` asks the player for a globe with no base layer at all.
        @test !any(haskey(header, k) for k in ("ellipsoid", "imagery", "lighting", "stars", "furniture"))
    end
end

@testitem "a globe with no base layer is recorded, and a mounted one is not" setup=[Pyramid] begin
    using JSON

    function read_header(server, path)
        record!(server, path)
        stop_recording!(server)
        return JSON.parse(readline(path))
    end

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        server = start_server(; dist_dir = nothing, host = "::1", port = 0, imagery = :none)
        try
            @test read_header(server, path)["imagery"] == false
        finally
            stop_server(server)
        end

        tiles = pyramid(mkpath(joinpath(dir, "tiles")))
        server = start_server(; dist_dir = nothing, host = "::1", port = 0, imagery = tiles)
        try
            # The tiles do not travel with the file, and the declared `assets/imagery/…` answers
            # nothing once this server stops. A recorded URL that 404s draws a bare globe and one
            # console error per tile, so the player is left to draw its bundled Earth texture.
            header = @test_logs (:warn,) match_mode=:any read_header(server, path)
            @test !haskey(header, "imagery")
        finally
            stop_server(server)
        end
    end
end

@testitem "replay honours the clock rather than sending everything at once" setup=[DemoWindow] begin
    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        source = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            record!(source, path)
            push_window(source, demo_payloads(); start_frame = 1, count = 2, dt_seconds = 60,
                        total_frames = 4)
            sleep(0.5)
            push_window(source, demo_payloads(); start_frame = 3, count = 2, dt_seconds = 60,
                        total_frames = 4, mode = :append)
        finally
            stop_server(source)
        end

        target = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            replay(target, path; speed = 1000)          # warm, so the readings below are the pacing
            @test (@elapsed replay(target, path)) > 0.4
            @test (@elapsed replay(target, path; speed = 10)) < 0.4
        finally
            stop_server(target)
        end
    end
end

@testitem "a replayed answer carries no sequence number of its own" setup=[FreePort] begin
    using HTTP, JSON, Sockets

    mktempdir() do dir
        path = joinpath(dir, "session.jsonl")
        source = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            record!(source, path)
            reply = Reply()
            command!(reply, "ui", "tooltip", (; html = "hi"))
            send_reply(source, reply; seq = 7)
        finally
            stop_server(source)
        end
        @test JSON.parse(readlines(path)[2])["msg"]["params"]["seq"] == 7

        port = freeport()
        target = start_server(; dist_dir = nothing, host = "::1", port)
        try
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                frames = Any[]
                @async try
                    for msg in ws
                        push!(frames, JSON.parse(CesiumLink.unpack(msg).header))
                        length(frames) == 2 && break
                    end
                catch
                    # The socket closing under the reader is how this task ends.
                end
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                timedwait(() -> !isempty(frames), 10.0)      # the modules declaration
                replay(target, path; speed = 1000)
                timedwait(() -> length(frames) == 2, 10.0)
                frames
            end
            # A sequence number is an event's, and it belongs to the connection that raised it. The
            # recorded batch answered one there; here it answers nothing, so it names no number for
            # a module to compare its own events against.
            @test [m["method"] for m in got] == ["modules", "commands"]
            @test !haskey(got[2]["params"], "seq")
        finally
            stop_server(target)
        end
    end
end

@testitem "a replay refuses a file that is not a recording it understands" begin
    mktempdir() do dir
        path = joinpath(dir, "notes.jsonl")
        write(path, "{\"recording\":99}\n")
        server = start_server(; dist_dir = nothing, host = "::1", port = 0)
        try
            @test_throws "is not a version 2 recording" replay(server, path)
        finally
            stop_server(server)
        end
    end
end
