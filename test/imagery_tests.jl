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

    # The pyramid inside the viewer is what a backing draws. If it backed itself, one texture
    # would sit on the globe twice.
    @test_throws "cannot ask" Imagery(; bundled = true, backing = true)
    # It carries no URL either: the page builds the one it answers on.
    @test_throws "carries no URL" Imagery("u"; bundled = true)
    @test_throws "needs a URL" Imagery()
end

@testitem "a basemap says what the country borders under it wear" begin
    # The right colour depends on what lies under the line, so the style belongs to the basemap.
    @test (Imagery("u").border_color, Imagery("u").border_width) == ("#ffffff8c", 2.0)
    styled = Imagery("u"; border_color = "rgba(0,0,0,0.6)", border_width = 1.5)
    @test (styled.border_color, styled.border_width) == ("rgba(0,0,0,0.6)", 1.5)
    # An integer width is a width, and the field carries it as a float.
    @test Imagery("u"; border_width = 3).border_width === 3.0

    # The browser parses the colour, so the only string worth refusing here is one that names
    # nothing at all.
    @test_throws "not empty" Imagery("u"; border_color = "")
    # A line of zero pixels is a line nobody sees, and a negative one is no width at all.
    @test_throws "positive" Imagery("u"; border_width = 0)
    @test_throws "positive" Imagery("u"; border_width = -1.0)
end

@testitem "the border style travels on every entry of the set" begin
    # The viewer restyles the borders for whatever entry the reader picks, so it needs the whole
    # style of each one. An absent field would leave it guessing.
    d, _ = CesiumLink.resolve_imagery([Imagery("https://host/{z}/{x}/{y}.png";
                                               border_color = "#0000008c", border_width = 3.0),
                                       KNOWN_EARTH_BASEMAPS.offline_natural_earth])
    @test [(e.borderColor, e.borderWidth) for e in d] == [("#0000008c", 3.0), ("#3a3a3ab3", 2.0)]
    # The pyramid inside the viewer carries the style as every other entry does, although it
    # carries no URL.
    @test last(d).bundled == true
    @test all(haskey(e, :borderColor) && haskey(e, :borderWidth)
              for e in first(CesiumLink.resolve_imagery(nothing)))
end

@testitem "the three states of `imagery` are three different declarations" begin
    # Absent, no base layer, and a named set are three declarations. An absent one on Earth is the
    # default set, which the reader picks within. `:none` draws no base layer at all.
    d, dir = CesiumLink.resolve_imagery(nothing)
    @test length(d) == 6
    @test dir === nothing
    # The default set is of Earth, so a session on another body declares nothing and keeps the
    # texture the viewer bundles. Earth's coastlines on a Moon globe are a picture that lies.
    @test CesiumLink.resolve_imagery(nothing, (a = 1737400.0, b = 1737400.0)) == (nothing, nothing)
    @test CesiumLink.resolve_imagery(:none) == (false, nothing)
    # A symbol that is not `:none` is a typo, and would otherwise be declared as a URL.
    @test_throws "`:none`" CesiumLink.resolve_imagery(:None)
    # An empty set has no basemap, which is what `:none` says in one word.
    @test_throws "at least one basemap" CesiumLink.resolve_imagery(Imagery[])
end

@testitem "the basemaps this package knows are ready to declare" begin
    @test length(collect(KNOWN_EARTH_BASEMAPS)) == 6
    # A name this package ships carries its attribution, so a source that asks for one has it.
    @test all(!isempty, (KNOWN_EARTH_BASEMAPS.aster_colour_relief.credit,
                         KNOWN_EARTH_BASEMAPS.aster_grey_relief.credit,
                         KNOWN_EARTH_BASEMAPS.emodnet_baselayer.credit,
                         KNOWN_EARTH_BASEMAPS.blue_marble.credit,
                         KNOWN_EARTH_BASEMAPS.blue_marble_relief.credit))
    # EMODnet asks for its licence in the line. Carry it as the source states it.
    @test KNOWN_EARTH_BASEMAPS.emodnet_baselayer.credit == "EMODnet Bathymetry (CC BY 4.0)"
    # A WMTS REST path names the tile row before the tile column, and EMODnet names the column
    # first. A template reaches the browser as it stands, so a swapped pair draws a scrambled globe
    # rather than an error.
    @test all(endswith("{z}/{y}/{x}.jpeg"), (KNOWN_EARTH_BASEMAPS.aster_colour_relief.url,
                                             KNOWN_EARTH_BASEMAPS.aster_grey_relief.url))
    @test endswith(KNOWN_EARTH_BASEMAPS.emodnet_baselayer.url, "{z}/{x}/{y}.png")
    # The pyramid inside the viewer is the one entry with neither a URL nor a credit. It is
    # public domain, and the page builds the URL it answers on.
    offline = KNOWN_EARTH_BASEMAPS.offline_natural_earth
    @test offline.bundled && isempty(offline.url) && offline.credit === nothing

    # The catalogue holds six, and an absent `imagery` declares all six. Entry 1 is what the
    # globe wears at startup, and the pyramid inside the viewer closes the set for the reader to
    # fall back on.
    d, _ = CesiumLink.resolve_imagery(nothing)
    @test [get(e, :name, nothing) for e in d] == ["ASTER Colour Relief", "ASTER Grey Relief",
                                                   "Blue Marble", "Blue Marble Relief",
                                                   "EMODnet Baselayer", "Natural Earth"]
    @test last(d) == (; bundled = true, key = "offline_natural_earth", name = "Natural Earth",
                      borderColor = "#3a3a3ab3", borderWidth = 2.0)
    @test first(d).backing == true
    # The viewer reads the icon and the drop-down category off `key`, so every catalogue basemap
    # carries one. A match by label would hand a renamed basemap the fallback icon instead.
    @test [e.key for e in d] == ["aster_colour_relief", "aster_grey_relief", "blue_marble",
                                 "blue_marble_relief", "emodnet_baselayer", "offline_natural_earth"]
