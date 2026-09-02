@testitem "a node family carries positions, and appearance in whichever form it varies" setup=[Wire] begin
    using CesiumLink: Nodes, primitives_payload, decode_arrays

    pos = Array{Float32}(undef, 3, 2, 4)                   # 3 x N x keyframes
    pos .= 1
    f = Nodes(:sat; position = pos, size = 12, color = (60, 190, 255, 255),
              marker = :star, scale_by_distance = (1.5e6, 1.0, 3.0e7, 0.35))
    p, region = lowered(primitives_payload(f))
    p = p["nodes"][1]
    @test p["kind"] == "sat"
    @test p["marker"] == "star"
    @test p["size"] == 12
    @test p["position"]["shape"] == [4, 2, 3]              # row-major: the reverse of Julia's
    # A lone value covers the family, and travels as a flat array of its own.
    @test p["color"]["shape"] == [4]
    @test decode_arrays(p["color"], region) == UInt8[60, 190, 255, 255]
    # Four plain numbers, not an encoded array: the module reads them straight.
    @test p["scaleByDistance"] == [1.5e6, 1.0, 3.0e7, 0.35]
    # A knob nobody set is absent rather than null, so "was it delivered?" is the key's presence.
    @test !haskey(p, "show")
    @test !haskey(p, "label")

    # Per entity, and per entity per keyframe.
    static = Nodes(:user; position = Float32[1 2; 3 4; 5 6], size = Float32[9, 9],
                   color = rand(UInt8, 4, 2), show = [true, false], label = ["a", "b"])
    q, region = lowered(primitives_payload(static))
    q = q["nodes"][1]
    @test q["position"]["shape"] == [2, 3]
    @test q["color"]["shape"] == [2, 4]
    @test q["label"] == ["a", "b"]
    @test decode_arrays(q["show"], region) == UInt8[1, 0]

    switched = Nodes(:sat; position = pos, color = rand(UInt8, 4, 2, 4))
    r = first(lowered(primitives_payload(switched)))["nodes"][1]
    @test r["color"]["shape"] == [4, 2, 4]
end

@testitem "a node family draws a supplied image as readily as a stock glyph" setup=[Wire] begin
    using CesiumLink: Nodes, primitives_payload, marker_image

    png = tempname() * ".png"
    write(png, b"\x89PNG\r\n\x1a\n")
    uri = marker_image(png)
    @test startswith(uri, "data:image/png;base64,")

    a = Nodes(:sat; position = zeros(Float32, 3, 2), marker = uri)
    p = first(lowered(primitives_payload(a)))["nodes"][1]
    @test p["marker"] == uri

    # The extension picks the type, and a format no browser is sure to draw is refused.
    svg = tempname() * ".svg"
    write(svg, "<svg/>")
    @test startswith(marker_image(svg), "data:image/svg+xml;base64,")
    @test_throws ".png, .svg" marker_image("satellite.gif")
    # The other two forms a marker takes. Julia checks the shape of the name and passes it on: what
    # a served file resolves to, and what a browser module registered, are known in the viewer only.
    b = Nodes(:sat; position = zeros(Float32, 3, 2), marker = "assets/sprites/sat.png")
    @test first(lowered(primitives_payload(b)))["nodes"][1]["marker"] == "assets/sprites/sat.png"
    c = Nodes(:sat; position = zeros(Float32, 3, 2), marker = "orbits.pulse")
    @test first(lowered(primitives_payload(c)))["nodes"][1]["marker"] == "orbits.pulse"
end

@testitem "a node family's shapes are checked where they are built" begin
    using CesiumLink: Nodes

    pos = zeros(Float32, 3, 2, 4)
    @test_throws "position is 3 × N" Nodes(:sat; position = zeros(Float32, 2, 5))
    @test_throws "sat.marker is one of" Nodes(:sat; position = pos, marker = :blob)
    @test_throws "2 labels for 3 entities" Nodes(:sat; position = zeros(Float32, 3, 3),
                                                 label = ["a", "b"])
    # A size that is neither a lone value, one per entity, nor one per entity per keyframe.
    @test_throws "none of the forms" Nodes(:sat; position = pos, size = Float32[1, 2, 3])
    @test_throws "none of the forms" Nodes(:sat; position = pos, color = rand(UInt8, 3, 2))
    # Two arrays of the same family describing different runs of keyframes.
    @test_throws "describes 3 keyframes, another of its arrays 4" Nodes(:sat; position = pos,
                                                                        size = rand(Float32, 2, 3))
