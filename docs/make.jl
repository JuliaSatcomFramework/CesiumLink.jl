const REPO_ROOT = normpath(joinpath(@__DIR__, ".."))
const SRC = joinpath(@__DIR__, "src")
const DIST = joinpath(REPO_ROOT, "lib", "dist")
const EXAMPLES = joinpath(REPO_ROOT, "examples")

# The package and the two example packages are all developed by relative path, so the code this
# build runs is the code in this tree. The paths live in the manifest, which is generated and never
# committed, so a fresh tree adds them here. Every missing one goes in on one call: a resolve that
# knows only some of the paths looks the rest up in a registry, where none of these is.
#
# This block runs before the first `using` of a dependency. Three of the five dependencies are
# local packages that no registry holds, so a fresh tree cannot instantiate this environment
# until the paths are known.
using Pkg
let paths = Dict("CesiumLink" => REPO_ROOT,
                 "Constellation" => joinpath(EXAMPLES, "Constellation"),
                 "RegionCount" => joinpath(EXAMPLES, "RegionCount")),
    missing_packages = filter(n -> Base.find_package(n) === nothing, sort(collect(keys(paths))))

    isempty(missing_packages) ||
        Pkg.develop([Pkg.PackageSpec(path = paths[n]) for n in missing_packages])
end
# A local package that gains a dependency leaves every manifest that names it stale, and the manifest
# here is generated and never committed. `resolve` rebuilds the graph from the project files; without
# it an existing tree fails at the first `using` with "does not have X in its dependencies".
Pkg.resolve()
Pkg.instantiate()

using Documenter, DocumenterVitepress
using CesiumLink

# Every ordered list DocumenterVitepress 0.3.5 writes is numbered from 2: its markdown writer labels
# the item at index `i` with `i + 1`. The number is the whole defect. A "2." line cannot interrupt
# the paragraph above it — CommonMark lets only a list starting at 1 do that — so the first item is
# also absorbed into that paragraph, and the reader sees a run-on sentence followed by a list that
# starts at 3.
#
# The body below is DocumenterVitepress PR 387, which is merged and unreleased. The method replaces
# the released one, and it is installed here rather than as a pass over the generated files because
# `makedocs` builds the Vitepress site itself when `CI` is set: there is no point after it at which
# the markdown is still what the site is built from. Delete the whole block once a release carries
# the fix.
function DocumenterVitepress.render(io::IO, mime::MIME"text/plain",
                                    node::Documenter.MarkdownAST.Node,
                                    list::Documenter.MarkdownAST.List, page, doc; kwargs...)
    bullet(i) = list.type === :ordered ? "$(i). " : "- "
    iob = IOBuffer()
    for (i, item) in enumerate(node.children)
        DocumenterVitepress.render(iob, mime, item, item.children, page, doc;
                                   prenewline = false, kwargs...)
        lines = split(String(take!(iob)), '\n')
        lines[2:end] .= "    " .* lines[2:end]
        body = join(lines, '\n')
        endswith(body, '\n') || (body *= "\n")
        print(io, bullet(i))
        print(io, body)
    end
end

# `make_demo_recording`: the session the live player on the recording page plays. Generated here
# rather than committed, so the scene in the documentation is always the one this tree produces.
include(joinpath(REPO_ROOT, "tools", "make-demo-recording.jl"))

# Every example runs during this build, so an example that throws fails it. A one-file example is
# included into a module of its own, so that two examples may use the same names.
#
# This build wants the functions of an example, not the program: it has an environment already and
# it drives its own server. `examples/setup.jl` reads this name and stands aside.
CESIUMLINK_LIBRARY_ONLY = true
const SOLAR = Module(:SolarElevation)
Base.include(SOLAR, joinpath(EXAMPLES, "solar_elevation.jl"))
const SATELLITES = Module(:Satellites)
Base.include(SATELLITES, joinpath(EXAMPLES, "Satellites", "run.jl"))
using Constellation
import RegionCount

