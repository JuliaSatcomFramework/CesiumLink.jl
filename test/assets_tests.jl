# The folders a server serves, and the origins its page may reach off-site. Every served directory is
# a named mount answering `/assets/<name>/`, and a directory of basemap tiles is the reserved mount
# `imagery` (ADR-0021).

@testitem "a bare string mounts under the last element of its path" begin
    mktempdir() do root
        dir = mkpath(joinpath(root, "glb"))
        @test CesiumLink.resolve_assets(dir) == Dict("glb" => dir)
        # A trailing slash names the same folder, so it names the same mount.
        @test CesiumLink.resolve_assets(dir * "/") == Dict("glb" => dir)
    end
end

@testitem "a Dict mounts every entry, under the name it is given" begin
    mktempdir() do root
        glb = mkpath(joinpath(root, "a"))
        png = mkpath(joinpath(root, "b"))
        @test CesiumLink.resolve_assets(Dict("models" => glb, "textures" => png)) ==
              Dict("models" => glb, "textures" => png)
        @test CesiumLink.resolve_assets(nothing) == Dict{String,String}()
    end
end

@testitem "a mount name is checked where the author can act on it" begin
    mktempdir() do root
        dir = mkpath(joinpath(root, "glb"))
        # `imagery` is the basemap's own mount. A silent shadow would leave the globe wearing a
        # pyramid nobody named, so it is refused and the message says what to write instead.
        @test_throws "may not claim it" CesiumLink.resolve_assets(Dict("imagery" => dir))
        @test_throws "holds no `/`" CesiumLink.resolve_assets(Dict("a/b" => dir))
        @test_throws "needs a name" CesiumLink.resolve_assets(Dict("" => dir))
        # A path that is not a directory is a mistake here, not a 404 an hour later.
        @test_throws "is not a directory" CesiumLink.resolve_assets(joinpath(root, "nope"))
    end
end

@testitem "a mount serves its files and refuses a path that climbs out of it" setup=[FreePort] begin
    using HTTP

    mktempdir() do root
        dir = mkpath(joinpath(root, "glb"))
        write(joinpath(dir, "sat.glb"), "not really a model")
        mkpath(joinpath(dir, "sub"))
        write(joinpath(dir, "sub", "deep.glb"), "nested")
        write(joinpath(root, "secret"), "beside the mount, and not under it")
        port = freeport()
        server = start_server(; dist_dir = nothing, host = "::1", port, assets = dir)
        try
            @test isopen(server.listener)
            @test CesiumLink.mount_for(server, "/assets/glb/sat.glb") == (dir, "sat.glb")
            # A path of several elements stays whole, which is what a tile pyramid needs.
            @test CesiumLink.mount_for(server, "/assets/glb/sub/deep.glb") == (dir, "sub/deep.glb")
            @test CesiumLink.mount_for(server, "/assets/nothing/sat.glb") === nothing

            r = HTTP.get("http://[::1]:$port/assets/glb/sat.glb")
            @test r.status == 200
            @test String(r.body) == "not really a model"
            # `.glb` is absent from `MIME_TYPES` on purpose: Cesium loads a model from an octet
            # stream, so the table needs no entry for every format a mount might hold.
            @test HTTP.header(r, "Content-Type") == "application/octet-stream"

            @test HTTP.get("http://[::1]:$port/assets/glb/sub/deep.glb").status == 200
            @test HTTP.get("http://[::1]:$port/assets/glb/../secret";
                           status_exception = false).status in (403, 404)
            @test HTTP.get("http://[::1]:$port/assets/nothing/sat.glb";
                           status_exception = false).status == 404
        finally
            stop_server(server)
        end
    end
end

@testitem "the declaration carries the base each mount answers, and not the directory" setup=[FreePort] begin
    using HTTP, JSON, Sockets

    # A browser host needs none of this — a same-origin path already resolves against the page — but
    # a host whose page sits on another origin builds its own URL per mount out of it.
    @test !haskey(JSON.parse(CesiumLink.modules_message(ModuleEntry[]).header)["params"], "assets")
    @test !haskey(JSON.parse(CesiumLink.modules_message(ModuleEntry[];
                                                        assets = Dict{String,String}()).header)["params"],
                  "assets")

    mktempdir() do root
        dir = mkpath(joinpath(root, "glb"))
        port = freeport()
        server = start_server(; dist_dir = nothing, host = "::1", port, assets = dir)
        try
            @test CesiumLink.declared_assets(server) == Dict("glb" => "assets/glb/")
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            end
            @test got["params"]["assets"] == Dict("glb" => "assets/glb/")
        finally
            stop_server(server)
        end
    end
end

