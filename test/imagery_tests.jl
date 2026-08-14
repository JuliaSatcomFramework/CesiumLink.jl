# What the globe is textured with: the layout sniff, the depth probe, the `assets/imagery/` mount,
# and the field the session declaration carries.
#
# A directory decides its own layout, so every test that states one states it by what it writes into
# the directory rather than by an argument.

@testitem "an Imagery refuses what the viewer could not draw" begin
    @test_throws "`tiling` is `:mercator` or `:geographic`" Imagery("u"; tiling = :web)
    # Level 0 is the whole globe in one tile, so a maximum of 0 asks for a pyramid with nothing
    # under its top. A negative one names no level at all.
    @test_throws "positive integer" Imagery("u"; max_level = 0)
    @test_throws "positive integer" Imagery("u"; max_level = -3)

    im = Imagery("u"; tiling = :geographic, max_level = 7, credit = "USGS")
    @test (im.url, im.tiling, im.max_level, im.credit) == ("u", :geographic, 7, "USGS")
    @test (Imagery("u").tiling, Imagery("u").max_level, Imagery("u").credit) ==
          (:mercator, nothing, nothing)
    # The easy case is one string, and it reaches everything that takes an `Imagery`.
    @test convert(Imagery, "u").url == "u"
end

@testitem "the three states of `imagery` are three different declarations" begin
    # Absent, no base layer, and one source are not the same thing: the first keeps the viewer's
    # bundled texture and the second draws none at all.
    @test CesiumLink.resolve_imagery(nothing) == (nothing, nothing)
    @test CesiumLink.resolve_imagery(:none) == (false, nothing)
    # A symbol that is not `:none` is a typo, and would otherwise be declared as a URL.
    @test_throws "`:none`" CesiumLink.resolve_imagery(:None)
end

@testitem "a URL is declared as it stands and never fetched" begin
    template = "https://example.invalid/tiles/{z}/{x}/{y}.png"
    # `example.invalid` resolves nowhere. This test passes because `start_server` makes no request:
    # a source that answers nothing is found by the browser, not here.
    d, dir = CesiumLink.resolve_imagery(template)
    @test dir === nothing
    @test d == (; url = template, layout = "xyz", tiling = "mercator")

    d, _ = CesiumLink.resolve_imagery(Imagery(template; tiling = :geographic, max_level = 7,
                                              credit = "USGS"))
    @test d == (; url = template, layout = "xyz", tiling = "geographic", maxLevel = 7,
                credit = "USGS")
end

@testitem "an XYZ directory is sniffed, probed and mounted relative" setup=[Pyramid] begin
    mktempdir() do dir
        pyramid(dir; depth = 2)
        d, mounted = CesiumLink.resolve_imagery(dir)
        @test mounted == dir
        # The URL is relative, which is what makes the mount same-origin with the page: an absolute
        # one would need a CORS header from wherever it pointed.
        @test d == (; url = "assets/imagery/{z}/{x}/{y}.png", layout = "xyz", tiling = "mercator",
                    maxLevel = 2)

        # The probe reads the deepest level on disk; a stated maximum wins over it.
        d, _ = CesiumLink.resolve_imagery(Imagery(dir; max_level = 1, tiling = :geographic))
        @test d == (; url = "assets/imagery/{z}/{x}/{y}.png", layout = "xyz", tiling = "geographic",
                    maxLevel = 1)

        # A file whose name is not a number is not a level.
        write(joinpath(dir, "readme.txt"), "not a level")
        mkpath(joinpath(dir, "thumbnails"))
        @test first(CesiumLink.resolve_imagery(dir)).maxLevel == 2
    end
end

@testitem "an XYZ directory declares a URL that names one tile at a time" setup=[Pyramid] begin
    # The declaration is the template Cesium requests verbatim, so a URL with no placeholder in it
    # asks for the mount root once per tile and draws nothing. Assert what the string has to do,
    # and not only what it reads: every tile of a level must come out as a URL of its own.
    mktempdir() do dir
        pyramid(dir; depth = 1)
        url = first(CesiumLink.resolve_imagery(dir)).url
        asked(z, x, y) = replace(url, "{z}" => string(z), "{x}" => string(x), "{y}" => string(y))
        @test length(unique(asked(z, x, y) for z in 0:1, x in 0:1, y in 0:1)) == 8
        # And the URL a tile is asked by is the file the mount holds.
        @test isfile(joinpath(dir, asked(1, 1, 1)[length("assets/imagery/") + 1:end]))
    end

    # The name is read from a tile that is there. gdal2tiles writes `.jpg` for a pyramid with no
    # transparency, and a `.png` template would ask that pyramid for files it does not hold.
    mktempdir() do dir
        pyramid(dir; ext = "jpg")
        @test first(CesiumLink.resolve_imagery(dir)).url == "assets/imagery/{z}/{x}/{y}.jpg"
    end

    # A level directory with no tile under it names nothing to ask for, and saying so beats
    # declaring a template built on a guess.
    mktempdir() do dir
        mkpath(joinpath(dir, "0", "0"))
        @test_throws "no tile in it" CesiumLink.resolve_imagery(dir)
    end
end