function stage_external()
    stage_viewer()
    stage_examples()
    record_examples()
    record_tutorials()
    return nothing
end

# The two live pages, the assets they draw with, and the session the player plays: the recording
# player, and the browser page, which the basemap guide points at with `?imagery=` and `?ellipsoid=`
# so that its Moon globe needs no recording at all. The built viewer is copied out whole, less the
# VSCode host bundle, the workers only that host reads, and the source maps beside them, which is
# most of the tree by size. The recording is written here too, so nothing about the live scene is
# committed and it cannot drift from the code that produces it.
#
# Warning: build the viewer first. `npm run build` writes `dist/`, and a docs build without it
# leaves the player page blank rather than failing here.
function stage_viewer()
    out = joinpath(SRC, "public", "viewer")
    rm(out; recursive = true, force = true)
    rm(joinpath(SRC, "public", "recordings"); recursive = true, force = true)
    if !isdir(DIST)
        @warn "no built viewer at $DIST, so the documentation's live player will not load. \
               Run `npm run build` in `lib/`." maxlog = 1
        return nothing
    end
    # A few seconds of scene, written out of a server on an ephemeral port that nothing connects to.
    make_demo_recording(joinpath(SRC, "public", "recordings", "orbit.jsonl"); dist_dir = DIST)
    mkpath(out)
    # An exclusion filter, not a list of names: the two entry files import a chunk whose name
    # carries a hash, so a name this build does not know is a deployed page that loads nothing
    # while the build stays green. The filter reads the top level only, so `cesium/` and `modules/`
    # arrive whole, source maps and all.
    for name in readdir(DIST)
        endswith(name, ".map") && continue
        startswith(name, "vscode") && continue
        cp(joinpath(DIST, name), joinpath(out, name))
    end
    # `cesium/WorkersBundled` exists for the VSCode webview host alone: a `vscode-webview://` origin
    # cannot construct a cross-origin worker, so the build gives that host a self-contained copy of
    # every Cesium worker. This site deploys no webview host — the filter above drops `vscode.*` —
    # so no page here can fetch from that directory, and it is 13 MB of the 30 MB staged. A webview
    # page in the documentation needs this line removed.
    rm(joinpath(out, "cesium", "WorkersBundled"); recursive = true, force = true)
    return nothing
end

# An example page is prose written by hand, at `example-pages/`, with one `{{source}}` line in it.
# The listing that replaces the line is read off disk on every build, so the code the page shows is
# the code this build ran. It is the only part of the page that cannot drift from the example.
const EXAMPLE_SOURCE = Dict("solar-elevation.md" => "solar_elevation.jl",
                            "satellites.md" => "Satellites",
                            "constellation.md" => "Constellation",
                            "region-count.md" => "RegionCount")
const FENCE = Dict("jl" => "julia", "js" => "js", "md" => "markdown", "toml" => "toml")

function stage_examples()
    prose = joinpath(@__DIR__, "example-pages")
    out = joinpath(SRC, "examples")
    rm(out; recursive = true, force = true)
    mkpath(out)
    for name in sort(filter(endswith(".md"), readdir(prose)))
        page = read(joinpath(prose, name), String)
        src = get(EXAMPLE_SOURCE, name, nothing)
        src === nothing ||
            (page = replace(page, "{{source}}" => source_listing(joinpath(EXAMPLES, src))))
        write(joinpath(out, name), page)
    end
    return nothing
end

