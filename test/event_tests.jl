@testitem "the subscription is the union of what the listeners asked for" begin
    using CesiumLink: EventListener, pointer_subscription

    l(; module_id = "core", topic = "pointer", id = nothing, type = nothing, alt = nothing,
      ctrl = nothing, shift = nothing, coordinate = false, debounce_ms = 5) =
        EventListener(identity, module_id, topic, id, type, alt, ctrl, shift, coordinate,
                      debounce_ms)

    # One entry per distinct (type, mods) interest, in registration order.
    subs = pointer_subscription([l(; type = :hover),
                                 l(; type = :click, alt = true, ctrl = false, shift = false)])
    @test length(subs) == 2
    @test subs[1].type == "hover" && subs[1].mods === nothing
    @test subs[2].type == "click" && subs[2].mods == ["alt"]

    # A listener that named some modifiers and left the rest open cannot be one entry: an entry names
    # a set exactly. It is expanded into every set consistent with what it did name.
    partial = pointer_subscription([l(; type = :click, alt = true)])
    @test [e.mods for e in partial] ==
          [["alt"], ["alt", "shift"], ["alt", "ctrl"], ["alt", "ctrl", "shift"]]

    # Naming none of them stays the wire's own "any state", not eight entries.
    @test only(pointer_subscription([l(; type = :click)])).mods === nothing

    # The expansions of two listeners overlap, and an entry two of them cover is still one entry.
    shared = pointer_subscription([l(; type = :click, alt = true),
                                   l(; type = :click, ctrl = true, coordinate = true)])
    @test length(shared) == 4 + 4 - 2
    @test count(e -> e.mods == ["alt", "ctrl"], shared) == 1

    # Listeners sharing an interest collapse into one entry: the coordinate if any of them wants it,
    # and the smallest debounce any of them named.
    merged = pointer_subscription([l(; type = :hover, debounce_ms = 200),
                                   l(; type = :hover, coordinate = true, debounce_ms = 5)])
    @test length(merged) == 1
    @test merged[1].coordinate
    @test merged[1].debounceMs == 5

    # Only pointer events are subject to a subscription; a listener on anything else adds no entry.
    @test isempty(pointer_subscription([l(; topic = "need"), l(; module_id = "ui", topic = "control")]))
    @test isempty(pointer_subscription(EventListener[]))
end

@testitem "a listener declares its subscription to the viewer, and it survives a reconnect" setup=[FreePort, WsOpen] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        on_pointer((ev, reply) -> nothing, server; type = :click, alt = true, ctrl = false,
                 shift = false, coordinate = true)
        got = ws_open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)                       # the `modules` declaration, discarded
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header               # the replayed subscription
        end
        m = JSON.parse(got)
        @test m["method"] == "commands"
        c = only(m["params"]["commands"])
        @test c["module"] == "core"                           # the Core itself, not a module
        @test c["topic"] == "subscribe"
        entry = only(c["payload"])
        @test entry["type"] == "click"
        @test entry["mods"] == ["alt"]
        @test entry["coordinate"]
        @test entry["debounceMs"] == 5
    finally
        stop_server(server)
    end
end

@testitem "on_pointer refuses an interest the viewer could not match" begin
    server = start_server(; host = "::1", port = 0)
    try
        @test_throws "an event type is :hover or :click" on_pointer(identity, server; type = :drag)
        # A modifier is a keyword of its own, so a name that is not one of the three is not a value
        # to validate — it is an argument the method does not have.
        @test_throws MethodError on_pointer(identity, server; meta = true)
        # A pointer keyword narrows a subscription, and only pointer events have one. On any other
        # topic it is an argument that method does not have, rather than a value quietly ignored.
        @test_throws MethodError on_event(identity, server, "ui", "control"; coordinate = true)
    finally
        stop_server(server)
    end
end

