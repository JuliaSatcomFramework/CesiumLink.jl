# Headless regression harness

An objective gate for renderer work. It draws the `Constellation` example scene in server-local
headless Chrome, at a fixed camera and a fixed keyframe, and reports the numbers a regression would
move.

The scene is drawn by the vendored `primitives` module, whose batching is the reason the view is
usable at these entity counts. A renderer can draw the right pixels through ten times the draw calls
and pass every visual check; nothing else in the tree would notice. That is what the draw-command
count is here for.

## Running it

```sh
cd lib && npm run build                                   # the harness draws dist/, not the sources
node ../tools/harness.mjs --url 'http://host:port/?ws=auto'   # against a server you started
```

With a live CesiumLink server, so the wire and the round trip are real:

```sh
julia --project=tools tools/harness.jl --out tools/baseline/harness.json
```

`harness.jl` serves `lib/dist` itself, installs the scene over the WebSocket, runs `harness.mjs`
against it, and merges what the scene contains into the same report. Every option it does not consume
is passed through.

`tools/Project.toml` is the environment it runs in: `CesiumLink` and `Constellation`, each by the
path it has in this repository.

`--out` and `--check` take a path relative to the repository root, whatever directory you run from:
both halves of the harness resolve them the same way.

One server, two hosts. `harness.jl` measures the browser host and then the VSCode host against the
same server, and each host reports under its own key — `browser` and `vscode` — in one baseline file.
`--key HOST` is what tells `harness.mjs` which of them a run is compared against.

The VSCode host is measured on `lib/dist/vscode-harness.html`. Headless Chrome cannot open a webview, so
that page loads the same bundle behind a stub of the webview channel, which bridges the channel to a
real WebSocket. It exercises the transport, the `hello` handshake, the import of a declared module
and the worker shim. It does not reproduce cross-origin isolation, so a pass here says the host
draws the scene and says nothing about the webview's own sandbox.

Chrome is driven over CDP (`--remote-debugging-port`) the way the docs tooling already does. No
Puppeteer.

## What it measures, and what each number is worth

| Number | Worth |
|---|---|
| **Draw commands per rendered frame** | The one that matters. `scene.frameState.commandList.length` is a CPU-side property of how primitives are batched, so it is exact on a machine with no GPU. `--check` gates on it |
| Scene fingerprint | Primitive, billboard and polyline counts, so a baseline diff cannot silently compare two different scenes. `--check` gates on it |
| Bytes on the wire per payload | Exact. Counted at the socket and at `fetch`, before the viewer parses anything. **Meaningful since arrays left base64** (ADR-0016): a jump back up means arrays have found their way into the header again |
| JS ms per interpolation tick | Real work on a real CPU, but the harness host is not isolated — treat a change under ~20% as noise |
| Round trip, request → answer | Measured with the render loop stopped, so it is server plus loopback and nothing else |
| `scene.pick` ms | Rendering a pick pass, which here is software-rasterised. Only comparable against another run on this host |

**Frames per second and frame time are meaningless here and are not measured.** This host has no
GPU; Chrome renders through SwiftShader, a software rasteriser. Nothing in the harness asserts on
them, and nothing should.

A running viewer's *perceived* latency also waits for the main thread, which SwiftShader holds far
longer than a real machine would — measured here as a 157 ms round trip with the render loop running
against 1.3 ms with it stopped. The end-to-end click→pixel figure still needs a real client, and the
RTT to this host measured separately so it can be subtracted.

## The scene it draws

`harness.jl` installs the `Constellation` example, at a lattice of 40 000 points rather than the 4000
the documentation builds. The example computes everything from constants — the epoch is fixed and
nothing in it reads the clock — so two runs draw the same satellites, the same cells and the same
links, and the numbers below are comparable across releases.

The scene is drawn by the vendored `primitives` module. A denser lattice is what gives the gate
something to lose: a renderer that stops batching turns one draw command per family into one per
entity, and the more entities there are, the louder that is.

`HARNESS_LATTICE` in `tools/harness.jl` is the one knob. Raising it changes the scene, so
`check_entities` fails by design — record a new baseline and say in the commit why the gate moved.

The mission is one window long, and that is load-bearing. The example delivers a longer mission a
chunk at a time, and a page playing it asks for the next chunk as it goes. The two hosts are
measured one after the other against one server, so a lazily delivered mission leaves the second
host a different retained window than the first — and the two-host check then reports a difference
in how the scene was delivered rather than in how it was drawn.

