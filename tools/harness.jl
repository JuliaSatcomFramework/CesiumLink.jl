#!/usr/bin/env julia
# Server half of the regression harness. Serves the built viewer from a live CesiumLink server,
# installs the `Constellation` example scene over the WebSocket, drives `tools/harness.mjs` against
# it, and merges what only this side can see — what the scene contains — into one report.
#
# One server, one page per host, measured one after the other. Each host reports under its own key
# in that report, and the counts they drew the scene with must agree.
#
# The browser half needs a server behind it; this is the one that exists for the numbers that need a
# transport: bytes actually sent over the socket, and the round trip from a viewer event to the
# command batch answering it.
#
#   julia --project=tools tools/harness.jl --out tools/baseline/harness.json
#
# Every option other than those consumed here is passed straight through to the browser half.

using CesiumLink
using Constellation: ConstellationScene, CHUNK_FRAMES
using JSON

const ROOT = normpath(joinpath(@__DIR__, ".."))

# The `Constellation` example, at a size of the harness's own: a denser lattice than the
# documentation builds, so a lost batch has more entities to turn into one draw command each. The
# scene is computed from constants and nothing in it reads the clock, so two runs draw the same
# thing and the counts below are comparable across releases.
#
# Raising this changes the scene, so it fails `check_entities` by design. Record a new baseline when
# you change it, and say in the commit why the gate moved.
const HARNESS_LATTICE = 40_000

# The mission is exactly one window long, so the whole of it is delivered before any page connects.
#
# Warning: do not lengthen it. The example delivers a longer mission a chunk at a time, and a page
# playing it asks for the next chunk as it goes. The two hosts are measured one after the other
# against one server, so the first host's playback would leave the second one a different retained
# window — and a family whose membership changes per keyframe then reports a different count. The
# hosts would disagree over how the scene was delivered rather than over how it was drawn.
const HARNESS_FRAMES = CHUNK_FRAMES

# The hosts this harness measures, each on its own page and each under its own key in the report.
const HOSTS = ("browser", "vscode")

"""
    page_url(server, host) -> String

The page `host` is measured on. Headless Chrome cannot open a webview, so the VSCode host is
measured on a page that loads the same bundle behind a stub of the webview channel.
"""
page_url(server, host) =
    host == "browser" ? viewer_url(server) :
    replace(viewer_url(server), "/?ws=auto" => "/vscode-harness.html")

"""
    check_hosts_agree(report) -> Bool

Compare the draw-command count each host reported. A host reaches the same Core over a different
transport, from a different asset base, and through a rewritten module URL. The number of draw
commands it draws the scene with is what says all three still agree, and a difference is a defect
whatever the baseline says about either host on its own.
"""
function check_hosts_agree(report)
    medians = [report[h]["drawCommands"]["median"] for h in HOSTS]
    ok = all(==(first(medians)), medians)
    text = join(("$h $m" for (h, m) in zip(HOSTS, medians)), ", ")
    println(ok ? "  ok  hosts agree: $text draw commands" :
                 "FAIL  hosts differ: $text draw commands")
    return ok
end

"""
    entity_counts(frame) -> Dict{String,Int}

What the scene a `window` frame describes *contains*, one count per family — as opposed to how a
renderer chooses to draw it. Read from the shapes of the arrays the payload carries, so it survives
the thing drawing them being replaced, and it is what makes two runs comparable.

An edge family whose membership changes per keyframe is counted at the window's first keyframe: one
number per family is what a baseline can be compared against, and the first frame is the one every
window has.
"""
function entity_counts(frame)
    payload = CesiumLink.decode_arrays(
        JSON.parse(frame.header)["params"]["payloads"]["primitives"], frame.blobs)
    counts = Dict{String,Int}()
    for f in get(payload, "nodes", ())
        counts[f["kind"]] = size(f["position"], 2)
    end
    for f in get(payload, "areas", ())
        # An append addresses standing footprints and restates neither their centres nor their
        # number, so only a window carrying geometry says how many there are.
        haskey(f, "center") && (counts[f["kind"]] = size(f["center"], 2))
    end
    for f in get(payload, "edges", ())
        # One array of pairs for the whole window, or one per keyframe where membership changes.
        p = f["pairs"]
        counts[f["kind"]] = size(p isa AbstractMatrix ? p : first(p), 2)
    end
    return counts