end

@testitem "a node family draws its labels in the style it names, or in the default one" setup=[Wire] begin
    using CesiumLink: Nodes, Label, primitives_payload, decode_arrays

    pos = zeros(Float32, 3, 2)
    styled = Nodes(:city; position = pos,
                   label = Label(["Roma", "Oslo"]; align = (:center, :bottom), offset = (0, -18),
                                 font = "16px serif", color = (255, 209, 102, 255),
                                 background = "#00000088",
                                 scale_by_distance = (1.0e6, 1.0, 2.0e7, 0.5),
                                 fade_by_distance = (1.0e6, 1.0, 2.0e7, 0.0),
                                 show_between = (0, 5.0e6)))
    p, region = lowered(primitives_payload(styled))
    l = p["nodes"][1]["label"]
    @test l["text"] == ["Roma", "Oslo"]
    @test l["align"] == ["center", "bottom"]
    @test l["offset"] == [0, -18]
    @test l["font"] == "16px serif"
    # The colours travel encoded, in the form the family's own colour knob travels in.
    @test decode_arrays(l["color"], region) == UInt8[255, 209, 102, 255]
    @test decode_arrays(l["background"], region) == UInt8[0, 0, 0, 136]
    # Four plain numbers each, as the family's `scale_by_distance` sends.
    @test l["scaleByDistance"] == [1.0e6, 1.0, 2.0e7, 0.5]
    @test l["fadeByDistance"] == [1.0e6, 1.0, 2.0e7, 0.0]
    @test l["showBetween"] == [0, 5.0e6]

    # A style that names none of the optional fields carries none of them, and the rest hold today's
    # look: 13 px sans-serif, bottom left of the text 14 px above the node.
    default = first(lowered(primitives_payload(Nodes(:city; position = pos,
                                                     label = Label(["a", "b"])))))
    d = default["nodes"][1]["label"]
    @test d["align"] == ["left", "bottom"]
    @test d["offset"] == [0, -14]
    @test d["font"] == "13px sans-serif"
    @test !haskey(d, "color")
    @test !haskey(d, "background")
    @test !haskey(d, "showBetween")

    # The shorthand: a plain vector means that same style, and travels as the array it always has.
    plain = first(lowered(primitives_payload(Nodes(:city; position = pos, label = ["a", "b"]))))
    @test plain["nodes"][1]["label"] == ["a", "b"]

    # One text per entity, in whichever form the labels arrive.
    @test_throws "3 labels for 2 entities" Nodes(:city; position = pos,
                                                 label = Label(["a", "b", "c"]))
end

@testitem "a label style is checked where it is built" begin
    using CesiumLink: Label

    @test_throws "Label.align is one of" Label(["a"]; align = (:middle, :bottom))
    @test_throws "Label.align is one of" Label(["a"]; align = (:left, :under))
    @test_throws "Label.align is one of" Label(["a"]; align = :left)
    @test_throws "Label.offset is (x_px, y_px)" Label(["a"]; offset = (1, 2, 3))
    @test_throws "Label.offset is (x_px, y_px)" Label(["a"]; offset = ("a", "b"))
    @test_throws "(near_m, near_scale, far_m, far_scale)" Label(["a"]; scale_by_distance = (1, 2))
    # A range the camera crosses the wrong way round draws nothing at all, so it is refused here.
    @test_throws "near metres below its far ones" Label(["a"]; show_between = (5.0e6, 1.0e6))
    @test_throws "near metres below its far ones" Label(["a"];
                                                        fade_by_distance = (2.0e7, 1, 1.0e6, 0))
    @test_throws "a colour tuple" Label(["a"]; color = (300, 0, 0))