end

@testitem "a known basemap names the border colour that reads on it" begin
    # The two Blue Marbles are photographs, dark under a white line. ASTER Grey Relief is a pale
    # map of the land, so its line is black rather than dark grey. Checked on the resolved wire
    # declaration, because that is what the viewer restyles the borders from.
    d, _ = CesiumLink.resolve_imagery(collect(KNOWN_EARTH_BASEMAPS))
    by_key = Dict(e.key => e.borderColor for e in d)
    @test by_key["blue_marble"] == "#ffffff8c"
    @test by_key["blue_marble_relief"] == "#ffffff8c"
    @test by_key["aster_grey_relief"] == "#0000008c"
end

@testitem "a basemap set is refused when the viewer could not draw it" setup=[Pyramid] begin
    moon = (a = 1737400.0, b = 1737400.0)
    # A backing draws the pyramid inside the viewer, which is of Earth. Julia knows the ellipsoid
    # before the session declares anything, so the mismatch is impossible rather than forbidden.
    @test_throws "may not ask for one on this ellipsoid" start_server(;
        dist_dir = nothing, listen = false, ellipsoid = moon,
        imagery = KNOWN_EARTH_BASEMAPS.blue_marble)
    # The bundled pyramid is that same Earth texture, so naming it directly is refused too. Without
    # this the picker would offer a Moon reader a row that draws Earth's coastlines.
    @test_throws "may not stand on this ellipsoid" start_server(;
        dist_dir = nothing, listen = false, ellipsoid = moon,
        imagery = KNOWN_EARTH_BASEMAPS.offline_natural_earth)
    @test_throws "may not stand on this ellipsoid" CesiumLink.resolve_imagery(
        ["https://host/moon/{z}/{x}/{y}.png", KNOWN_EARTH_BASEMAPS.offline_natural_earth], moon)
    # A basemap of the body itself asks for no backing, so the server declares it.
    server = start_server(; dist_dir = nothing, listen = false, ellipsoid = moon,
                          imagery = "https://host/moon/{z}/{x}/{y}.png")
    try
        @test length(server.imagery) == 1
    finally
        stop_server(server)
    end

    # One server serves one `imagery` mount, so one set holds at most one directory of tiles.
    mktempdir() do a
        mktempdir() do b
            pyramid(a)
            pyramid(b)
            @test_throws "at most one directory" CesiumLink.resolve_imagery([a, b])
        end
    end
end

@testitem "a URL is declared as it stands and never fetched" begin
    template = "https://example.invalid/tiles/{z}/{x}/{y}.png"
    # `example.invalid` resolves nowhere. This test passes because `start_server` makes no request:
    # a source that answers nothing is found by the browser, not here.
    d, dir = CesiumLink.resolve_imagery(template)
    @test dir === nothing
    # One basemap is a set of one, so the wire shape does not change with the size of the set. A
    # basemap an author built is in no catalogue, so it declares no `key`.
    @test d == [(; url = template, layout = "xyz", tiling = "mercator",
                 borderColor = "#ffffff8c", borderWidth = 2.0)]

    d, _ = CesiumLink.resolve_imagery(Imagery(template; tiling = :geographic, max_level = 7,
                                              credit = "USGS"))
    @test only(d) == (; url = template, layout = "xyz", tiling = "geographic", maxLevel = 7,
                      credit = "USGS", borderColor = "#ffffff8c", borderWidth = 2.0)

    # A set keeps the order the author gave it, because entry 1 is what the globe wears at startup.
    d, _ = CesiumLink.resolve_imagery([KNOWN_EARTH_BASEMAPS.blue_marble_relief,
                                       KNOWN_EARTH_BASEMAPS.offline_natural_earth])
    @test [e.name for e in d] == ["Blue Marble Relief", "Natural Earth"]