end

"""
    check_entities(baseline_path, entities) -> Bool

Compare the scene this run measured against the one the baseline recorded. A mismatch means the two
reports describe different scenes, so every number below is being compared across a change nobody
asked about — a shorter run has fewer draw commands and would otherwise read as an improvement.
A baseline predating entity counts is reported and not failed; there is nothing to compare it to.
"""
function check_entities(baseline_path, entities)
    base = get(JSON.parse(read(baseline_path, String)), "entities", nothing)
    if base === nothing
        println("  --  scene: baseline records no entity counts (informational)")
        return true
    end
    ok = base == entities
    if ok
        println("  ok  scene matches: " * join(("$k $(entities[k])" for k in sort(collect(keys(entities)))), ", "))
    else
        differs = [k for k in sort(collect(union(keys(base), keys(entities))))
                   if get(base, k, nothing) != get(entities, k, nothing)]
        println("FAIL  scene differs: " *
                join(("$k $(get(base, k, "absent")) → $(get(entities, k, "absent"))" for k in differs), ", "))
    end
    return ok
end

function main(argv)
    out = nothing
    check = nothing
    passthrough = String[]
    i = firstindex(argv)
    while i <= lastindex(argv)
        if argv[i] == "--out"
            out = argv[i + 1]
            i += 2
        elseif argv[i] == "--check"
            # Read, but also passed on: the browser half polices the draw-command count against the
            # same file.
            check = argv[i + 1]
            append!(passthrough, argv[i:(i + 1)])
            i += 2
        else
            push!(passthrough, argv[i])
            i += 1
        end
    end

    scene_ok = true
    hosts_agree = true
    dist = joinpath(ROOT, "lib", "dist")
    # On the default port, which the operating system picks: nothing outside this run has to reach
    # the server, and two harness runs at once must not collide on one number.
    # This scene belongs to the headless browser below, and to nobody's screen.
    server = start_server(; dist_dir = dist, title = "regression harness", open = false)
    try
        # Every hover the viewer sends is answered here: this is what the browser half times the
        # round trip of. The subscription the viewer forwards against is derived from this
        # registration.
        on_pointer(server; type = :hover) do ev, reply
            if ev.entity === nothing
                command!(reply, "ui", "tooltip", (; html = nothing))
            else
                tooltip!(reply) do io
                    print(io, "<b>", ev.entity.kind, " ", ev.entity.idx, "</b><br>frame ", ev.frame)
                end
            end
            return nothing
        end

        # Installed before any client connects, so the server retains the scene and sends it on
        # connect — the viewer receives it exactly as it would a live push.
        serve_scene!(server, ConstellationScene(; lattice = HARNESS_LATTICE,
                                               total_frames = HARNESS_FRAMES))
        held = findfirst(p -> first(p) == ("core", "window"), server.retained)
        held === nothing && error("the example scene landed no window")
        entities = entity_counts(last(server.retained[held]))

        harness_mjs = joinpath(ROOT, "tools", "harness.mjs")
        report = Dict{String,Any}()
        for host in HOSTS
            println("\n=== the $host host ===")
            host_json = tempname()
            run(setenv(
                `node $harness_mjs --url $(page_url(server, host)) --key $host $passthrough --out $host_json`;
                dir = ROOT))
            report[host] = JSON.parse(read(host_json, String))
            rm(host_json; force = true)
        end

        report["entities"] = entities
        hosts_agree = check_hosts_agree(report)

        # Each run of the browser half has already policed that host's draw-command count and
        # exited non-zero if it regressed; what only this side can answer is whether the runs drew
        # the same scene. The verdict is carried out of the block rather than exited on, so the
        # server still stops.
        if check !== nothing
            path = isabspath(check) ? check : joinpath(ROOT, check)
            scene_ok = check_entities(path, entities)
        end

        if out !== nothing
            path = isabspath(out) ? out : joinpath(ROOT, out)
            mkpath(dirname(path))
            open(path, "w") do io
                JSON.print(io, report, 2)
                println(io)
            end
            println("\nbaseline written to $out")
        end
    finally
        stop_server(server)
    end
    (scene_ok && hosts_agree) || exit(1)
end

main(ARGS)