@testitem "a TMS directory decides its own tiling scheme" setup=[Pyramid] begin
    mktempdir() do dir
        pyramid(dir; layout = :tms)
        d, mounted = CesiumLink.resolve_imagery(Imagery(dir; credit = "USGS"))
        @test mounted == dir
        # `tilemapresource.xml` carries the scheme and the depth, and Cesium reads both out of it,
        # so neither travels on the declaration.
        @test d == (; url = "assets/imagery/", layout = "tms", credit = "USGS")

        # Stating one anyway is a misunderstanding worth a line: the file decides, and the stated
        # scheme is dropped rather than declared.
        @test_logs (:warn, r"tilemapresource.xml` decides") begin
            d, _ = CesiumLink.resolve_imagery(Imagery(dir; tiling = :geographic))
            @test !haskey(d, :tiling)
        end
    end
end

@testitem "a directory that is neither pyramid names both layouts" setup=[Pyramid] begin
    mktempdir() do dir
        write(joinpath(dir, "moon.png"), "a texture, not a pyramid")
        # The mistake is easy — one image, or the parent of the pyramid — and the fix is the flag
        # gdal2tiles was, or was not, run with.
        @test_throws "TMS" CesiumLink.resolve_imagery(dir)
        @test_throws "XYZ" CesiumLink.resolve_imagery(dir)
        @test_throws "--xyz" CesiumLink.resolve_imagery(dir)
    end
end

@testitem "the declaration carries the imagery field, and omits it when there is none" begin
    using JSON

    params(; kw...) = JSON.parse(CesiumLink.modules_message(ModuleEntry[]; kw...).header)["params"]

    @test !haskey(params(), "imagery")
    @test params(; imagery = false)["imagery"] == false
    @test params(; imagery = (; url = "assets/imagery/", layout = "tms"))["imagery"] ==
          Dict("url" => "assets/imagery/", "layout" => "tms")
end

@testitem "the mount serves a tile and refuses a path that climbs out of it" setup=[Pyramid, FreePort] begin
    using HTTP, JSON

    mktempdir() do root
        dir = pyramid(mkpath(joinpath(root, "tiles")))
        write(joinpath(root, "secret"), "beside the mount, and not under it")
        port = freeport()
        server = start_server(; dist_dir = nothing, host = "::1", port, imagery = dir)
        try
            # The `<z>/<x>/<y>.png` of a tile is three segments, and the mount puts them back
            # together under the directory.
            @test CesiumLink.mount_for(server, "/assets/imagery/2/1/1.png") == (dir, "2/1/1.png")

            r = HTTP.get("http://[::1]:$port/assets/imagery/0/0/0.png")
            @test r.status == 200
            @test String(r.body) == "tile 0/0/0"
            @test HTTP.header(r, "Content-Type") == "image/png"

            @test HTTP.get("http://[::1]:$port/assets/imagery/2/1/1.png").status == 200
            @test HTTP.get("http://[::1]:$port/assets/imagery/3/0/0.png";
                           status_exception = false).status == 404
            @test HTTP.get("http://[::1]:$port/assets/imagery/../secret";
                           status_exception = false).status in (403, 404)

            # The one thing the viewer needs before it builds its globe.
            got = HTTP.WebSockets.open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            end
            @test got["params"]["imagery"] ==
                  Dict("url" => "assets/imagery/{z}/{x}/{y}.png", "layout" => "xyz",
                       "tiling" => "mercator", "maxLevel" => 2)
        finally
            stop_server(server)
        end
    end
end

@testitem "a server with no imagery directory answers nothing under the mount" setup=[FreePort] begin
    using HTTP

    port = freeport()
    server = start_server(; dist_dir = nothing, host = "::1", port, imagery = :none)
    try
        @test server.imagery === false
        @test !haskey(server.asset_dirs, "imagery")
        @test CesiumLink.mount_for(server, "/assets/imagery/0/0/0.png") === nothing
        @test HTTP.get("http://[::1]:$port/assets/imagery/0/0/0.png";
                       status_exception = false).status == 404
    finally
        stop_server(server)
    end
end

@testitem "the discovery file names where the basemap tiles are" setup=[Pyramid] begin
    using JSON

    mktempdir() do runtime
        # The real runtime directory belongs to the user's own sessions. Point the discovery
        # directory at a temporary one for this test, and put it back afterwards.
        was = get(ENV, "XDG_RUNTIME_DIR", nothing)
        ENV["XDG_RUNTIME_DIR"] = runtime
        entry(server) = JSON.parse(read(server.discovery_file, String))
        served(imagery) = (s = start_server(; dist_dir = nothing, imagery);
                           try entry(s) finally stop_server(s) end)
        try
            mktempdir() do tiles
                # A reader that hosts the page itself builds the page before it opens a socket, so
                # it cannot learn the basemap from the declaration. It reads this instead.
                pyramid(tiles)
                @test served(tiles)["imagery"] == tiles

                # A URL travels as it stands: the reader takes the host out of it, and lets the
                # page load images from that host and no other.
                url = "https://example.invalid/tiles/{z}/{x}/{y}.png"
                @test served(url)["imagery"] == url

                # No basemap names no tiles, and neither does a globe with no base layer.
                @test !haskey(served(nothing), "imagery")
                @test !haskey(served(:none), "imagery")
            end
        finally
            was === nothing ? delete!(ENV, "XDG_RUNTIME_DIR") : (ENV["XDG_RUNTIME_DIR"] = was)
        end
    end
end