# Every file of an example, as a tree and one fenced block each. A single-file example gets no tree.
function source_listing(path)
    files = isdir(path) ? example_files(path) : [path]
    root = isdir(path) ? path : dirname(path)
    io = IOBuffer()
    if isdir(path)
        println(io, "```")
        println(io, basename(path), "/")
        for (i, f) in enumerate(files)
            println(io, i == lastindex(files) ? "└── " : "├── ", relpath(f, root))
        end
        println(io, "```\n")
    end
    hidden = false
    for f in files
        body = listing_body(f)
        hidden |= any(endswith(rstrip(l), HIDE_MARKER) for l in eachline(f))
        println(io, "#### `", relpath(f, root), "`\n")
        println(io, "```", get(FENCE, lowercase(lstrip(last(splitext(f)), '.')), ""))
        println(io, body)
        println(io, "```\n")
    end
    hidden && println(io, HIDE_NOTE)
    return String(take!(io))
end

# A data file goes on the page by its first lines only. The orbital elements of 60 satellites are 180
# lines that say the same thing sixty times, and the page is there to show the program.
const DATA_EXTENSIONS = (".tle",)
const DATA_HEAD_LINES = 6

# A line an example runs but the page leaves out, marked as Documenter marks one. The three lines
# every `run.jl` marks are what makes it run on its own — see `examples/setup.jl` — and they say
# nothing about the scene the page is there to show.
const HIDE_MARKER = "# hide"
const HIDE_NOTE = """
    !!! info "The listing leaves out three lines"
        `run.jl` also includes `examples/setup.jl`, activates the environment beside it, and calls
        `run_example()`. That is what makes the file run on its own — see
        [Run an example](@ref "Run an example").
    """

function listing_body(path)
    if !(last(splitext(path)) in DATA_EXTENSIONS)
        kept = filter(l -> !endswith(rstrip(l), HIDE_MARKER), readlines(path))
        # A removed line leaves the blank line beside it, and two of them leave a gap the file does
        # not have.
        return rstrip(replace(join(kept, "\n"), r"\n{3,}" => "\n\n"))
    end
    lines = readlines(path)
    length(lines) > DATA_HEAD_LINES || return join(lines, "\n")
    return join(lines[1:DATA_HEAD_LINES], "\n") *
           "\n… and $(length(lines) - DATA_HEAD_LINES) more lines"
end

# The manifest is resolved by the build and says nothing about the example, so it stays off the page.
function example_files(dir)
    files = sort([joinpath(root, f) for (root, _, names) in walkdir(dir) for f in names])
    return filter(f -> basename(f) != "Manifest.toml" && !(".git" in splitpath(f)), files)
end

