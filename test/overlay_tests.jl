@testitem "the overlay list lowers to what the ui module reads" begin
    using JSON

    items = [Title("Visibility demo"; region = :top_left),
             Legend("Throughput [Gbps]", 0, 12, ["#440154", "#fde725"]; region = :top_right),
             Toggle(:isl, "ISL links", true),
             Select(:cells, "Cells", :served, [:all => "All", :served => "Served"])]
    o = JSON.parse(JSON.json(items))

    @test [r["kind"] for r in o] == ["title", "legend", "toggle", "select"]
    # The region travels in the wire's own spelling, so the viewer needs no table to read it.
    @test [r["region"] for r in o] == ["top-left", "top-right", "bottom-right", "bottom-right"]

    @test o[1]["text"] == "Visibility demo"
    @test o[2]["stops"] == [[0.0, "#440154"], [1.0, "#fde725"]]
    @test o[2]["min"] == 0.0 && o[2]["max"] == 12.0
    @test o[3]["id"] == "isl" && o[3]["value"]
    @test o[4]["value"] == "served"
    @test o[4]["options"] == [Dict("value" => "all", "label" => "All"),
                              Dict("value" => "served", "label" => "Served")]
end

@testitem "a per-keyframe title is declared 1-based and travels 0-based" begin
    using JSON

    o = JSON.parse(JSON.json(Title(Dict(1 => "first", 240 => "last"))))
    @test o["kind"] == "title"
    @test o["region"] == "top-center"
    @test o["frames"] == Dict("0" => "first", "239" => "last")
    @test !haskey(o, "text")

    @test_throws "1-based absolute indices" Title(Dict(0 => "zeroth"))
    @test_throws "either one string or a keyframe-keyed mapping" Title(nothing, nothing, :top_left)
end

@testitem "a control that would contradict its own scene is refused" begin
    # A declaration recording a value it does not describe is the contradiction the design removes:
    # the widget would show one state while the scene is filtered by another.
    @test_throws "is not one of its options" Select(:cells, "Cells", :none, [:all => "All"])
    @test_throws "at least one option" Select(:cells, "Cells", :all, Pair{Symbol,String}[])
    @test_throws "value is a Bool" Toggle(:isl, "ISL links", "yes")
    @test_throws "an overlay region is" Title("x"; region = :middle)
    # An exact-typed call must not bypass the inner constructor either.
    @test_throws "an overlay region is" Toggle(:isl, "ISL links", true, :middle)
end

@testitem "a group carries its controls, and a style lowers to CSS the viewer can set" begin
    using JSON

    g = Group([Legend("Sat Throughput (Gbps)", 0, 12, ["#440154", "#fde725"]),
               Legend("Cell Satisfaction", 0, 1, ["#000000", "#ffffff"])];
              region = :top_left, style = (; flex_direction = "row"))
    o = JSON.parse(JSON.json(g))

    @test o["kind"] == "group"
    @test o["region"] == "top-left"
    # `_` lowers to `-`, so the Julia keyword stays idiomatic and the wire stays CSS.
    @test o["style"] == Dict("flex-direction" => "row")
    @test [c["kind"] for c in o["controls"]] == ["legend", "legend"]
    @test o["controls"][1]["title"] == "Sat Throughput (Gbps)"

    # A style is optional everywhere, and an empty one is left off the wire entirely.
    @test !haskey(JSON.parse(JSON.json(Toggle(:isl, "ISLs", true))), "style")
    t = JSON.parse(JSON.json(Toggle(:isl, "ISLs", true; style = Dict(:font_size => "16px"))))
    @test t["style"] == Dict("font-size" => "16px")

    @test_throws "at least one control" Group(CesiumLink.AbstractControl[])
    @test_throws "does not nest" Group([Group([Toggle(:isl, "ISLs", true)])])
    @test_throws "an overlay region is" Group([Toggle(:isl, "ISLs", true)], :middle)
end