@testitem "on_event refuses a listener it could not call" begin
    using CesiumLink: dispatch_event

    seen = String[]
    # Annotated arguments: narrower than the `f(ev, reply)` the docs name, and callable all the same.
    annotated(ev::NamedTuple, reply::Reply) = push!(seen, ev.topic)

    server = start_server(; host = "::1", port = 0)
    try
        @test_throws "f(ev, reply)" on_pointer(ev -> nothing, server; type = :hover)
        @test_throws ArgumentError on_pointer(ev -> nothing, server; type = :hover)

        # A routing key is a `String`, and a `Symbol` is refused at the call site. A converted
        # `Symbol` would be compared against the `String` the registry holds, so `ev.topic ==
        # "control"` would be false in a listener registered as `:control`.
        @test_throws MethodError on_event((ev, reply) -> nothing, server, :ui, :close)
        @test_throws MethodError command!(Reply(), :ui, :tooltip, (; html = "x"))
        @test_throws MethodError send_command(server, :ui, :declare, [])

        on_event(annotated, server, "ui", "control")
        dispatch_event(server, Dict("module" => "ui", "topic" => "control"))
        @test seen == ["control"]
    finally
        stop_server(server)
    end
end

@testitem "an event reaches the listeners registered for it, in 1-based terms" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        seen = []
        on_pointer((ev, reply) -> push!(seen, ev), server; type = :click, alt = true)
        # A hover, and a click with the wrong modifiers: forwarded for some other listener's sake,
        # but not this listener's interest.
        hover = Dict("module" => "core", "topic" => "pointer", "seq" => 1, "frame" => 4,
                     "window" => 2, "payload" => Dict("type" => "hover", "mods" => [],
                                                      "entities" => [],
                                                      "screen" => Dict("x" => 1, "y" => 2)))
        dispatch_event(server, hover)
        @test isempty(seen)

        click = Dict("module" => "core", "topic" => "pointer", "seq" => 7, "frame" => 16,
                     "window" => 3,
                     "payload" => Dict("type" => "click", "mods" => ["alt"],
                                       "entities" => [Dict("module" => "tracks", "kind" => "sat",
                                                           "idx" => 11)],
                                       "screen" => Dict("x" => 812, "y" => 344),
                                       "coordinate" => Dict("lon" => 12.49, "lat" => 41.9,
                                                            "height" => 0)))
        dispatch_event(server, click)
        ev = only(seen)
        @test ev.type == :click
        @test ev.mods == (:alt,)
        @test ev.entity.module_id == "tracks"
        @test ev.entity.kind == "sat"
        @test ev.entity.idx == 12          # the wire is 0-based, the Julia API 1-based
        @test ev.frame == 17               # likewise
        @test ev.window == 3
        @test ev.seq == 7
        @test ev.screen == (; x = 812, y = 344)
        @test ev.coordinate.lon == 12.49
    finally
        stop_server(server)
    end
end

@testitem "the clock and the keyframe topics are read into names, and the index is 1-based" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        seen = []
        on_event((ev, _) -> push!(seen, ev), server, "core", "clock")
        on_event((ev, _) -> push!(seen, ev), server, "core", "keyframe")

        dispatch_event(server, Dict("module" => "core", "topic" => "clock", "seq" => 1,
                                    "frame" => 4, "window" => 2,
                                    "payload" => Dict("multiplier" => -2.5, "playing" => true)))
        clk = seen[1]
        @test clk.multiplier == -2.5       # signed: the sign is the direction, the size the speed
        @test clk.playing
        @test clk.frame == 5               # the wire is 0-based, the Julia API 1-based

        dispatch_event(server, Dict("module" => "core", "topic" => "keyframe", "seq" => 2,
                                    "frame" => 7, "window" => 2,
                                    "payload" => Dict("index" => 7)))
        @test seen[2].index == 8

        # The opening window crosses before the clock has ticked, so the event's own `frame` stamp is
        # absent. The crossing carries its index anyway, which is why it is not read off `frame`.
        dispatch_event(server, Dict("module" => "core", "topic" => "keyframe", "seq" => 3,
                                    "frame" => nothing, "window" => nothing,
                                    "payload" => Dict("index" => 0)))
        @test seen[3].frame === nothing
        @test seen[3].index == 1
    finally
        stop_server(server)
    end
