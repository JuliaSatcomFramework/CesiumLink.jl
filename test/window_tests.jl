@testitem "a window message carries the range, the run, its identity and a payload per module" setup=[DemoWindow] begin
    using CesiumLink: window_message
    using JSON

    f = window_message(Dict(:tracks => demo_payloads()[:tracks], :ui => (; title = "t"));
                       start_frame = 5, count = 2, dt_seconds = 60, total_frames = 240,
                       start_time = "2026-07-26T10:00:00Z", mode = :append, window = 3)
    m = JSON.parse(f.header)
    @test m["method"] == "window"
    p = m["params"]
    @test p["startFrame"] == 4            # 1-based in Julia, 0-based on the wire
    @test p["count"] == 2
    @test p["mode"] == "append"
    @test p["window"] == 3
    @test p["totalFrames"] == 240         # the declared range, whatever this window covers
    @test p["dtSeconds"] == 60
    @test p["intervalSeconds"] == 1.5
    @test p["startTime"] == "2026-07-26T10:00:00Z"
    # One message, every module's payload, addressed by name.
    @test sort(collect(keys(p["payloads"]))) == ["tracks", "ui"]
    @test p["payloads"]["ui"]["title"] == "t"
    # Arrays anywhere inside a payload travel self-describing, so a module needs no schema to decode.
    pos = p["payloads"]["tracks"]["position"]
    @test pos["\$wire"] == "f32"
    @test pos["shape"] == [2, 2, 3]       # row-major: the reverse of Julia's 3×2×2
    @test pos["off"] == 0
    @test reinterpret(Float32, f.blobs) == Float32.(1:12)

    # `startTime` is omitted, not null, when absent — the viewer then picks a synthetic epoch.
    m2 = JSON.parse(window_message(Dict(:tracks => (;));
                                   start_frame = 1, count = 1, dt_seconds = 60,
                                   total_frames = 1).header)
    @test !haskey(m2["params"], "startTime")
    @test m2["params"]["mode"] == "replace"
    @test m2["params"]["count"] == 1      # a static scene is a window of one frame
end

@testitem "a window is bounded by the declared range and joins one of two ways" setup=[DemoWindow] begin
    using CesiumLink: window_message
    args = (; dt_seconds = 60, total_frames = 20)
    @test_throws "runs past the declared range" window_message(Dict(:m => (;));
        start_frame = 20, count = 2, args...)
    @test_throws "must be :replace or :append" window_message(Dict(:m => (;));
        start_frame = 1, count = 1, mode = :merge, args...)
    @test_throws "1-based absolute index" window_message(Dict(:m => (;));
        start_frame = 0, count = 1, args...)
    @test_throws "at least one keyframe" window_message(Dict(:m => (;));
        start_frame = 1, count = 0, args...)
end

@testitem "a window carries the overlay's per-keyframe values" begin
    using CesiumLink: window_message, decode_arrays
    using JSON

    # Per widget id, per field, one value per keyframe the window covers: what the `ui` module
    # applies to the widget that declared the field keyframed, on each crossing.
    tracks = Dict(:load => (; text = ["4.2 Gbps", "5.0 Gbps"], max = [12.0, 20.0],
                             busy = [true, false]))
    f = window_message(Dict(:ui => (; tracks));
                       start_frame = 3, count = 2, dt_seconds = 60, total_frames = 240)
    wire = JSON.parse(f.header)["params"]["payloads"]["ui"]["tracks"]["load"]
    # A track of numbers or flags travels as a typed array, the same as any other payload array.
    @test wire["max"]["\$wire"] == "f64"
    @test wire["busy"]["\$wire"] == "u8"

    load = decode_arrays(wire, f.blobs)
    @test load["text"] == ["4.2 Gbps", "5.0 Gbps"]
    @test load["max"] == [12.0, 20.0]
    @test load["busy"] == UInt8[1, 0]
end