`tools/decode-frame.jl` prints what any frame carries — a `.bin` frame, or one line of a recording:

```
julia --project=. tools/decode-frame.jl tools/baseline/golden-frame.bin
```

It prints the header as formatted JSON and one line per array, with its dtype, shape, offset and a
sample of its values. The wire is binary, so this is what `less` used to give for free.

## The baseline

`tools/baseline/` holds captured runs. `--check` diffs a fresh run against one of them, and
`harness:check` names `harness.json`.

`harness.json` holds one run per host under its own key, and the entity counts of the scene both of
them drew. The scene reaches the browser by being declared and pushed over the WebSocket, which is
the only way to measure it: measuring it any other way measures a path the viewer does not have.

The file records the renderer string and the capture time of the run that wrote it. Neither is
compared; both are there so a surprising diff can be read against the machine that produced it.

## What `--check` asserts, and what it only reports

Three hard checks, and they are deliberately the only three:

- **Draw commands per frame**, per host, against a 1.25× budget. This is the number the harness
  exists for.
- **The two hosts draw the same number of commands.** A host reaches the same Core over a different
  transport, from a different asset base, and through a rewritten module URL. Equality is what says
  all three still agree, and it holds whatever the baseline says about either host on its own.
- **The scene's entity counts**, one per family, read out of the retained window's array shapes in
  `tools/harness.jl`. Without it, a run against an edited example has fewer draw commands and reads
  as an improvement.

Everything else is printed and never asserted on, including the **collection counts** (`primitives`,
`billboards`, `polylines`, `groundPrimitives`). Those describe how the scene is built rather than
what it contains: which Cesium class holds an entity is a renderer's choice, and batching one
collection per `(family, style)` splits a collection without changing a pixel. Asserting on them
would make every legitimate renderer change a failure, and the useful check — the draw-command
count — would be re-baselined alongside them in the same edit.

A zero among them is not evidence of absence. `groundPrimitives` is one nobody writes to: ground
footprints are `Primitive`s and go into `primitives` with everything else, so that row reads 0 for
every scene the viewer draws, areas or no areas. What a run contains is the entity counts, and
`cell` there is a family of ground footprints.

That split is why the entity counts live on the Julia side. The browser can only see what was drawn;
what the scene *contains* is known where it is built, and stays true when the thing drawing it is
replaced.

## The tracks tracer scene

`tools/tracks/` is a self-contained scene that exercises Core-level windows end to end: three
satellites on circular orbits, five ground stations, and the visibility links between them, pushed
from Julia as a run of windows. **No JavaScript is authored for it** — `serve.jl`
declares the vendored `primitives` and `ui` modules, sends the first `Nodes`/`Edges`
payloads, and declares in `ui` an overlay of a per-keyframe caption, a legend and a toggle, with
tooltips and the toggle's effect written as ordinary event listeners.

```sh
cd lib && npm run build && cd ..
julia --project=. tools/tracks/serve.jl 50006   # then open localhost:50006/?ws=auto
node tools/tracks/check.mjs --url 'http://localhost:50006/?ws=auto'
```

Start a fresh server for each `check.mjs` run: a long-running server answers a new client with a
window rebuilt at wherever playback had reached, and the check asserts on the opening one — frame 0,
and every later window an `append` continuing it.

`check.mjs` asserts what a browser tab shows: the opening window is a `replace`, later windows are
`append`s answering the viewer's own requests, the window identity holds across them, links appear as
visibility changes with their endpoints readable, and the per-tick motion has no step out of scale
with the rest — a seam that renumbered or teleported an entity would show up there. It reads the
windows off the socket and the scene through `primitives`' own read-only accessors, importing the
module from the URL the Core imported it from, which is the same live instance.

It is a tracer, not a gate. It prints a median draw-commands-per-frame for the scene, but asserts
nothing about it: the draw-command budget is the regression harness's, against the scene above.

Two more checks drive the same scene through a real browser, each starting its own server. They read
their port from the environment, because `harness.mjs` parses `process.argv` at import time and
rejects an option it does not recognise:

```sh
PORT=50007 node tools/tracks/pointer-check.mjs   # an alt-click reaches the Julia listener
PORT=50008 node tools/tracks/ui-check.mjs        # and Julia's answer reaches the screen
PORT=50009 node tools/tracks/rejoin-check.mjs    # a page opened mid-playback gets a drawable scene
```