end

@testitem "an event carries everything under the cursor, and entity is the nearest of it" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        seen = []
        on_pointer((ev, reply) -> push!(seen, ev), server; type = :click)
        stack(entities) = Dict("module" => "core", "topic" => "pointer", "frame" => 4,
                               "payload" => Dict("type" => "click", "mods" => [], "entities" => entities,
                                                 "screen" => Dict("x" => 0, "y" => 0)))
        # A highlight in front of the cell it was drawn from. Which one the click was aimed at is
        # this listener's call to make, so both reach it, nearest first and 1-based.
        dispatch_event(server, stack([Dict("module" => "coverage", "kind" => "highlight", "idx" => 0),
                                      Dict("module" => "coverage", "kind" => "cell", "idx" => 2134)]))
        ev = only(seen)
        @test ev.entities == [(; module_id = "coverage", kind = "highlight", idx = 1),
                              (; module_id = "coverage", kind = "cell", idx = 2135)]
        @test ev.entity === first(ev.entities)
        # Scanning the stack for the kind that matters is what a listener does with it.
        @test ev.entities[findfirst(e -> e.kind == "cell", ev.entities)].idx == 2135

        empty!(seen)
        dispatch_event(server, stack([]))
        @test isempty(only(seen).entities) && only(seen).entity === nothing
    finally
        stop_server(server)
    end
end

@testitem "each modifier narrows on its own, and the ones left alone are not narrowed on" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        bare, any, withalt = Symbol[], Symbol[], Symbol[]
        on_pointer((ev, reply) -> push!(bare, :hit), server; type = :click, alt = false, ctrl = false,
                 shift = false)
        on_pointer((ev, reply) -> push!(any, :hit), server; type = :click)
        on_pointer((ev, reply) -> push!(withalt, :hit), server; type = :click, alt = true)
        click(mods) = Dict("module" => "core", "topic" => "pointer",
                           "payload" => Dict("type" => "click", "mods" => mods,
                                             "entities" => [],
                                             "screen" => Dict("x" => 0, "y" => 0)))
        # An unmodified click. The wire carries no elements to type, so the list arrives untyped and
        # emptiness rather than element type is what has to match.
        dispatch_event(server, click([]))
        @test length(bare) == 1 && length(any) == 1 && isempty(withalt)

        # The same gesture with a modifier held is a different interest entirely: a listener that
        # required none held must not see it, or two gestures on one button become one.
        dispatch_event(server, click(["alt"]))
        @test length(bare) == 1 && length(any) == 2 && length(withalt) == 1

        # A modifier nobody narrowed on does not narrow: the listener that asked for alt and said
        # nothing about shift wants this one too, and the one that required shift absent does not.
        dispatch_event(server, click(["alt", "shift"]))
        @test length(bare) == 1 && length(any) == 3 && length(withalt) == 2
    finally
        stop_server(server)
    end
end

@testitem "one broken listener does not take the rest of the chain down" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        ran = String[]
        on_pointer((ev, reply) -> (push!(ran, "first"); error("boom")), server)
        on_pointer((ev, reply) -> push!(ran, "second"), server)
        params = Dict("module" => "core", "topic" => "pointer",
                      "payload" => Dict("type" => "hover", "mods" => [], "entities" => [],
                                        "screen" => Dict("x" => 0, "y" => 0)))
        @test_logs (:warn,) match_mode = :any dispatch_event(server, params)
        @test ran == ["first", "second"]
    finally
        stop_server(server)
    end
end

@testitem "a module's own notify is a listener key like any other" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        seen = []
        on_event((ev, reply) -> push!(seen, ev), server, "ui", "control")
        dispatch_event(server, Dict("module" => "ui", "topic" => "control", "frame" => 0,
                                    "payload" => Dict("id" => "cells", "value" => "served")))
        ev = only(seen)
        @test ev.module_id == "ui" && ev.topic == "control"
        @test ev.payload.id == "cells"     # the payload is reachable by name, not by string key
        @test ev.payload.value == "served"
        @test ev.frame == 1
        # A pointer interest narrows nothing here: only the Core's pointer topic carries a type.
        @test !haskey(ev, :type)
    finally
        stop_server(server)
    end
