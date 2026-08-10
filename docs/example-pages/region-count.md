# 4 · Satellites over a region

A hundred and forty-four satellites over Europe and Africa, and a chart beside the globe. Click a
region and the chart draws how many satellites stand above it, filling in as the scene plays.

```sh
julia examples/RegionCount/run.jl
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/region-count.jsonl&modules=modules"
        title="Satellites over Europe and Africa, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

Drag to turn the globe: Europe and Africa are the two outlined rings.

**The recorded page does not answer a click.** A replay runs no listener, so the chart you see is the
one a recorded click produced. Run the command above for the scene that answers.

## The chart follows the clock

The answer carries one count per keyframe. The chart draws them up to the keyframe on screen, so it
fills as the scene plays and shortens again when you scrub back:

```js
ctx.onKeyframe((index) => { cursor = index; redraw(); });
```

[`onKeyframe`](../reference/wire/module-api.md) fires once per crossing, for every module, whether
or not a window addressed it. The module holds the counts by absolute keyframe and reads the cut off
the clock, so it never accumulates state a scrub can invalidate. Both axes are fixed from the whole
answer, so the frame stands still while the line grows.

This is why the chart is driven by a clock event and not by a command per keyframe. A recording
stamps each frame with how long after the recording opened it was sent, and the player arms those
deliveries as timers when the page loads. That is a different axis from the clock: pause, scrub or
change speed, and a command stream drifts away from the globe, while a chart that reads
`onKeyframe` cannot.

## The box is `ui`'s and the chart is the module's

A [`Floating`](@ref) box shows either a fragment of server-authored HTML or a **mount**: a plain
element handed to a named module. This example is the second kind.

```julia
Floating("counts"; anchor = Screen(24, 96), mount = MODULE_ID, closable = false,
         adjustable = true, style = (; width = "420px", height = "300px"))
```

`ui` owns the box — where it sits, how big it is, the drag strip along its top — and the module owns
everything inside it. Neither reaches across. The module fills the box by exporting `mount`:

```js
export function mount(site) { ... return { resize, dispose }; }
```

`site.el` is the element to fill. `resize` is called when the box is declared again or the user drags
its corner, and `dispose` when the box leaves the page. The element is plain rather than shadowed,
which is what a chart library needs: it installs its stylesheet in `document.head`, and nothing of
that reaches across a shadow boundary.

The float is declared once, at the start, holding an empty chart that says which region to click. A
box that appeared on the first click would forget where the user had dragged it, because every rect
the user gave a float is dropped when a scene is installed.

## The chart library arrives as an artifact

The module is one hand-written file. There is no npm, no bundler and no build step, because the
library it imports is already an ES module:

```js
import Plotly from "./plotly-esm-min.mjs";
```

That specifier is relative, and it resolves against the module's own URL. The browser has no import
map, so a bare `"plotly.js"` would resolve to nothing.

For the import to find the file, the library has to sit **beside** the module: the server serves one
directory per module — the entry file's own — under `/modules/<id>/`. So the package builds that
directory when the scene is installed:

```julia
dir = mktempdir()
cp(joinpath(pkgdir(RegionCount), "assets", "regioncount.js"), joinpath(dir, "regioncount.js"))
cp(joinpath(artifact"plotly-esm-min", "plotly-esm-min.mjs"), joinpath(dir, "plotly-esm-min.mjs"))
register_module!(server, ModuleEntry(MODULE_ID, joinpath(dir, "regioncount.js")))
```

**The directory the browser loads is assembled by Julia and is not a folder in this repository.** The
Full source section below shows the two files it is made of, and never the directory itself.

Three points about those four lines:

- The artifact is **lazy**. `Artifacts.toml` names a tarball in a GitHub release, and Julia fetches
  it the first time `artifact"plotly-esm-min"` is asked for. A reader who never runs this example
  downloads nothing.
- The files are **copied, not linked**. A symlink is what breaks this on Windows.
- Nothing is written into the artifact or into the installed package. Both are content addressed and
  belong to no scene.

The package therefore depends on CesiumLink, a chart library and two standard libraries. Its whole
`[deps]` is four lines.

## The click, and the answer

The regions are one [`Areas`](@ref) family, two coarse rings written out by hand. They are there to
be clicked, and they are not a map.

One [`on_pointer`](@ref) listener answers a click on either of them:

```julia
i = findfirst(e -> e.kind == "region", ev.entities)
i === nothing && return nothing
idx = ev.entities[i].idx
1 <= idx <= length(scene.regions) || return nothing
command!(reply, MODULE_ID, TOPIC, counts_payload(scene, idx))
```

- A pick is the **whole stack** under the cursor, nearest first. A satellite drawn over a ring is
  nearer than the ring, so the listener looks for the kind it wants instead of taking `ev.entity`.
- `idx` is already **1-based**. Adding one to it is an off-by-one that reads exactly like a region
  nothing can pick.
- The index is bounded before it indexes anything. **A listener that raises sends no commands frame
  and no error**, which looks exactly like a click that reached nobody.

The answer travels as a command on the module's own topic, not through the float. Per-keyframe data
for a mounted module reaches it the same way — through the window addressed to that module — which is
why a keyframe crossing leaves the mount standing instead of rebuilding it.

The module holds the last answer it was given, so a box the user resizes redraws from it without
asking again. It does not compare the sequence number against the click that asked: a late answer to
a click is still the answer, and dropping a stale one is a policy the receiving module would have to
want.

## What the recording carries

`make.jl` records this scene, and a recording replays commands but runs no listeners. So the
recording step drives the same path by hand: install the scene, open the recording, then call the
counting function for one region and send its answer.

```julia
scene = serve_scene!(server, RegionCount.Satellites())
record!(server, "region-count.jsonl")
answer!(server, scene, 1)
```

`answer!` is what the listener calls too, so the frame on the wire is the frame a real click makes.

## Full source

{{source}}