end

@testitem "an edge family joins two endpoint families, with per-edge appearance" setup=[Wire] begin
    using CesiumLink: Edges, Nodes, primitives_payload, decode_arrays

    sats = Nodes(:sat; position = zeros(Float32, 3, 4))
    gws = Nodes(:gw; position = zeros(Float32, 3, 2))
    e = Edges(:isl; from = :sat, to = :sat, pairs = [1 2; 3 4],
              style = [:glow, :solid], width = Float32[2.5, 1.0], dash_length = 16)
    p, region = lowered(primitives_payload(sats, e))
    p = p["edges"][1]
    @test (p["kind"], p["from"], p["to"]) == ("isl", "sat", "sat")
    # 1-based in Julia, 0-based on the wire — the module indexes the node arrays with these.
    @test vec(decode_arrays(p["pairs"], region)) == UInt32[0, 2, 1, 3]
    @test p["pairs"]["shape"] == [2, 2]
    @test decode_arrays(p["style"], region) == UInt8[2, 0]        # :glow, :solid
    @test p["dashLength"] == 16

    # A whole family in one stock style is a number, not an array.
    one = Edges(:feeder; from = :gw, to = :sat, pairs = [1; 2;;], style = :dashed)
    @test first(lowered(primitives_payload(gws, sats, one)))["edges"][1]["style"] == 1
    # A family drawn in stock materials alone sends no style table at all.
    @test !haskey(first(lowered(primitives_payload(sats, e)))["edges"][1], "styles")

    # A style may also arrive as the code itself, per family or per edge, which is the spelling the
    # wire carries and the one a caller reaches for after it has read a code back.
    codes = Edges(:num; from = :sat, to = :sat, pairs = [1 2; 3 4], style = UInt8[0, 2])
    q, region = lowered(primitives_payload(sats, codes))
    @test decode_arrays(q["edges"][1]["style"], region) == UInt8[0, 2]
    lone = Edges(:lone; from = :sat, to = :sat, pairs = [1; 2;;], style = 2)
    @test first(lowered(primitives_payload(sats, lone)))["edges"][1]["style"] == 2
end

@testitem "an edge style names a custom material, and the family carries the table" setup=[Wire] begin
    using CesiumLink: Edges, Nodes, primitives_payload, decode_arrays

    sats = Nodes(:sat; position = zeros(Float32, 3, 4))
    e = Edges(:isl; from = :sat, to = :sat, pairs = [1 2 3; 3 4 1],
              style = [:glow, "orbits.pulse", "orbits.pulse"])
    p, region = lowered(primitives_payload(sats, e))
    p = p["edges"][1]
    # The stock codes keep the front of the table, so a stock style keeps the code it always had.
    @test p["styles"] == [nothing, nothing, nothing, "orbits.pulse"]
    @test decode_arrays(p["style"], region) == UInt8[2, 3, 3]

    # One table for the whole family, however many keyframes name the material.
    frames = [[1 2; 3 4], reshape([1, 2], 2, 1)]
    per = Edges(:link; from = :sat, to = :sat, pairs = frames,
                style = [[:solid, "orbits.pulse"], ["orbits.pulse"]])
    q, region = lowered(primitives_payload(sats, per))
    q = q["edges"][1]
    @test q["styles"] == [nothing, nothing, nothing, "orbits.pulse"]
    @test decode_arrays(q["style"][2], region) == UInt8[3]

    # Julia checks the form of the name and passes any well-formed one on. A bare name that names
    # no stock material is neither a form nor a stock style, so it is refused here.
    @test_throws "owner-namespaced name" Edges(:isl; from = :sat, to = :sat, pairs = [1; 2;;],
                                               style = :squiggle)
end