end

@testitem "a command batch names its target module and topic" begin
    using CesiumLink: commands_message, Command
    using JSON

    m = JSON.parse(commands_message([Command("ui", "tooltip", (; html = "<b>x</b>")),
                                     Command("core", "subscribe", [])]; seq = 41).header)
    @test m["method"] == "commands"
    @test m["params"]["seq"] == 41
    cs = m["params"]["commands"]
    @test [c["module"] for c in cs] == ["ui", "core"]
    @test cs[1]["topic"] == "tooltip"
    @test cs[1]["payload"]["html"] == "<b>x</b>"
    # `seq` is present only when the batch answers an event.
    @test !haskey(JSON.parse(commands_message(Command[]).header)["params"], "seq")
end

@testitem "a reply is one batch, and the last writer on a (module, topic) wins" begin
    using CesiumLink: Reply

    reply = Reply()
    command!(reply, "ui", "tooltip", (; html = "first"))
    command!(reply, "tracks", "emphasize", (; idx = 3))
    command!(reply, "ui", "tooltip", (; html = "second"))

    # Two commands, not three: the second write on `ui/tooltip` replaced the first where it stood,
    # so the order the chain built stays the order the viewer applies.
    @test length(reply.commands) == 2
    @test reply.commands[1].module_id == "ui"
    @test reply.commands[1].topic == "tooltip"
    @test reply.commands[1].payload.html == "second"
    @test reply.commands[2].module_id == "tracks"
    @test reply.commands[2].payload.idx == 3
end

@testitem "tooltip fragments accumulate as a list in one command addressed at the ui module" begin
    using CesiumLink: Reply

    reply = Reply()
    tooltip!(io -> print(io, "<b>Sat 12</b>"), reply)
    tooltip!(io -> print(io, "<i>3 links</i>"), reply; bare = true)

    c = only(reply.commands)
    @test c.module_id == "ui"                 # a tooltip is an ordinary command, not its own path
    @test c.topic == "tooltip"
    # One entry per contributing listener, in chain order: `ui` wraps each fragment on its own, and
    # a joined string would leave it nothing to wrap on.
    @test c.payload.html == ["<b>Sat 12</b>", "<i>3 links</i>"]
    @test c.payload.bare

    # Anything else already sitting on `ui/tooltip` is not a fragment list, so it is replaced rather
    # than appended to.
    command!(reply, "ui", "tooltip", (; html = nothing))
    tooltip!(io -> print(io, "fresh"), reply)
    @test only(reply.commands).payload == (; html = ["fresh"], bare = false)
end

@testitem "a listener returning :halt stops the chain, and what was collected still ships" begin
    using CesiumLink: dispatch_event

    server = start_server(; host = "::1", port = 0)
    try
        behind = String[]
        on_pointer(server) do ev, reply
            command!(reply, "ui", "tooltip", (; html = "ahead of the halt"))
            return :halt
        end
        on_pointer((ev, reply) -> push!(behind, "ran"), server)
        params = Dict("module" => "core", "topic" => "pointer",
                      "payload" => Dict("type" => "hover", "mods" => [], "entities" => [],
                                        "screen" => Dict("x" => 0, "y" => 0)))
        reply = dispatch_event(server, params)
        @test isempty(behind)
        @test only(reply.commands).payload.html == "ahead of the halt"
    finally
        stop_server(server)
    end
end