# The scene each example builds, written out as the recording its page plays. A structural check
# stands between an example that draws nothing and a green build: a valid recording of an empty
# scene passes every other gate here.
function record_examples()
    if !isdir(DIST)
        @warn "no built viewer at $DIST, so the example pages carry no live scene." maxlog = 1
        return nothing
    end
    mkpath(joinpath(SRC, "public", "recordings"))

    record_example("solar-elevation.jsonl") do server
        scene = SOLAR.install_solar_scene!(server)
        @assert size(scene.values) == (180, 90)
        @assert length(scene.regions) == 5
        # Sun on both sides of the horizon, which is what makes the terminator visible.
        @assert minimum(scene.values) < 0 < maximum(scene.values)
    end

    # The lit globe, the sky and the basemap belong to this scene, so the recording is made off a
    # server declaring all three. A recording carries the declaration, so the played page gets them
    # back without a query string.
    record_example("satellites.jsonl";
                   after = (server, _) -> pull_windows(server, SATELLITES.CHUNK_FRAMES,
                                                       SATELLITES.TOTAL_FRAMES),
                   imagery = SATELLITES.IMAGERY, lighting = true, stars = true) do server
        scene = SATELLITES.SatelliteScene()
        SATELLITES.install_satellite_scene!(server, scene)
        @assert length(scene.names) == 60
        families = SATELLITES.window_families(scene, 1, SATELLITES.CHUNK_FRAMES)
        track = only(f for f in families if f isa Nodes && f.kind == "track")
        trail = only(f for f in families if f isa Edges)
        # The trail hangs off a node family nothing draws, and its segments join consecutive vertices
        # of one satellite. A layout that stops agreeing with the segments draws a cat's cradle
        # across the sky, and a recording of that is as valid as a recording of the trails.
        @assert size(track.position) == (3, 60 * length(SATELLITES.TRACK_OFFSETS),
                                         SATELLITES.CHUNK_FRAMES)
        @assert size(trail.pairs, 2) == 60 * (length(SATELLITES.TRACK_OFFSETS) - 1)
        return scene
    end
    assert_fills(joinpath(SRC, "public", "recordings", "satellites.jsonl"))

    record_example("constellation.jsonl"; after = pull_the_rest) do server
        scene = ConstellationScene()
        families = Constellation.window_families(scene, 1, Constellation.CHUNK_FRAMES)
        @assert length(families) == 6
        sats = only(f for f in families if f isa Nodes && f.kind == "sat")
        @assert size(sats.position, 2) == length(scene.propagators) == 40
        # A cell is served only while a satellite stands over it, so a keyframe with no user link at
        # all is a scene that has regressed into an empty sky — which a valid recording of it hides.
        users = only(f for f in families if f isa Edges && f.kind == "user")
        @assert all(m -> size(m, 2) ≥ 1, users.pairs)
        serve_scene!(server, scene)
    end
    assert_fills(joinpath(SRC, "public", "recordings", "constellation.jsonl"))

    # Replaying a recording runs no listener, so a click in the played page reaches nobody. The
    # command the click produces is recorded and does replay, and it comes from the same function
    # the listener calls, so the frame on the wire is the one a real click makes.
    record_example("region-count.jsonl";
                   after = (server, scene) -> RegionCount.answer!(server, scene, 1)) do server
        scene = serve_scene!(server, RegionCount.Satellites())
        @assert length(scene.regions) == 2
        counts = RegionCount.counts_over(scene, 1)
        @assert length(counts) == size(scene.subpoint, 3)
        # A chart of nothing but zeros is what an example that stops drawing looks like.
        @assert maximum(counts) > 0
        # The module and the chart library beside it are staged into a directory of the scene's own,
        # and the recording names the module by that path. The player rebuilds the URL from the
        # module id, so both files are put where it looks for them.
        cp(scene.served, joinpath(SRC, "public", "viewer", "modules", "regioncount"); force = true)
        return scene
    end

    return nothing
end

# The tutorials whose finished scene a page plays. Tutorials 4 and 5 build a viewer module of their
# own, which this build does not compile, so they have no player.
const PLAYED_TUTORIALS = ["first-scene", "moving-scene", "controls"]

# Every played tutorial's own listing, run and then recorded. This is the only thing that runs a line
# of tutorial code, so a tutorial that stops working fails the build here.
function record_tutorials()
    if !isdir(DIST)
        @warn "no built viewer at $DIST, so the tutorial pages carry no live scene." maxlog = 1
        return nothing
    end
    mkpath(joinpath(SRC, "public", "recordings"))
    for name in PLAYED_TUTORIALS
        page = joinpath(SRC, "tutorials", "$name.md")
        rec = joinpath(SRC, "public", "recordings", "$name.jsonl")
        # The listing starts a server of its own, on a port the operating system picks, and binds it
        # to `server`. Each one runs in a module of its own, because all three use the same names.
        mod = Module(Symbol(name))
        Base.include_string(mod, whole_script(page), page)
        # `invokelatest`, because the include is what creates the binding: a plain `mod.server` reads
        # it from the world this function was compiled in, where it does not exist yet.
        server = Base.invokelatest(getproperty, mod, :server)
        try
            record!(server, rec)
            stop_recording!(server)
        finally
            stop_server(server)
        end
        # A recording of a scene that draws nothing is a valid recording, and it passes every other
        # gate in this build.
        @assert any(contains("\"method\":\"window\""), eachline(rec))
    end
    return nothing
end