@testitem "edge connectivity may change per keyframe, and its knobs change with it" setup=[Wire] begin
    using CesiumLink: Edges, Nodes, primitives_payload, decode_arrays

    ends = (Nodes(:user; position = zeros(Float32, 3, 4)),
            Nodes(:sat; position = zeros(Float32, 3, 4)))
    frames = [[1 2; 3 4], reshape([1, 2], 2, 1)]           # two edges, then one
    e = Edges(:link; from = :user, to = :sat, pairs = frames,
              color = [rand(UInt8, 4, 2), rand(UInt8, 4, 1)])
    p = first(lowered(primitives_payload(ends..., e)))["edges"][1]
    @test length(p["pairs"]) == 2
    @test p["pairs"][2]["shape"] == [1, 2]
    @test p["color"][1]["shape"] == [2, 4]
    @test p["color"][2]["shape"] == [1, 4]

    @test_throws "has 1 keyframes, its connectivity 2" Edges(:link; from = :user, to = :sat,
        pairs = frames, width = [Float32[1, 1]])
    @test_throws "none of the forms" Edges(:link; from = :user, to = :sat, pairs = frames,
        width = [Float32[1, 1], Float32[1, 1]])
    @test_throws "2 × M matrix" Edges(:link; from = :user, to = :sat, pairs = [1 2 3])
    @test_throws "1-based node indices" Edges(:link; from = :user, to = :sat, pairs = [0 1; 1 2])
end

@testitem "an area family is geometry on a replacing window and attributes on the rest" setup=[Wire] begin
    using CesiumLink: Areas, primitives_payload, decode_arrays, rgba

    centers = [12.5 4.4; 41.9 52.0]                        # 2 x N, degrees
    a = Areas(:cell; center = centers, radius = 12_000, sides = 6, height_m = 3000,
              color = rgba(["#000000", "#ffffff"], [0.0, 1.0]), outline = "#000000d9",
              show = [true, false])
    p, region = lowered(primitives_payload(a))
    p = p["areas"][1]
    @test p["sides"] == 6
    @test p["heightM"] == 3000
    @test p["center"]["shape"] == [2, 2]
    @test p["radius"] == 12_000
    @test decode_arrays(p["outline"], region) == UInt8[0, 0, 0, 217]
    @test decode_arrays(p["show"], region) == UInt8[1, 0]

    # A window bringing no centres leaves the standing footprints alone and only recolours them.
    later = Areas(:cell; color = rgba(["#000000", "#ffffff"], [1.0, 0.0]))
    q = first(lowered(primitives_payload(later)))["areas"][1]
    @test !haskey(q, "center")
    @test !haskey(q, "sides")
    @test haskey(q, "color")

    # One height for the family, or one per footprint.
    tiered = Areas(:cell; center = centers, radius = 12_000, height_m = [3000, 9000])
    t, tiered_region = lowered(primitives_payload(tiered))
    @test decode_arrays(t["areas"][1]["heightM"], tiered_region) == Float32[3000, 9000]
    @test_throws "none of the forms" Areas(:cell; center = centers, height_m = [1, 2, 3])

    @test_throws "at least 3 sides" Areas(:cell; center = centers, sides = 2)
    @test_throws "2 × N degrees" Areas(:cell; center = [1.0 2.0 3.0])
    @test_throws "none of the forms" Areas(:cell; center = centers, show = [true, false, true])
    # Radius describes geometry, so it cannot travel without the centres it sizes.
    @test_throws "rides only a window that carries" Areas(:cell; radius = 12_000)

    # How a footprint meets the globe is decided from its span, so nothing travels until it is forced.
    @test !haskey(p, "drape")
    forced = Areas(:cell; center = centers, radius = 400_000, drape = false)
    f = first(lowered(primitives_payload(forced)))["areas"][1]
    @test f["drape"] == false
    @test_throws "true or false" Areas(:cell; center = centers, drape = "yes")
    @test_throws "rides only a window that carries" Areas(:cell; drape = true)

    # The mesh cell is the caller's to set, and the viewer's default travels as no key at all.
    @test !haskey(p, "meshDeg")
    fine = Areas(:cell; center = centers, radius = 400_000, mesh_deg = 0.25)
    @test first(lowered(primitives_payload(fine)))["areas"][1]["meshDeg"] == 0.25
    # Both bounds lead to a tessellation the browser does not come back from, so both are refused.
    @test_throws "between 0.01 and 180.0" Areas(:cell; center = centers, mesh_deg = 0)
    @test_throws "between 0.01 and 180.0" Areas(:cell; center = centers, mesh_deg = -1)
    @test_throws "between 0.01 and 180.0" Areas(:cell; center = centers, mesh_deg = 1e-6)
    @test_throws "between 0.01 and 180.0" Areas(:cell; center = centers, mesh_deg = 360)
    @test_throws "between 0.01 and 180.0" Areas(:cell; center = centers, mesh_deg = Inf)
    # `drape` is the neighbouring keyword and it is the one that takes a `true`.
    @test_throws "so it is a number" Areas(:cell; center = centers, mesh_deg = true)
    @test_throws "so it is a number" Areas(:cell; center = centers, mesh_deg = "fine")
    @test_throws "rides only a window that carries" Areas(:cell; mesh_deg = 2)
