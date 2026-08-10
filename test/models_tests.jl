@testitem "a model family names its anchor, its file and the range it draws in" setup=[Wire] begin
    using CesiumLink: Models, models_payload, decode_arrays

    # A quaternion written as an array literal with one non-integer element is a `Float64` array, and
    # would carry twice the bytes it needs. The family converts it, and the wire tag is what says so.
    q = [0 0; 0 0; 0 0; 1 1.0]                             # 4 × 2, one quaternion per entity
    @test eltype(q) == Float64
    f = Models(:sat_body; of = :sat, uri = "assets/models/sat.glb", range = (0, 2e6),
               frame = :enu, orientation = q, axes = (90, 0, 0), scale = 1e6,
               minimum_pixel_size = 64, show = [true, false])
    p, region = lowered(models_payload(f))
    m = p["models"][1]
    @test (m["kind"], m["of"], m["uri"]) == ("sat_body", "sat", "assets/models/sat.glb")
    @test m["frame"] == "enu"
    # Two plain numbers and three plain numbers, not encoded arrays: the module reads them straight.
    @test m["range"] == [0, 2e6]
    @test m["axes"] == [90, 0, 0]
    @test m["scale"] == 1e6
    # A model a few metres across is smaller than a pixel at mission range, so the floor is what
    # lets it keep a true `scale` and still be seen.
    @test m["minimumPixelSize"] == 64
    @test m["orientation"]["shape"] == [2, 4]              # row-major: the reverse of Julia's
    @test m["orientation"]["\$wire"] == "f32"
    @test decode_arrays(m["show"], region) == UInt8[1, 0]

    # A knob nobody set is absent rather than null, so "was it delivered?" is the key's presence.
    plain = Models(:body; of = :sat, uri = "assets/models/sat.glb", range = (100, 1e7))
    b = first(lowered(models_payload(plain)))["models"][1]
    @test b["frame"] == "ecef"
    @test !any(k -> haskey(b, k),
                ("orientation", "axes", "scale", "minimumPixelSize", "show"))

    # One attitude covering the whole family, and one per entity per keyframe.
    lone = Models(:body; of = :sat, uri = "assets/models/sat.glb", range = (0, 1e6),
                  orientation = Float32[0, 0, 0, 1])
    @test first(lowered(models_payload(lone)))["models"][1]["orientation"]["shape"] == [4]
    over = Models(:body; of = :sat, uri = "assets/models/sat.glb", range = (0, 1e6),
                  orientation = rand(Float32, 4, 2, 3), show = rand(Bool, 2, 3))
    @test first(lowered(models_payload(over)))["models"][1]["orientation"]["shape"] == [3, 2, 4]
end

@testitem "a model family's file, range and frame are checked where it is built" begin
    using CesiumLink: Models

    at = (of = :sat, uri = "assets/models/sat.glb")

    # `range` has no default: the distance a model stops being worth its draw commands at is the
    # author's to choose, and there is no answer that suits every scene.
    @test_throws UndefKeywordError Models(:body; at...)
    @test_throws "near before far" Models(:body; at..., range = (2e6, 0))
    @test_throws "near before far" Models(:body; at..., range = (-1, 2e6))
    @test_throws "near before far" Models(:body; at..., range = 2e6)

    # Only the shape of the path is checked here; whether a mount of that name answers is read in
    # the browser, which is the only place that holds the map for its own host.
    @test_throws "assets/<name>/<rest>" Models(:body; of = :sat, uri = "models/sat.glb",
                                               range = (0, 1e6))
    @test_throws "assets/<name>/<rest>" Models(:body; of = :sat, uri = "assets/sat.glb",
                                               range = (0, 1e6))
    @test_throws "one of (:ecef, :enu, :nadir, :velocity)" Models(:body; at..., range = (0, 1e6),
                                                                  frame = :lvlh)

    # A floor of no pixels reads as set and does nothing, which is a typo for declaring none.
    @test_throws "positive number" Models(:body; at..., range = (0, 1e6), minimum_pixel_size = 0)
    @test_throws "positive number" Models(:body; at..., range = (0, 1e6), minimum_pixel_size = -8)
end

@testitem "a model family's knobs agree on the entities and the keyframes they describe" begin
    using CesiumLink: Models

    at = (of = :sat, uri = "assets/models/sat.glb", range = (0, 1e6))

    @test_throws "is a quaternion" Models(:body; at..., orientation = 1)
    @test_throws "none of the forms" Models(:body; at..., orientation = rand(Float32, 3, 2))
    # The family carries no positions, so its own arrays are all there is here to check the entity
    # count against. How many entities the anchor holds is read in the browser, from the anchor.
    @test_throws "describes 3 entities, another of its arrays 2" Models(:body; at...,
        orientation = rand(Float32, 4, 2), show = rand(Bool, 3))
    @test_throws "describes 2 keyframes, another of its arrays 3" Models(:body; at...,
        orientation = rand(Float32, 4, 2, 3), show = rand(Bool, 2, 2))
end

@testitem "a models payload is an envelope of its own, addressed to the models module" begin
    using CesiumLink: Models, models_payload

    body = Models(:body; of = :sat, uri = "assets/models/sat.glb", range = (0, 2e6))
    dish = Models(:dish; of = :sat, uri = "assets/models/dish.glb", range = (0, 5e5))

    # One key, and the envelope around it is `Dict(:models => …)` — beside the `primitives` payload
    # carrying the family both of these anchor to, and never inside it.
    payload = models_payload(body, dish)
    @test keys(payload) == (:models,)
    # A satellite body and an antenna that turns independently are two families over one anchor.
    @test [m.kind for m in payload.models] == ["body", "dish"]
    @test [m.of for m in payload.models] == ["sat", "sat"]

    @test_throws "both named \"body\"" models_payload(body, body)
end