# The listing under a tutorial's "The whole script" heading. The page holds the code, so what this
# build runs is what the reader copies, down to the character.
function whole_script(page)
    m = match(r"## The whole script\s+```julia\n(.*?)\n```"s, read(page, String))
    m === nothing && error("$(basename(page)) carries no listing under \"The whole script\"")
    return m[1]
end

# Ask the constellation for the rest of its mission by the route a viewer's own `core/need` takes, so
# the recording exercises the listener the example ships rather than a path written for it here. The
# recording is open by now, so each window lands at its own offset and the page fills as it plays.
pull_the_rest(server, scene) =
    pull_windows(server, Constellation.CHUNK_FRAMES, scene.total_frames)

function pull_windows(server, chunk, total_frames)
    for first_frame in (chunk + 1):chunk:total_frames
        sleep(1)
        CesiumLink.request_window(server, first_frame, chunk, :append)
    end
    return nothing
end

# The recording of a scene delivered a chunk at a time holds several windows: one that stands on its
# own, then an append for every chunk after it. One window alone is an example that has quietly gone
# back to sending the whole mission at once, which every other check here passes.
function assert_fills(path)
    modes = [match(r"\"mode\":\"(\w+)\"", line)[1]
             for line in eachline(path) if occursin("\"method\":\"window\"", line)]
    @assert length(modes) > 1
    @assert all(==("append"), modes[2:end])
    return nothing
end

# One example, recorded off a server of its own. A recording is written out of what a server retains,
# so two examples sharing one server would put the first one's furniture and overlay in the second
# one's recording. `build` installs the scene and asserts its shape; nothing ever connects to the
# port.
# `after` runs with the recording already open, so what it sends is written at its own offset
# rather than into the standing scene at offset zero.
function record_example(build, name; after = (server, scene) -> nothing, server_args...)
    server = start_server(; dist_dir = DIST, host = "127.0.0.1", port = 0, server_args...)
    try
        scene = build(server)
        record!(server, joinpath(SRC, "public", "recordings", name))
        after(server, scene)
        stop_recording!(server)
    finally
        stop_server(server)
    end
    return nothing
end

stage_external()