end

@testitem "an area family draws the boundary it is given, and checks every ring of it" setup=[Wire] begin
    using CesiumLink: Areas, primitives_payload, decode_arrays

    square = [0.0 10.0 10.0 0.0; 0.0 0.0 10.0 10.0]     # 2 x V, degrees, and open
    hole = [4.0 6.0 6.0 4.0; 4.0 4.0 6.0 6.0]
    triangle = [20.0 30.0 25.0; 0.0 0.0 10.0]

    a = Areas(:region; boundary = [[square, hole], triangle], height_m = 3000,
              color = rand(UInt8, 4, 2))
    p, region = lowered(primitives_payload(a))
    p = p["areas"][1]
    # One entry per region, each a list of rings, and the vertex counts differ between them.
    @test length(p["boundary"]) == 2
    @test length(p["boundary"][1]) == 2
    @test p["boundary"][1][1]["shape"] == [4, 2]         # row-major: the reverse of Julia's
    @test p["boundary"][2][1]["shape"] == [3, 2]
    # (lon_min, lon_max, lat_min, lat_max) per region, which is where the module reads each span.
    @test vec(decode_arrays(p["extent"], region)) == [0, 10, 0, 10, 20, 30, 0, 10]
    @test p["heightM"] == 3000
    # A boundary computes no footprint, so the keys that describe one do not travel.
    @test !haskey(p, "center")
    @test !haskey(p, "sides")
    @test !haskey(p, "radius")

    # The entity count comes from the regions, so a knob is sized against them.
    @test_throws "none of the forms" Areas(:region; boundary = [square, triangle],
                                           show = [true, false, true])

    # A boundary is the footprint. What computes one has nothing to do.
    @test_throws "both center and boundary" Areas(:region; center = zeros(2, 1), boundary = [square])
    @test_throws "sizes a computed footprint" Areas(:region; boundary = [square], radius = 12_000)
    @test_throws "counts the corners" Areas(:region; boundary = [square], sides = 6)

    # Structure, since nothing downstream checks it: the browser draws garbage and says nothing.
    @test_throws "2 × V degrees" Areas(:region; boundary = [[0.0 10.0; 0.0 0.0; 5.0 5.0]])
    @test_throws "at least 3 vertices" Areas(:region; boundary = [[0.0 10.0; 0.0 0.0]])
    @test_throws "not finite" Areas(:region; boundary = [[0.0 10.0 NaN; 0.0 0.0 10.0]])
    @test_throws "carries no ring" Areas(:region; boundary = [[]])
    @test_throws "one entry per region" Areas(:region; boundary = square)

    # Co-located consecutive vertices, which Cesium throws on. `==` is not the test. Two vertices
    # can hold distinct numbers and still be co-located: ±180° is one meridian, and every longitude
    # at a pole is the same point.
    @test_throws "are co-located" Areas(:region;
        boundary = [[0.0 10.0 10.0 20.0; 0.0 0.0 0.0 10.0]])
    @test_throws "are co-located" Areas(:region;
        boundary = [[-180.0 -90.0 0.0 90.0 180.0; 45.0 45.0 45.0 45.0 45.0]])
    # A polar cap written as a box carries the pole twice, as the wrap-around pair, which counts
    # because the ring closes itself.
    @test_throws "are co-located" Areas(:region;
        boundary = [[0.0 0.0 90.0 90.0; 90.0 20.0 20.0 90.0]])

    # A hole outside the ring it is a hole in: rings given in the wrong order, and the one silent
    # mistake the bounding boxes catch.
    @test_throws "lies outside ring 1" Areas(:region; boundary = [[hole, square]])
    @test_throws "lies outside ring 1" Areas(:region; boundary = [[square, triangle]])

    # A boundary carries its span in `extent`, so it too is measured rather than told.
    @test !haskey(p, "drape")
    b = Areas(:region; boundary = [square], drape = true)
    @test first(lowered(primitives_payload(b)))["areas"][1]["drape"] == true
