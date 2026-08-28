@testitem "the default furniture set is the whole set, in the wire's spelling" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_furniture(server)
        p = declared(server, "core", "furniture")

        # These defaults mirror the viewer's own table; the viewer owns them.
        @test p["items"] == Dict("timeline" => true, "animation" => true, "keyframe" => true,
                                 "cameraFollow" => true, "sceneMode" => true, "fullscreen" => true,
                                 "home" => true, "projection" => false, "basemap" => true,
                                 "navHelp" => false, "inspector" => false,
                                 "canvasCapture" => false)
        @test p["region"] == "top-right"
        # An empty style is left off the wire entirely.
        @test !haskey(p, "style")
    finally
        stop_server(server)
    end
end

@testitem "a furniture declaration is a whole statement, not a patch" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        # A named item that is `false` still ships: the payload is the whole set, never a subset.
        declare_furniture(server; timeline = false, inspector = true, nav_help = true)
        p = declared(server, "core", "furniture")
        @test p["items"]["timeline"] == false
        @test p["items"]["inspector"] == true
        @test length(p["items"]) == 12

        # The second call carries the second call's values and nothing carried over from the first,
        # so an item this call does not name is back at its default.
        declare_furniture(server; scene_mode = false)
        p2 = declared(server, "core", "furniture")
        @test p2["items"]["timeline"] == true
        @test p2["items"]["inspector"] == false
        @test p2["items"]["navHelp"] == false
        @test p2["items"]["sceneMode"] == false

        # The basemap picker is on by default. This flag is the one thing that turns it off
        # from Julia. Below two declared basemaps the viewer hides the picker anyway. A session
        # that declares a set and wants no picker over it has nowhere else to say so.
        declare_furniture(server; basemap = false)
        @test declared(server, "core", "furniture")["items"]["basemap"] == false
    finally
        stop_server(server)
    end
end

@testitem "furniture takes a region and a style, and refuses a region that is not one" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_furniture(server; region = :bottom_right, style = (; flex_direction = "row"))
        p = declared(server, "core", "furniture")
        @test p["region"] == "bottom-right"
        # `_` lowers to `-`, so the Julia keyword stays idiomatic and the wire stays CSS.
        @test p["style"] == Dict("flex-direction" => "row")

        @test_throws "an overlay region is" declare_furniture(server; region = :nonsense)
    finally
        stop_server(server)
    end
end

@testitem "a region declaration carries the whole set of styled regions" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_regions(server, Dict(:top_right => (; flex_direction = "column"),
                                     :top_left => (; max_width = "40%")))
        @test declared(server, "core", "regions") == Dict("top-right" => Dict("flex-direction" => "column"),
                                                  "top-left" => Dict("max-width" => "40%"))

        # A region absent from the declaration returns to its Core default.
        declare_regions(server, Dict(:top_left => (; max_width = "20%")))
        p = declared(server, "core", "regions")
        @test collect(keys(p)) == ["top-left"]

        # Which properties a region may set is the viewer's rule, and it is stated once, there.
        declare_regions(server, Dict(:top_left => (; top = "10px")))
        @test declared(server, "core", "regions")["top-left"] == Dict("top" => "10px")

        @test_throws "an overlay region is" declare_regions(server, Dict(:middle => (;)))
    finally
        stop_server(server)
    end
end

@testitem "the declared furniture reaches the client on the session declaration" setup=[Furnished, WsOpen] begin
    using HTTP, JSON

    # What the first message a client receives carries under `params`.
    function declaration(server)
        ws_open("ws://[::1]:$(CesiumLink.bound_port(server))/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)["params"]
        end
    end

    server = start_server(; host = "::1", port = 0)
    try
        # A session that declares no furniture leaves the field off the wire, so the viewer builds
        # its own default set. A recording made before the field existed reads the same way.
        @test !haskey(declaration(server), "furniture")

        # The viewer builds its first set out of this, so a scene with no time to show has to state
        # the band on the message the widget is built from, not on a command that follows it.
        declare_furniture(server; timeline = false, animation = false, keyframe = false)
        p = declaration(server)["furniture"]
        @test p["items"]["timeline"] == false
        @test p["items"]["animation"] == false
        @test p["items"]["home"] == true
        @test p["region"] == "top-right"

        # The declaration says what the retained command says, so the replay that follows it restates
        # the set rather than changing it.
        declare_furniture(server; region = :bottom_right, style = (; gap = "4px"))
        @test declaration(server)["furniture"] == declared(server, "core", "furniture")
    finally
        stop_server(server)
    end
end