makedocs(;
    modules = [CesiumLink, CesiumLink.Primitives, CesiumLink.UI, CesiumLink.Heatmap,
               CesiumLink.ModelFamilies, CesiumLink.Ellipsoids],
    authors = "Alberto Mengali",
    repo = Documenter.Remotes.GitHub("JuliaSatcomFramework", "CesiumLink.jl"),
    sitename = "CesiumLink",
    format = DocumenterVitepress.MarkdownVitepress(;
        repo = "github.com/JuliaSatcomFramework/CesiumLink.jl",
        devbranch = "main",
        devurl = "dev",
        # Vitepress runs from here in CI only, because the deploy at the end of this file needs the
        # generated site. A local build stops at the Markdown, which `npm run docs:dev` serves.
        build_vitepress = get(ENV, "CI", "false") == "true",
    ),
    clean = get(ENV, "DOCS_CLEAN", "true") == "true",
    pages = [
        "Home" => "index.md",
        "Tutorials" => [
            "tutorials/index.md",
            "1 · Your first scene" => "tutorials/first-scene.md",
            "2 · A scene that moves" => "tutorials/moving-scene.md",
            "3 · A control the server answers" => "tutorials/controls.md",
            "4 · Write a viewer module" => "tutorials/first-module.md",
            "5 · Ship a module from a Julia package" => "tutorials/package-with-module.md",
        ],
        "How-to guides" => [
            "how-to/index.md",
            "Draw points, lines and areas" => "how-to/primitives.md",
            "Show a value on hover" => "how-to/tooltips.md",
            "Put controls in the overlay" => "how-to/overlay-controls.md",
            "Put a box on screen" => "how-to/floating.md",
            "Choose the on-screen furniture" => "how-to/furniture.md",
            "Drape a scalar field over the globe" => "how-to/heatmap.md",
            "Put your own model on a satellite" => "how-to/models.md",
            "Work in map coordinates" => "how-to/coordinates.md",
            "Send large arrays" => "how-to/large-arrays.md",
            "Deliver a long mission a piece at a time" => "how-to/lazy-delivery.md",
            "Show a scene with no clock" => "how-to/static-scene.md",
            "Choose what the globe is textured with" => "how-to/basemap.md",
            "Give a recording a tour" => "how-to/camera-tour.md",
            "Write a module with no build step" => "how-to/no-build-module.md",
            "Show a scene in a VSCode tab" => "how-to/vscode-tab.md",
            "Show a scene in a notebook cell" => "how-to/slate-cell.md",
            "Record and replay a session" => "how-to/record-replay.md",
            "Look at what the wire carried" => "how-to/inspect-the-wire.md",
        ],
        "Reference" => [
            "reference/index.md",
            "Julia" => [
                "The server" => "reference/server.md",
                "Windows and scenes" => "reference/windows.md",
                "Events and commands" => "reference/events.md",
                "Primitives vocabulary" => "reference/primitives.md",
                "UI vocabulary" => "reference/ui.md",
                "Heatmap vocabulary" => "reference/heatmap.md",
                "Models vocabulary" => "reference/models.md",
                "Furniture and regions" => "reference/furniture.md",
                "The camera" => "reference/camera.md",
                "Colours" => "reference/colormap.md",
                "Coordinates" => "reference/geodesy.md",
                "Recording" => "reference/recorder.md",
                "Wire codec" => "reference/codec.md",
            ],
            "JavaScript" => [
                "Module API" => "reference/wire/module-api.md",
                "Wire protocol" => "reference/wire/protocol.md",
            ],
        ],
        "Explanation" => [
            "explanation/index.md",
            "The shape of the system" => "explanation/architecture.md",
            "Windows, keyframes and identity" => "explanation/windows.md",
            "Why the server decides" => "explanation/server-authoritative.md",
            "Modules, vocabularies and glue" => "explanation/modules.md",
            "Arrays on the wire" => "explanation/arrays.md",
            "Glossary" => "explanation/glossary.md",
        ],
        "Examples" => [
            "examples/index.md",
            "1 · Solar elevation" => "examples/solar-elevation.md",
            "2 · Satellite trails" => "examples/satellites.md",
            "3 · Constellation" => "examples/constellation.md",
            "4 · Satellites over a region" => "examples/region-count.md",
        ],
    ],
)

# `forcepush` amends the last commit on `gh-pages` instead of adding one, so the branch keeps one
# snapshot of the site. `gh-pages` is generated output, and it grows fast: `record_frame!` stamps
# every frame from the wall clock, so each build writes about 1.2 MB of recordings that differ from
# the last set byte for byte. A plain `git clone` fetches every branch, so that weight is paid by
# everyone who clones. This branch is the one place where a force push is correct.
#
# `DocumenterVitepress.deploydocs`, and never Documenter's own: a Vitepress site is not relocatable,
# so one `makedocs` writes a whole site per base into `build/1`, `build/2` and so on, and names them
# in `build/bases.txt`. Documenter's function knows nothing of that layout. It deploys the build
# directory whole, which puts the site one level down at `dev/1/` and leaves `dev/` itself a 404.
#
# `push_preview` puts a pull request's site at `previews/PR<n>/`, so a reviewer reads the page rather
# than the Markdown that makes it. A deploy leaves those directories where they are — Documenter
# skips `previews` when it clears the branch — and `DocPreviewCleanup.yml` removes one when its pull
# request closes. A pull request from a fork gets no preview: it carries no token that may write.
DocumenterVitepress.deploydocs(;
    repo = "github.com/JuliaSatcomFramework/CesiumLink.jl",
    devbranch = "main",
    forcepush = true,
    push_preview = true,
)
