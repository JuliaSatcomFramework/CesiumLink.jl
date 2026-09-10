# The graticule and the globe's depth setting reach the viewer as Core declarations, so what a test
# has to pin is the wire spelling of one and the refusals that keep a bad spacing off it. The
# geometry the spacing becomes is the viewer's, and `lib/core/src/globe.test.mjs` checks it there.

@testitem "a graticule declaration carries the whole set, in the wire's spelling" begin
    using CesiumLink: graticule_payload

    p = graticule_payload(; spacing = 20, color = "#33333340", width = 1, labels = true,
                          label_color = "#222222d0", label_font = "12px system-ui",
                          altitude_m = 30_000)
    @test p == (; lon = 20.0, lat = 20.0, color = "#33333340", width = 1.0, labels = true,
                labelColor = "#222222d0", labelFont = "12px system-ui", altitudeM = 30_000.0)

    # One number is both families; a pair states the meridians and the parallels apart. A `Pair` and
    # a tuple say the same thing, since a scene writes the spacing whichever way reads better there.
    @test graticule_payload(; spacing = (30, 10), color = "#333", width = 2, labels = false,
                            label_color = "#222", label_font = "10px sans-serif",
                            altitude_m = 0).lon == 30.0
    for s in ((30, 10), [30, 10], 30 => 10)
        p2 = graticule_payload(; spacing = s, color = "#333", width = 1, labels = true,
                               label_color = "#222", label_font = "12px system-ui",
                               altitude_m = 1000)
        @test (p2.lon, p2.lat) == (30.0, 10.0)
    end

    # Off is a state, not an absence: the declaration still travels, and it says there is no
    # graticule rather than saying nothing at all.
    off = graticule_payload(; spacing = nothing, color = "#333", width = 1, labels = true,
                            label_color = "#222", label_font = "12px system-ui", altitude_m = 30_000)
    @test off.lon === nothing && off.lat === nothing
    @test keys(off) == keys(p)
end

@testitem "a graticule refuses a spacing that would not draw" begin
    using CesiumLink: graticule_payload

    grat(; kw...) = graticule_payload(; spacing = 20, color = "#333", width = 1, labels = true,
                                      label_color = "#222", label_font = "12px system-ui",
                                      altitude_m = 30_000, kw...)

    # Every line is a primitive, so a tenth of a degree is 3,600 meridians and a page that no longer
    # answers the camera.
    @test_throws "meridians of a graticule stand 1.0° to 180° apart" grat(spacing = 0.1)
    @test_throws "parallels of a graticule stand 1.0° to 90° apart" grat(spacing = (20, 120))
    @test_throws "meridians of a graticule stand 1.0° to 180° apart" grat(spacing = -20)
    @test_throws "a graticule spacing is finite" grat(spacing = NaN)
    @test_throws "one number of degrees, or (lon, lat)" grat(spacing = (10, 20, 30))
    @test_throws "or `nothing` for no graticule" grat(spacing = "20")

    @test_throws "a graticule line is at least one pixel wide" grat(width = 0)
    @test_throws "a graticule stands at or above the ellipsoid" grat(altitude_m = -1)
end

@testitem "the graticule and the globe depth are retained declarations" setup=[Furnished] begin
    server = start_server(; host = "::1", port = 0)
    try
        declare_graticule(server; spacing = (20, 10))
        @test declared(server, "core", "graticule")["lon"] == 20

        # Each call is a whole statement, so a keyword the second call does not name is back at its
        # default rather than carrying over from the first.
        declare_graticule(server; spacing = 5, color = "#ff0000")
        p = declared(server, "core", "graticule")
        @test (p["lon"], p["lat"], p["color"]) == (5, 5, "#ff0000")
        declare_graticule(server; spacing = 5)
        @test declared(server, "core", "graticule")["color"] == "#33333340"

        # The reader who takes the lines off gets a retained declaration saying so, so a browser
        # connecting later comes back to a globe with no graticule rather than to the last one drawn.
        declare_graticule(server; spacing = nothing)
        @test declared(server, "core", "graticule")["lon"] === nothing

        declare_globe_depth(server)
        @test declared(server, "core", "globe-depth")["on"] == true
        declare_globe_depth(server, false)
        @test declared(server, "core", "globe-depth")["on"] == false
    finally
        stop_server(server)
    end
end