`rejoin-check.mjs` opens a second page once the first has streamed past the opening window, and
asserts what that page is sent: a `replace` at the frames playback had reached, not the `append` the
server was holding. An append may omit whatever the window it extends established, so replaying one
to a client that never received that window leaves it unable to build the scene.

`ui-check.mjs` asserts the overlay is Julia's: the declared caption, legend and toggle render, the
per-keyframe caption tracks the clock with no round trip, a click answered by a listener appears as a
float anchored to the entity clicked and named after it, a `<script>` inside a fragment does not run,
and operating the toggle changes the scene only by way of the replacement window the server pushes —
after which the widget shows the value the server declared.

## The basemap fixture and the zoom proof

`tools/fixtures/basemap/` is a levels 0-2 pyramid of solid-colour tiles, in both layouts: `xyz/` is
the `{z}/{x}/{y}` template, and `tms/` adds the `tilemapresource.xml` that a TMS pyramid is known by.
Level 0 is red, level 1 green and level 2 blue, so a screenshot says which level the globe wears. It
is checked in, and `tools/make-basemap-fixture.mjs` rewrites it:

```sh
node tools/make-basemap-fixture.mjs
```

`tools/zoom-check.mjs` is the one check that proves the claim the basemap feature is for — a camera
that zooms in fetches sharper tiles. It serves the repository root, opens `lib/dist/index.html` on
the fixture with no server behind it, counts the tiles the page asks for, zooms the camera in, and
waits for a level-2 request:

```sh
cd lib && npm run build && cd ..
node tools/zoom-check.mjs                 # PASS, and exit 0
MAXLEVEL=0 node tools/zoom-check.mjs      # the same globe pinned flat: FAIL, and exit 1
```

Options come from the environment (`MAXLEVEL`, `TIMEOUT_MS`), because `harness.mjs` parses
`process.argv` when it is imported and rejects an argument it does not know.

**It is not part of the draw-command harness and must not move into it.** That one gates how the
renderer batches a fixed scene; this one asks what the globe fetches. It counts requests rather than
reading the screen, because this host rasterises in software and nothing that reads a rendered pixel
is trustworthy here.

## The ellipsoid reference table

`lib/ellipsoid-reference.mjs` computes what Cesium's `Ellipsoid.cartographicToCartesian` and
`Cartographic.fromCartesian` give for a fixed table of awkward points — both poles, the equator, the
antimeridian, heights from below the surface to 20 200 km up — on WGS84 and on a shape flattened far
past any planet's, and writes it to `tools/baseline/ellipsoid-reference.json`.

```sh
node lib/ellipsoid-reference.mjs               # rewrite the table
```

The table is what CesiumLink's `ecef` and `geodetic` are asserted against, so the two
implementations agree with each other to the millimetre rather than merely round-tripping through
their own arithmetic. `lib/core/src/ellipsoid-reference.test.mjs` re-runs Cesium against the
committed table on every `npm test`, so a Cesium upgrade that moved a number fails there instead of
being believed on the Julia side. No browser is involved: both conversions are arithmetic on three
numbers, so Cesium is imported directly in Node.

## The recording the documentation plays

`tools/make-demo-recording.jl` writes the session the documentation puts on screen: a ring of
twelve satellites turning once over 36 keyframes, above five ground stations, under a caption and a
legend.

```sh
cd lib && npm run build && cd ..                  # the recording needs the built modules
julia --project=. tools/make-demo-recording.jl    # write one to look at
```

**The recording is not committed.** `docs/make.jl` includes this file and calls
`make_demo_recording` on every build, so the scene in the documentation is always the one the tree
produces. Run the script by hand only to look at a recording. The server it starts binds an
ephemeral loopback port and nothing connects to it, so it does not take the port of a viewer you
are already running.

The scene is declared and pushed before `record!` opens the file, so every frame lands at offset
zero out of what the server retains. A player therefore shows the scene at once rather than
building it over the first seconds of playback.

The page that plays it is `lib/dist/player.html`, built from `lib/player/`. It reads a recording
through `RecordingTransport` (`lib/core/src/recording.ts`) instead of connecting to a server,
so the documentation needs no Julia process running. What answers and what does not is stated in
that file and in the how-to guide on recording.
