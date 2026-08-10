# The tracer scene shipped beside the viewer, `tools/tracks/serve.jl`, exercised as a scene author's
# code rather than as part of the package: what its listeners send is the only place several of the
# package's mechanisms are used together.

@testitem "clicking an entity pins a float and pushes the window its track rides" begin
    using CesiumLink: answer_event
    using JSON

    include(joinpath(pkgdir(CesiumLink), "tools", "tracks", "serve.jl"))

    # `vendored` asks only that the module file is there, so the scene runs against a dist that was
    # never built — nothing here reaches the browser.
    mktempdir() do dist
        for id in ("primitives", "ui")
            mkpath(joinpath(dist, "modules", id))
            write(joinpath(dist, "modules", id, "$id.js"), "export default {};\n")
        end
        server = serve_tracks(; port = 0, dist_dir = dist)
        try
            # A click on the second satellite, eight keyframes in. The wire is 0-based in both.
            click = Dict("module" => "core", "topic" => "pointer", "seq" => 1, "frame" => 7,
                         "payload" => Dict("type" => "click", "mods" => String[],
                                           "screen" => Dict("x" => 0, "y" => 0),
                                           "entities" => [Dict("module" => "primitives",
                                                               "kind" => "sat", "idx" => 1)]))
            answer_event(server, click)

            floats = JSON.parse(CesiumLink.retained(server, ("ui", "floating")
                                ).header)["params"]["commands"][1]["payload"]
            @test any(f -> f["id"] == "sat-2" && f["keyframed"] == ["html"], floats)

            # The window pushed in the same answer covers where the clock was and carries one
            # fragment per keyframe for the float just declared, so the box never shows its
            # placeholder to a client that has this window.
            w = JSON.parse(CesiumLink.retained(server, ("core", "window")).header)["params"]
            @test w["mode"] == "replace"
            @test w["startFrame"] == 7
            @test w["count"] == 2
            @test get(w["payloads"]["ui"]["tracks"], "sat-2", nothing) ==
                  Dict("html" => ["<b>Pinned sat 2</b><br>at keyframe 8",
                                  "<b>Pinned sat 2</b><br>at keyframe 9"])
        finally
            stop_server(server)
            empty!(PINNED)
        end
    end
end