@testitem "a legend samples the colormap it was given" begin
    using CesiumLink: legend_stops

    # A vector of colours spreads evenly and keeps its own stops exactly.
    @test legend_stops(["#000000", "#ffffff"]) == [(0.0, "#000000"), (1.0, "#ffffff")]
    # Placed stops are taken as written, and alpha travels when the colour is not opaque.
    @test legend_stops([0.25 => "#ff000080"]) == [(0.25, "#ff000080")]

    # Anything supporting `get(cmap, t)` is sampled, so a ColorSchemes.jl scheme works unchanged.
    struct Ramp end
    Base.get(::Ramp, t::Real) = (round(Int, 255t), 0, 0)
    stops = legend_stops(Ramp())
    @test first(stops) == (0.0, "#000000")
    @test last(stops) == (1.0, "#ff0000")
    @test issorted(first.(stops))
end

@testitem "the overlay declaration reaches the ui module and survives a reconnect" setup=[FreePort, WsOpen] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        declare_overlay(server, [Title("Visibility demo"), Toggle(:isl, "ISL links", true)])
        got = ws_open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)                       # the `modules` declaration, discarded
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header               # the replayed overlay
        end
        m = JSON.parse(got)
        @test m["method"] == "commands"
        c = only(m["params"]["commands"])
        @test c["module"] == "ui"
        @test c["topic"] == "declare"
        @test [r["kind"] for r in c["payload"]] == ["title", "toggle"]
    finally
        stop_server(server)
    end
end

@testitem "a control event is an ordinary listener on the ui module's topic" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        seen = []
        on_event(server, "ui", "control") do ev, reply
            push!(seen, (ev.payload.id, ev.payload.value, ev.frame))
        end
        dispatch_event(server, Dict("module" => "ui", "topic" => "control", "seq" => 7,
                                    "frame" => 16, "window" => 2,
                                    "payload" => Dict("id" => "isl", "value" => false)))
        # The wire is 0-based and the Julia API 1-based, frame included.
        @test only(seen) == ("isl", false, 17)
    finally
        stop_server(server)
    end
end

@testitem "a float lowers to the box the ui module draws, anchor and all" begin
    using JSON

    floats = [Floating(:pin; anchor = Screen(320, 180), html = "<b>Sat 12</b>"),
              Floating(:follow; anchor = Entity(:primitives, :sat, 12), html = "<b>12</b>",
                       closable = false, style = (; max_width = "200px")),
              Floating(:ground; anchor = World(12.5, 41.9), html = "<b>Rome</b>",
                       keyframed = ())]
    o = JSON.parse(JSON.json(floats))

    @test [f["id"] for f in o] == ["pin", "follow", "ground"]
    @test o[1]["anchor"] == Dict("anchor" => "screen", "x" => 320.0, "y" => 180.0)
    # The wire is 0-based and the Julia API 1-based, entity indices included.
    @test o[2]["anchor"] == Dict("anchor" => "entity", "module" => "primitives",
                                 "kind" => "sat", "idx" => 11)
    @test o[3]["anchor"] == Dict("anchor" => "world", "lon" => 12.5, "lat" => 41.9,
                                 "height" => 0.0)

    # An html float keyframes its content by default; a float saying otherwise leaves the opt-in off
    # the wire entirely, as an empty style is left off.
    @test o[1]["keyframed"] == ["html"] && o[1]["closable"]
    @test !haskey(o[3], "keyframed")
    @test !o[2]["closable"] && o[2]["style"] == Dict("max-width" => "200px")
    @test !haskey(o[1], "style") && !haskey(o[1], "mount")

    # A box the user may not move says nothing about it; one they may says so and nothing else,
    # since a drag comes back as an anchor and a resize as a style.
    @test !any(haskey(f, "adjustable") for f in o)
    @test JSON.parse(JSON.json(Floating(:pin; anchor = Screen(320, 180), html = "<b>Sat 12</b>",
                                        adjustable = true)))["adjustable"]
end

