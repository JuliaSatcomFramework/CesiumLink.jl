@testitem "a camera track is one declared set, and an empty call clears it" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_camera(server,
                       Viewpoint(; lon = 12.5, lat = 41.9, height = 8_000_000),
                       Viewpoint(; west = -10, south = 35, east = 30, north = 60, after = 4))
        @test length(declared(server, "core", "camera")["track"]) == 2

        # The second call replaces the first, and a call with no viewpoint clears the track.
        declare_camera(server, Viewpoint(; lon = 0, lat = 0))
        @test length(declared(server, "core", "camera")["track"]) == 1
        declare_camera(server)
        @test declared(server, "core", "camera") == Dict("track" => [])

        # One command per `(module, topic)` is retained, whatever the length of the track. Reading
        # it back through `declared` is what states that: the call asks for `only` one command.
        @test declared(server, "core", "camera") !== nothing
    finally
        stop_server(server)
    end
end

@testitem "the retained frame carries the whole declared viewpoint" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_camera(server, Viewpoint(; lon = 12.5, lat = 41.9, height = 2_000_000,
                                         heading = 30, pitch = -60, duration = 6, take = true))
        v = only(declared(server, "core", "camera")["track"])
        @test v["destination"] == Dict("lon" => 12.5, "lat" => 41.9, "height" => 2_000_000)
        # An angle the author leaves out is left off the wire, so Cesium chooses it.
        @test v["orientation"] == Dict("heading" => 30, "pitch" => -60)
        @test v["duration"] == 6
        @test v["take"] == true

        declare_camera(server, Viewpoint(; west = -10, south = 35, east = 30, north = 60))
        r = only(declared(server, "core", "camera")["track"])
        @test r["destination"] == Dict("west" => -10, "south" => 35, "east" => 30, "north" => 60)
        # Nothing beyond the destination is stated, so nothing else travels.
        @test collect(keys(r)) == ["destination"]
    finally
        stop_server(server)
    end
end

@testitem "a stated label travels and an absent one does not" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_camera(server,
                       Viewpoint(; lon = 12.5, lat = 41.9, height = 3_200_000, at = 9,
                                 label = "Rome meridian"),
                       Viewpoint(; lon = -74, lat = 41, height = 3_200_000, at = 20))
        track = declared(server, "core", "camera")["track"]
        @test track[1]["label"] == "Rome meridian"
        # The stop list falls back to the schedule, so an unlabelled stop carries no empty field.
        @test !haskey(track[2], "label")
    finally
        stop_server(server)
    end
end

@testitem "an at index leaves Julia 1-based and arrives 0-based" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_camera(server, Viewpoint(; lon = 0, lat = 0, at = 1),
                       Viewpoint(; lon = 0, lat = 0, at = 60))
        track = declared(server, "core", "camera")["track"]
        @test [v["at"] for v in track] == [0, 59]
        # `after` is seconds and not an index, so it crosses unchanged.
        declare_camera(server, Viewpoint(; lon = 0, lat = 0, after = 1.5))
        @test only(declared(server, "core", "camera")["track"])["after"] == 1.5
    finally
        stop_server(server)
    end
end

@testitem "a viewpoint the viewer could only warn about is refused at the call site" begin
    using CesiumLink

    # One destination, and one schedule.
    @test_throws "takes one destination" Viewpoint(; duration = 3)
    @test_throws "takes one destination" Viewpoint(; lon = 1, lat = 2, west = -10)
    @test_throws "takes both `lon` and `lat`" Viewpoint(; lon = 1)
    @test_throws "takes all of `west`" Viewpoint(; west = -10, south = 35)
    @test_throws "`at` or `after`, not both" Viewpoint(; lon = 1, lat = 2, at = 3, after = 4)

    # A keyframe index is a 1-based integer here; a fractional one is dropped by the viewer.
    @test_throws "integer ≥ 1" Viewpoint(; lon = 1, lat = 2, at = 0)
    @test_throws "integer ≥ 1" Viewpoint(; lon = 1, lat = 2, at = 2.5)
    @test_throws "number ≥ 0" Viewpoint(; lon = 1, lat = 2, after = -1)

    # A label the viewer could only drop with a console warning.
    @test_throws "takes a string" Viewpoint(; lon = 1, lat = 2, label = 42)

    # `declare_camera` states a whole track of viewpoints and nothing else.
    server = start_server(; host = "::1", port = 0)
    try
        @test_throws MethodError declare_camera(server, (; lon = 1, lat = 2))
    finally
        stop_server(server)
    end
end

@testitem "the camera-follow indicator is furniture, declared with the rest" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_furniture(server)
        @test declared(server, "core", "furniture")["items"]["cameraFollow"] == true

        # Display only: the declaration says nothing about who holds the camera.
        declare_furniture(server; camera_follow = false)
        @test declared(server, "core", "furniture")["items"]["cameraFollow"] == false
    finally
        stop_server(server)
    end