end

@testitem "an XYZ directory is sniffed, probed and mounted relative" setup=[Pyramid] begin
    mktempdir() do dir
        pyramid(dir; depth = 2)
        d, mounted = CesiumLink.resolve_imagery(dir)
        @test mounted == dir
        # The URL is relative, which is what makes the mount same-origin with the page: an absolute
        # one would need a CORS header from wherever it pointed.
        @test only(d) == (; url = "assets/imagery/{z}/{x}/{y}.png", layout = "xyz",
                          tiling = "mercator", maxLevel = 2, borderColor = "#ffffff8c",
                          borderWidth = 2.0)

        # The probe reads the deepest level on disk; a stated maximum wins over it.
        d, _ = CesiumLink.resolve_imagery(Imagery(dir; max_level = 1, tiling = :geographic))
        @test only(d) == (; url = "assets/imagery/{z}/{x}/{y}.png", layout = "xyz",
                          tiling = "geographic", maxLevel = 1, borderColor = "#ffffff8c",
                          borderWidth = 2.0)

        # A file whose name is not a number is not a level.
        write(joinpath(dir, "readme.txt"), "not a level")
        mkpath(joinpath(dir, "thumbnails"))
        @test only(first(CesiumLink.resolve_imagery(dir))).maxLevel == 2
    end
end

@testitem "an XYZ directory declares a URL that names one tile at a time" setup=[Pyramid] begin
    # The declaration is the template Cesium requests verbatim, so a URL with no placeholder in it
    # asks for the mount root once per tile and draws nothing. Assert what the string has to do,
    # and not only what it reads: every tile of a level must come out as a URL of its own.
    mktempdir() do dir
        pyramid(dir; depth = 1)
        url = only(first(CesiumLink.resolve_imagery(dir))).url
        asked(z, x, y) = replace(url, "{z}" => string(z), "{x}" => string(x), "{y}" => string(y))
        @test length(unique(asked(z, x, y) for z in 0:1, x in 0:1, y in 0:1)) == 8
        # And the URL a tile is asked by is the file the mount holds.
        @test isfile(joinpath(dir, asked(1, 1, 1)[length("assets/imagery/") + 1:end]))
    end

    # The name is read from a tile that is there. gdal2tiles writes `.jpg` for a pyramid with no
    # transparency, and a `.png` template would ask that pyramid for files it does not hold.
    mktempdir() do dir
        pyramid(dir; ext = "jpg")
        @test only(first(CesiumLink.resolve_imagery(dir))).url == "assets/imagery/{z}/{x}/{y}.jpg"
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
        @test only(d) == (; url = "assets/imagery/", layout = "tms", credit = "USGS",
                          borderColor = "#ffffff8c", borderWidth = 2.0)

        # Stating one anyway is a misunderstanding worth a line: the file decides, and the stated
        # scheme is dropped rather than declared.
        @test_logs (:warn, r"tilemapresource.xml` decides") begin
            d, _ = CesiumLink.resolve_imagery(Imagery(dir; tiling = :geographic))
            @test !haskey(only(d), :tiling)
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
    # A set travels as a list, whatever its size: the viewer reads entry 1 as what the globe wears.
    @test params(; imagery = [(; url = "assets/imagery/", layout = "tms")])["imagery"] ==
          [Dict("url" => "assets/imagery/", "layout" => "tms")]
end

@testitem "the mount serves a tile and refuses a path that climbs out of it" setup=[Pyramid, FreePort, WsOpen] begin
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
            got = ws_open("ws://[::1]:$port/ws") do ws
                HTTP.WebSockets.send(ws, JSON.json((; method = "ready",
                                                    params = (; protocol = CesiumLink.PROTOCOL_VERSION))))
                JSON.parse(CesiumLink.unpack(HTTP.WebSockets.receive(ws)).header)
            end
            @test got["params"]["imagery"] ==
                  [Dict("url" => "assets/imagery/{z}/{x}/{y}.png", "layout" => "xyz",
                        "tiling" => "mercator", "maxLevel" => 2,
                        "borderColor" => "#ffffff8c", "borderWidth" => 2.0)]
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

                # A set names the first entry that carries a URL, because that is the one the page
                # sends a reader to. The default set starts with ASTER Colour Relief.
                @test startswith(served(nothing)["imagery"],
                                 "https://gibs.earthdata.nasa.gov/")

                # A globe with no base layer has no tiles.
                @test !haskey(served(:none), "imagery")
            end
        finally
            was === nothing ? delete!(ENV, "XDG_RUNTIME_DIR") : (ENV["XDG_RUNTIME_DIR"] = was)
        end
    end
end