@testitem "an answered event sends one batch echoing its seq" setup=[FreePort, WsOpen] begin
    using HTTP, JSON

    port = freeport()
    server = start_server(; host = "::1", port)
    try
        # Two independent listeners on the same event, each with something of its own to say.
        on_pointer(server; type = :hover) do ev, reply
            tooltip!(io -> print(io, "<b>", ev.entity.kind, " #", ev.entity.idx, "</b>"), reply)
        end
        on_pointer(server; type = :hover) do ev, reply
            command!(reply, "tracks", "emphasize", (; kind = String(ev.entity.kind),
                                                  idx = ev.entity.idx))
        end
        got = ws_open("ws://[::1]:$port/ws") do ws
            HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
            HTTP.WebSockets.receive(ws)                       # the `modules` declaration
            HTTP.WebSockets.receive(ws)                       # the replayed subscription
            HTTP.WebSockets.send(ws, JSON.json(Dict(
                "method" => "event",
                "params" => Dict("module" => "core", "topic" => "pointer", "seq" => 41,
                                 "frame" => 16, "window" => 3,
                                 "payload" => Dict("type" => "hover", "mods" => [],
                                                   "screen" => Dict("x" => 8, "y" => 4),
                                                   "entities" => [Dict("module" => "tracks",
                                                                       "kind" => "sat",
                                                                       "idx" => 11)])))))
            CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header
        end
        m = JSON.parse(got)
        @test m["method"] == "commands"
        @test m["params"]["seq"] == 41                        # the batch names the event it answers
        cs = m["params"]["commands"]
        # One message for both listeners, in the order they were registered.
        @test length(cs) == 2
        @test cs[1]["module"] == "ui" && cs[1]["topic"] == "tooltip"
        @test cs[1]["payload"]["html"] == ["<b>sat #12</b>"]  # the wire is 0-based, Julia 1-based
        @test cs[2]["module"] == "tracks" && cs[2]["topic"] == "emphasize"
        @test cs[2]["payload"]["idx"] == 12
    finally
        stop_server(server)
    end
end

@testitem "a batch is dropped once the chain replaced the scene it was resolved against" begin
    using CesiumLink: answer_event, declared

    click(seq) = Dict("module" => "core", "topic" => "pointer", "seq" => seq,
                      "payload" => Dict("type" => "click", "mods" => [], "entities" => [],
                                        "screen" => Dict("x" => 0, "y" => 0)))
    pushed(server, mode) = push_window(server, Dict(:tracks => (; n = 1));
                                       start_frame = 1, count = 1, dt_seconds = 60,
                                       total_frames = 1, mode)
    sent(server, module_id, topic) = declared(server, module_id, topic) !== nothing

    server = start_server(; host = "::1", port = 0)
    try
        mode = Ref(:append)
        on_pointer(server; type = :click) do ev, reply
            command!(reply, "ui", "tooltip", (; html = "still current"))
            pushed(server, mode[])
        end

        # An append preserves the index space, so the commands still address the scene on screen.
        @test !isempty(answer_event(server, click(1)).commands)
        @test sent(server, "ui", "tooltip")

        # A replace may renumber entities, so the same contribution is withheld: it describes a
        # scene that no longer exists, and fresh state is already on its way.
        mode[] = :replace
        server.retained = filter(p -> first(p) != ("ui", "tooltip"), server.retained)
        @test !isempty(answer_event(server, click(2)).commands)
        @test !sent(server, "ui", "tooltip")
    finally
        stop_server(server)
    end
end

@testitem "a command's arrays are encoded on the way out, an event's decoded on the way in" begin
    using CesiumLink: Reply, dispatch_event, send_reply, encode_arrays, declared
    using JSON

    server = start_server(; host = "::1", port = 0)
    try
        # Inbound: a listener is handed the array itself, not the object that carried it. The
        # payload is encoded the way the viewer encodes one — the array's bytes in the frame's
        # region, and an offset into it in the header.
        seen = []
        on_event((ev, reply) -> push!(seen, ev.payload.field), server, "heatmap", "sample")
        region = IOBuffer()
        payload = encode_arrays(Dict("field" => Float32[1, 2]), region)
        dispatch_event(server, Dict("module" => "heatmap", "topic" => "sample",
                                    "payload" => payload), take!(region))
        @test only(seen) == Float32[1, 2]

        # Outbound: the same in reverse, so a listener writes an array and the viewer reads one.
        reply = Reply()
        command!(reply, "heatmap", "field", (; values = Float32[1, 2, 3]))
        send_reply(server, reply)
        @test declared(server, "heatmap", "field")["values"]["\$wire"] == "f32"
    finally
        stop_server(server)
    end