end

@testitem "a viewpoint that rides something carries the ride and the seat apart" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_camera(server, Viewpoint(; follow = "sat[7]", range = 400_000, heading = 20,
                                         pitch = -30, duration = 4, at = 9, label = "Riding sat 7"))
        v = only(declared(server, "core", "camera")["track"])
        # What to ride is a module and a name that module spells for itself; the seat sits beside it
        # on the viewpoint, which is where the viewer reads `range` and `orientation` from.
        @test v["follow"] == Dict("module" => "primitives", "target" => "sat[7]")
        @test v["range"] == 400_000
        @test v["orientation"] == Dict("heading" => 20, "pitch" => -30)
        @test v["duration"] == 4
        @test !haskey(v, "destination")
        # A ride is scheduled like any other stop, and an index still arrives 0-based.
        @test v["at"] == 8
        @test v["label"] == "Riding sat 7"

        # A bare name means the module a scene of `Nodes`, `Edges` and `Areas` draws through.
        declare_camera(server, Viewpoint(; follow = "models" => "cone[3]"))
        r = only(declared(server, "core", "camera")["track"])
        @test r["follow"] == Dict("module" => "models", "target" => "cone[3]")
        # Nothing beyond the ride is stated, so nothing else travels.
        @test collect(keys(r)) == ["follow"]
    finally
        stop_server(server)
    end
end

@testitem "a ride goes out on the wire and never displaces the declared track" setup=[Furnished, FreePort] begin
    using HTTP, JSON

    # One `commands` frame carrying a `core/camera` payload with a `follow` statement in it. The
    # replay a joining client gets comes first and carries the track, so the read skips past it.
    function ride(ws)
        while true
            m = JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            m["method"] == "commands" || continue
            c = only(m["params"]["commands"])
            c["module"] == "core" && c["topic"] == "camera" && haskey(c["payload"], "follow") &&
                return c["payload"]
        end
    end

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        declare_camera(server, Viewpoint(; lon = 12.5, lat = 41.9, at = 4))

        got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)                       # the `modules` declaration
            # The seat travels inside `follow` here and beside it on a viewpoint: this statement is
            # the whole request, where a viewpoint is a stop that carries one.
            declare_follow(server, "sat[7]"; range = 400_000, pitch = -30, duration = 3)
            riding = ride(ws)
            # Getting off is an explicit null, because the viewer reads the key's presence as the
            # statement. A dropped key would leave the camera riding.
            declare_follow(server)
            (riding, ride(ws))
        end
        @test got[1]["follow"] == Dict("module" => "primitives", "target" => "sat[7]",
                                       "range" => 400_000, "duration" => 3,
                                       "orientation" => Dict("pitch" => -30))
        @test !haskey(got[1], "track")
        @test got[2] == Dict("follow" => nothing)

        # The server retains one command per topic, so a retained ride would take the tour's place.
        # The track a scene declared is what a client connecting now is still replayed.
        @test length(declared(server, "core", "camera")["track"]) == 1
        @test only(declared(server, "core", "camera")["track"])["at"] == 3

        # Naming nothing to ride while stating a seat is a clear that reads like an adjustment.
        @test_throws "takes nothing else" declare_follow(server; range = 400_000)
    finally
        stop_server(server)
    end
end

@testitem "a ride the viewer could only warn about is refused at the call site" begin
    using CesiumLink

    # Three destination forms, and one of them per viewpoint.
    @test_throws "takes one destination" Viewpoint(; follow = "sat[7]", lon = 1, lat = 2)
    @test_throws "takes one destination" Viewpoint(; follow = "sat[7]", west = -10)
    # `range` is metres from the thing ridden, so it means nothing over a fixed destination.
    @test_throws "takes `follow` as well" Viewpoint(; lon = 1, lat = 2, range = 400_000)
    @test_throws "takes `follow` as well" Viewpoint(; west = -10, south = 35, east = 30,
                                                    north = 60, range = 400_000)
    # There is no roll around a moving thing: the viewer reads heading, pitch and range only.
    @test_throws "`roll` has nothing to mean" Viewpoint(; follow = "sat[7]", roll = 10)
    # A name is a string, or a module paired with one.
    @test_throws "othermodule" Viewpoint(; follow = 7)
    @test_throws "othermodule" Viewpoint(; follow = :sat => "sat[7]")

    # What travels is what the seat needs and nothing else.
    @test Viewpoint(; follow = "sat[7]", heading = 20).wire.orientation == (; heading = 20)
    @test Viewpoint(; follow = "sat[7]").wire ==
          (; follow = NamedTuple{(:module, :target)}(("primitives", "sat[7]")))
end