@testitem "a basemap URL declares its own origin, and a directory declares none" setup=[Pyramid, FreePort] begin

    @test CesiumLink.url_origin("https://cdn.example/tiles/{z}/{x}/{y}.png") == "https://cdn.example"
    @test CesiumLink.url_origin("https://cdn.example:8443/a/b") == "https://cdn.example:8443"
    @test CesiumLink.url_origin("assets/imagery/") === nothing

    # A session that names a remote basemap and nothing else declares no `trusted_origins` of its
    # own, and still works. That is the whole point of the server adding this one.
    server = start_server(; dist_dir = nothing, host = "::1", port = freeport(),
                          imagery = "https://cdn.example/tiles/{z}/{x}/{y}.png")
    try
        @test server.trusted_origins == ["https://cdn.example"]
    finally
        stop_server(server)
    end

    mktempdir() do dir
        pyramid(dir)
        server = start_server(; dist_dir = nothing, host = "::1", port = freeport(), imagery = dir,
                              trusted_origins = ["https://fonts.example"])
        try
            # A mounted pyramid is same-origin, so it adds nothing; what the author listed stands.
            @test server.trusted_origins == ["https://fonts.example"]
            @test server.asset_dirs["imagery"] == dir
        finally
            stop_server(server)
        end
    end
end

@testitem "the discovery file carries the mounts and the trusted origins" setup=[FreePort] begin
    using JSON

    mktempdir() do runtime
        # The real runtime directory belongs to the user's own sessions.
        withenv("XDG_RUNTIME_DIR" => runtime) do
            mktempdir() do root
                dir = mkpath(joinpath(root, "glb"))
                server = start_server(; dist_dir = nothing, host = "::1", port = freeport(),
                                      assets = dir, trusted_origins = ["https://cdn.example"])
                try
                    entry = JSON.parse(read(server.discovery_file, String))
                    # The extension reads both before it builds the page: a webview is given its
                    # resource roots and its policy when its panel is created.
                    @test entry["assets"] == Dict("glb" => dir)
                    @test entry["trustedOrigins"] == ["https://cdn.example"]
                finally
                    stop_server(server)
                end
            end
        end
    end
end

@testitem "the discovery file names each module's directory, and again after each registration" setup=[FreePort] begin
    using JSON

    mktempdir() do runtime
        withenv("XDG_RUNTIME_DIR" => runtime) do
            mktempdir() do root
                own = mkpath(joinpath(root, "rainfade"))
                write(joinpath(own, "rainfade.js"), "export default {}")
                server = start_server(; dist_dir = nothing, host = "::1", port = freeport())
                try
                    read_entry() = JSON.parse(read(server.discovery_file, String))
                    # Modules are registered after `start_server` returns, so the set in the file
                    # starts empty and every registration must write it again. A host that serves
                    # the page itself is given the directories it may read before the page exists.
                    @test read_entry()["modules"] == Dict{String,Any}()

                    register_module!(server, :rainfade, joinpath(own, "rainfade.js"))
                    @test read_entry()["modules"] == Dict("rainfade" => own)
                    # The whole directory, and not the entry file: sibling chunks are served from it.
                    @test isdir(read_entry()["modules"]["rainfade"])

                    # Everything else the file carries survives the rewrite.
                    entry = read_entry()
                    @test entry["port"] == bound_port(server)
                    @test haskey(entry, "dist") && haskey(entry, "assets")

                    # A reader opens this file at a moment the server does not choose, and a rewrite
                    # must never hand it a fragment: an editor asked to open the scene reads the
                    # file once, and a fragment reads as a scene that is not running.
                    #
                    # A read that does not open the file at all is a different answer, and only
                    # Windows gives it: replacing a name another process holds open leaves that name
                    # delete-pending, and an open in that instant is refused. A reader there has to
                    # ask again. What no reader may ever see is half a file.
                    stop = Ref(false)
                    torn = Ref(0)
                    refused = Ref(0)
                    reader = Threads.@spawn while !stop[]
                        text = try
                            read(server.discovery_file, String)
                        catch
                            refused[] += 1
                            nothing
                        end
                        text === nothing || try
                            JSON.parse(text)
                        catch
                            torn[] += 1
                        end
                        yield()
                    end
                    for _ in 1:200
                        register_module!(server, :rainfade, joinpath(own, "rainfade.js"))
                    end
                    stop[] = true
                    wait(reader)
                    @test torn[] == 0
                    # The file is whole again the moment the rewrite is over.
                    @test read_entry()["modules"] == Dict("rainfade" => own)
                    Sys.iswindows() || @test refused[] == 0
                finally
                    stop_server(server)
                end
            end
        end
    end
end