end

@testitem "a listener can be taken back out, and installing a scene takes the previous one's out" begin
    using CesiumLink: answer_event, install_scene!, declared

    click() = Dict("module" => "core", "topic" => "pointer", "seq" => 1,
                   "payload" => Dict("type" => "click", "mods" => [], "entities" => [],
                                     "screen" => Dict("x" => 0, "y" => 0)))
    subscription(server) = declared(server, "core", "subscribe")
    # The server registers a listener of its own on `ui/rect` when it starts, which is nobody's to
    # remove. Only the pointer listeners registered here are counted.
    pointer_listeners(server) = [l for l in server.listeners if l.topic == "pointer"]

    server = start_server(; host = "::1", port = 0)
    try
        seen = String[]
        hover = on_pointer(server; type = :hover) do ev, reply; push!(seen, "hover"); end
        clicked = on_pointer(server; type = :click) do ev, reply; push!(seen, "click"); end
        @test length(subscription(server)) == 2

        # Removal is by identity, and what the survivors add up to is declared again.
        @test off_event(server, hover)
        @test length(pointer_listeners(server)) == 1
        @test only(subscription(server))["type"] == "click"
        # Already gone stays gone rather than removing something else.
        @test !off_event(server, hover)
        @test length(pointer_listeners(server)) == 1

        answer_event(server, click())
        @test seen == ["click"]

        # Installing a scene replaces the one before it: the first scene's listeners answer nothing
        # afterwards, so one click cannot be answered twice with two scenes' worth of state.
        first_scene = install_scene!(server, (; name = "first"), [clicked])
        @test server.scene === first_scene
        second = on_pointer(server; type = :click) do ev, reply; push!(seen, "second"); end
        install_scene!(server, (; name = "second"), [second])
        @test server.scene.name == "second"
        @test pointer_listeners(server) == [second]
        # Installing a scene takes out that scene's listeners, and the server's own stands through it.
        @test [l.topic for l in server.listeners] == ["rect", "pointer"]

        empty!(seen)
        answer_event(server, click())
        @test seen == ["second"]
    finally
        stop_server(server)
    end
end

@testitem "the ui subscription names the box, the crossing and the modifier set" begin
    using CesiumLink: EventListener, ui_subscription, pointer_subscription

    l(; module_id = "ui", topic = "pointer", id = nothing, type = nothing, alt = nothing,
      ctrl = nothing, shift = nothing, coordinate = false, debounce_ms = 5) =
        EventListener(identity, module_id, topic, id, type, alt, ctrl, shift, coordinate,
                      debounce_ms)

    # Two listeners on one (id, type, mods) interest are one entry, not two.
    @test only(ui_subscription([l(; id = "run-title", type = :click),
                                l(; id = "run-title", type = :click)])) ==
          (; id = "run-title", type = "click", mods = nothing)

    # A listener that named one modifier and left the rest open is expanded the way a core one is:
    # an entry names a set exactly, so it takes four of them to say "alt held, the rest as they come".
    partial = ui_subscription([l(; id = "bar", type = :enter, alt = true)])
    @test [e.mods for e in partial] ==
          [["alt"], ["alt", "shift"], ["alt", "ctrl"], ["alt", "ctrl", "shift"]]
    @test all(e -> e.id == "bar" && e.type == "enter", partial)

    # Naming no box is the wire's "any addressed box", exactly as naming no type is any crossing.
    @test only(ui_subscription([l()])) == (; id = nothing, type = nothing, mods = nothing)

    # The two lists are derived from disjoint halves of the registry, so neither can pick up the
    # other's listeners.
    @test isempty(ui_subscription([l(; module_id = "core", type = :click)]))
    @test isempty(pointer_subscription([l(; id = "bar", type = :click)]))
    @test isempty(ui_subscription(EventListener[]))