@testitem "a mounted float names its module and carries no html" begin
    using JSON

    o = JSON.parse(JSON.json(Floating(:load; anchor = Screen(20, 20), mount = :charts)))
    @test o["mount"] == "charts"
    @test !haskey(o, "html")
    # A mounted module takes its per-keyframe data from the window addressed to it, so there is
    # nothing here for a track to supply.
    @test !haskey(o, "keyframed")
end

@testitem "a float that could not be drawn or addressed is refused" begin
    @test_throws "either html or a mounted module" Floating(:x; anchor = Screen(0, 0))
    @test_throws "either html or a mounted module" Floating(:x; anchor = Screen(0, 0),
                                                            html = "<b>x</b>", mount = :charts)
    @test_throws "only keyframed field is html" Floating(:x; anchor = Screen(0, 0),
                                                         html = "<b>x</b>", keyframed = (:style,))
    @test_throws "takes no keyframed field here" Floating(:x; anchor = Screen(0, 0),
                                                         mount = :charts, keyframed = (:html,))
    @test_throws "1-based" Entity(:primitives, :sat, 0)
end

@testitem "the float set reaches the ui module and survives a reconnect" setup=[FreePort, WsOpen] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        declare_floating(server, [Floating(:pin; anchor = Screen(10, 20), html = "<b>pinned</b>")])
        got = ws_open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)                       # the `modules` declaration, discarded
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header               # the replayed float set
        end
        c = only(JSON.parse(got)["params"]["commands"])
        @test c["module"] == "ui" && c["topic"] == "floating"
        @test only(c["payload"])["html"] == "<b>pinned</b>"
    finally
        stop_server(server)
    end
end

@testitem "a reported rect re-anchors its float and rides its style, without a new declaration" begin
    using CesiumLink: dispatch_event, declared

    server = start_server(; host = "::1", port = 0)
    try
        floats() = declared(server, "ui", "floating")

        declare_floating(server, [
            Floating(:pin; anchor = Entity(:primitives, :sat, 12), html = "<b>12</b>",
                     adjustable = true, style = (; background = "black")),
            Floating(:other; anchor = Screen(10, 20), html = "<b>x</b>")])
        @test floats()[1]["anchor"]["anchor"] == "entity"

        dispatch_event(server, Dict("module" => "ui", "topic" => "rect",
                                    "payload" => Dict("id" => "pin", "x" => 120, "y" => 60,
                                                      "w" => 360, "h" => 240)))
        # The set is re-sent on the event alone, so what the server retains for a client connecting
        # later is where the user left the box rather than where the scene last declared it.
        pin = floats()[1]
        @test pin["anchor"] == Dict("anchor" => "screen", "x" => 120.0, "y" => 60.0)
        # The size merges into the author's own style instead of replacing it.
        @test pin["style"] == Dict("background" => "black", "width" => "360px",
                                   "height" => "240px")
        # A float the user has not touched is declared exactly as the scene wrote it.
        @test floats()[2]["anchor"] == Dict("anchor" => "screen", "x" => 10.0, "y" => 20.0)
        @test !haskey(floats()[2], "style")
    finally
        stop_server(server)
    end
end

@testitem "a rect is forgotten when a declaration drops its float, and when the scene is replaced" begin
    using CesiumLink: dispatch_event, declared

    server = start_server(; host = "::1", port = 0)
    try
        floats() = declared(server, "ui", "floating")
        # The two flags differ, so the stamp cannot swap them and still pass.
        pin() = Floating(:pin; anchor = Screen(10, 20), html = "<b>12</b>",
                         adjustable = true, closable = false)
        drag() = dispatch_event(server, Dict("module" => "ui", "topic" => "rect",
                                             "payload" => Dict("id" => "pin", "x" => 120,
                                                               "y" => 60, "w" => 360, "h" => 240)))

        declare_floating(server, [pin()])
        drag()
        @test floats()[1]["anchor"]["x"] == 120.0
        # The two flags travel independently: a box the user may move is not thereby one they may
        # close.
        @test floats()[1]["adjustable"] && !floats()[1]["closable"]

        # Dropping a float and declaring it again is how a scene puts the box back.
        declare_floating(server, [])
        declare_floating(server, [pin()])
        @test floats()[1]["anchor"]["x"] == 10.0
        @test !haskey(floats()[1], "style")

        # Replacing the scene forgets every rect: the next scene may name a box the same thing.
        drag()
        @test floats()[1]["anchor"]["x"] == 120.0
        install_scene!(server, nothing, [])
        declare_floating(server, [pin()])
        @test floats()[1]["anchor"]["x"] == 10.0
    finally
        stop_server(server)
    end