end

@testitem "a payload carries any mix of families, each named once" begin
    using CesiumLink: Nodes, Edges, Areas, primitives_payload

    sats = Nodes(:sat; position = zeros(Float32, 3, 2))
    users = Nodes(:user; position = zeros(Float32, 3, 3))
    links = Edges(:link; from = :user, to = :sat, pairs = [1; 1;;])
    cells = Areas(:cell; center = zeros(2, 4))

    p = primitives_payload(sats, users, links, cells)
    @test keys(p) == (:nodes, :edges, :areas)
    @test length(p.nodes) == 2
    @test [f.kind for f in p.nodes] == ["sat", "user"]

    @test keys(primitives_payload(sats)) == (:nodes,)
    # Two families of one kind would have the module drawing one over the other.
    @test_throws "both named \"sat\"" primitives_payload(sats, sats)
    # A node family and an edge family may share a name; they are different families.
    @test keys(primitives_payload(sats, Edges(:sat; from = :sat, to = :sat,
                                              pairs = [1; 2;;]))) == (:nodes, :edges)
end

@testitem "an edge hangs off a Nodes or an Areas family, and the payload must carry it" begin
    sats = Nodes(:sat; position = zeros(Float32, 3, 2))
    cells = Areas(:cell; center = zeros(2, 4))

    # A link from a ground cell to a satellite is one family over one of each — an area contributes
    # its footprint centre where a node contributes its position.
    user = Edges(:user; from = :cell, to = :sat, pairs = [1 4; 2 1])
    @test keys(primitives_payload(sats, cells, user)) == (:nodes, :edges, :areas)

    # An endpoint the payload does not carry would reach the viewer as a family drawing nothing.
    @test_throws "carries no Nodes or Areas family for" primitives_payload(sats, user)
    @test_throws "\"gw\"" primitives_payload(sats, cells, user,
                                          Edges(:feeder; from = :gw, to = :sat, pairs = [1; 1;;]))

    # Where the endpoint states how many entities it has, the indices are checked against it: the
    # renderer drops an index past the end rather than drawing it, which is a silent wrong scene.
    @test_throws "indexes past the 4 entities of \"cell\"" primitives_payload(
        sats, cells, Edges(:user; from = :cell, to = :sat, pairs = [5; 1;;]))
    @test_throws "indexes past the 2 entities of \"sat\"" primitives_payload(
        sats, cells, Edges(:user; from = :cell, to = :sat, pairs = [[1; 1;;], [1; 3;;]]))

    # An append addresses standing footprints and restates neither their centres nor their number,
    # so there is nothing there to check an index against.
    @test keys(primitives_payload(sats, Areas(:cell; color = (1, 2, 3, 4)),
                                  Edges(:user; from = :cell, to = :sat, pairs = [99; 1;;]))) ==
          (:nodes, :edges, :areas)
end

@testitem "a vendored module is declared like anyone else's" begin
    using CesiumLink: vendored, viewer_dist, module_url

    dist = viewer_dist()
    if isfile(joinpath(dist, "modules", "primitives", "primitives.js"))
        entry = vendored(:primitives)
        @test entry.id == "primitives"
        @test module_url(entry) == "/modules/primitives/primitives.js"
    end
    @test_throws "no vendored module" vendored(:nosuchmodule)
end