end

@testitem "a crossing on a box is flattened onto the event, as a pick is" begin
    using CesiumLink: build_event

    ev = build_event(Dict("module" => "ui", "topic" => "pointer", "seq" => 3, "frame" => 4,
                          "window" => 1,
                          "payload" => Dict("type" => "enter", "id" => "sat-7-card",
                                            "mods" => ["alt"],
                                            "screen" => Dict("x" => 412, "y" => 88))))
    @test ev.type === :enter                  # a Symbol, so the same filter serves both topics
    @test ev.id == "sat-7-card"               # a name the scene author invented, so a String
    @test ev.mods == (:alt,)
    @test ev.screen == (; x = 412, y = 88)    # container pixels, carried through as they came
    @test ev.frame == 5                       # the wire is 0-based, the Julia API 1-based
end

@testitem "a box listener answers only the box it named" begin
    using CesiumLink: dispatch_event, on_ui_pointer

    server = start_server(; host = "::1", port = 0)
    try
        seen = String[]
        on_ui_pointer((ev, reply) -> push!(seen, ev.id), server, "run-title"; type = :click)
        on_ui_pointer((ev, reply) -> push!(seen, "any:" * ev.id), server; type = :click)
        # A Symbol names the same box: the id is recorded as the String both sides of the wire use.
        on_ui_pointer((ev, reply) -> push!(seen, "sym"), server, :bar; type = :click)
        crossing(id, type) = Dict("module" => "ui", "topic" => "pointer",
                                  "payload" => Dict("type" => type, "id" => id, "mods" => [],
                                                    "screen" => Dict("x" => 0, "y" => 0)))
        dispatch_event(server, crossing("bar", "click"))
        @test seen == ["any:bar", "sym"]

        empty!(seen)
        dispatch_event(server, crossing("run-title", "click"))
        @test seen == ["run-title", "any:run-title"]

        # The type narrows a box listener as it narrows a core one.
        empty!(seen)
        dispatch_event(server, crossing("run-title", "enter"))
        @test isempty(seen)
    finally
        stop_server(server)
    end
end

@testitem "the globe's subscription and the overlay's are declared apart" begin
    using CesiumLink: on_ui_pointer, declared

    server = start_server(; host = "::1", port = 0)
    try
        on_pointer(server; type = :click) do ev, reply; end
        # Nothing has asked for a crossing yet, so nothing about crossings has been said.
        @test declared(server, "ui", "subscribe") === nothing

        box = on_ui_pointer(server, "run-title"; type = :enter) do ev, reply; end
        @test only(declared(server, "core", "subscribe"))["type"] == "click"
        entry = only(declared(server, "ui", "subscribe"))
        @test entry["id"] == "run-title"
        @test entry["type"] == "enter"
        @test entry["mods"] === nothing        # a null matches any modifier state

        # A listener added to either topic leaves the other list as it stood.
        on_pointer(server; type = :hover) do ev, reply; end
        @test length(declared(server, "core", "subscribe")) == 2
        @test length(declared(server, "ui", "subscribe")) == 1

        # The last box listener out declares the empty list that turns the crossings off.
        @test off_event(server, box)
        @test isempty(declared(server, "ui", "subscribe"))
        @test length(declared(server, "core", "subscribe")) == 2
    finally
        stop_server(server)
    end
end

@testitem "on_ui_pointer refuses a crossing a box could not raise" begin
    using CesiumLink: on_ui_pointer

    server = start_server(; host = "::1", port = 0)
    try
        @test_throws "a ui event type is :click, :enter or :leave" on_ui_pointer(identity, server;
                                                                                type = :hover)
        @test_throws "f(ev, reply)" on_ui_pointer(ev -> nothing, server; type = :click)
    finally
        stop_server(server)
    end
end