end

@testitem "the built-in rect listener leaves a scene's own listener on that topic reachable" begin
    using CesiumLink: dispatch_event, declared

    server = start_server(; host = "::1", port = 0)
    try
        # The server registers its own rect listener when it starts, ahead of anything a scene adds.
        @test [(l.module_id, l.topic) for l in server.listeners] == [("ui", "rect")]

        seen = String[]
        on_event(server, "ui", "rect") do ev, reply
            push!(seen, ev.payload.id)
        end
        dispatch_event(server, Dict("module" => "ui", "topic" => "rect",
                                    "payload" => Dict("id" => "pin", "x" => 1, "y" => 2,
                                                      "w" => 80, "h" => 48)))
        @test only(seen) == "pin"
        @test server.float_rects["pin"] == (; x = 1.0, y = 2.0, w = 80, h = 48)
        # With nothing declared there is nothing to stamp, and declaring the empty set here would
        # take every box off the screen.
        @test declared(server, "ui", "floating") === nothing
    finally
        stop_server(server)
    end
end

@testitem "closing a float is an ordinary listener on the ui module's topic" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        closed, controlled = String[], String[]
        on_event(server, "ui", "close") do ev, reply
            push!(closed, ev.payload.id)
        end
        # The same module's other topic, to show that closing a float is routed as its own event
        # rather than reaching whatever else listens to `ui`.
        on_event(server, "ui", "control") do ev, reply
            push!(controlled, ev.payload.id)
        end
        dispatch_event(server, Dict("module" => "ui", "topic" => "close",
                                    "payload" => Dict("id" => "pin")))
        @test only(closed) == "pin"
        @test isempty(controlled)
    finally
        stop_server(server)
    end
end

@testitem "the five-argument Legend says so when it is handed a colormap" begin
    # `Float64('#')` is 35.0 rather than an error, so destructuring a colormap here used to surface
    # one call later as `MethodError: no method matching String(::Char)` — naming no legend, no
    # colormap and no argument position.
    @test_throws "not a colormap" Legend("t", 0, 12, ["#440154", "#fde725"], :top_left)
    # Both hand-written stop forms still reach it.
    @test Legend("t", 0, 12, [(0.0, "#440154"), (1.0, "#fde725")], :top_left).stops[1][2] == "#440154"
    @test Legend("t", 0, 12, [0.0 => "#440154", 1.0 => "#fde725"], :top_left).stops[2][1] == 1.0
end

@testitem "a control's payload names every field it declares" begin
    # Each control with the payload keys it must produce, in order. `Title` appears twice: it
    # declares two content fields and carries exactly one of them.
    cases = [Toggle(:isl, "ISL", true)                  => (:id, :label, :value),
             Legend("t", 0, 12, ["#000000", "#ffffff"]) => (:title, :min, :max, :stops),
             Select(:c, "C", :a, [:a => "A"])           => (:id, :label, :value, :options),
             Title("x")                                 => (:text,),
             Title(Dict(1 => "x"))                      => (:frames,),
             Group([Toggle(:i, "L", true)])             => (:controls,)]
    for (c, ks) in cases
        @test Tuple(keys(CesiumLink.payload(c))) == ks
    end
    # Every declared field reaches the wire: through `payload`, or as one of the two the overlay
    # itself carries. A field added without a matching `payload` method fails here.
    for T in (Toggle, Legend, Select, Title, Group)
        onwire = Set(Iterators.flatten(ks for (c, ks) in cases if c isa T))
        @test isempty(setdiff(fieldnames(T), onwire, (:region, :style)))
    end
end
