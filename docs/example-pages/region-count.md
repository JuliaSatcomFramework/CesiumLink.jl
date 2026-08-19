# 4 · Satellites over a region

A hundred and forty-four satellites over Europe and Africa, and a chart beside the globe. Click a
region and the chart draws how many satellites stand above it, filling in as the scene plays.

```sh
julia examples/RegionCount/run.jl
```

Or start it from a session that already has CesiumLink — see [Run an example](@ref "Run an example"):

```julia
server = include(joinpath(pkgdir(CesiumLink), "examples", "RegionCount", "run.jl"))
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
fills as the scene plays and shortens when you scrub back:

```js
ctx.onKeyframe((index) => { cursor = index; redraw(); });
```

[`onKeyframe`](../reference/wire/module-api.md) fires once per crossing, for every module, whether
or not a window addressed it. The module holds the counts by absolute keyframe and reads the cut off
the clock, so no scrub can invalidate its state. Both axes come from the whole answer, so the frame
stands still while the line grows.

A clock event drives the chart, not a command per keyframe: a recording arms its frames as timers,
and that axis drifts from the clock as soon as you pause, scrub or change speed.

## The box is `ui`'s and the chart is the module's

A [`Floating`](@ref) box shows server-authored HTML or a **mount**: a plain element handed to a
named module. This one is a mount.

```julia
Floating("counts"; anchor = Screen(24, 96), mount = MODULE_ID, closable = false,
         adjustable = true, style = (; width = "420px", height = "300px"))
```

`ui` owns the box: where it sits, how big it is, the drag strip along its top. The module owns
everything inside it, and fills it by exporting `mount`:

```js
export function mount(site) { ... return { resize, dispose }; }
```

`site.el` is the element to fill. The Core calls `resize` when the box changes size and `dispose`
when it leaves the page. The element is plain rather than shadowed, which a chart library needs: it
installs its stylesheet in `document.head`, and nothing of that crosses a shadow boundary.

The float is declared once, at the start, holding an empty chart that says which region to click. A
box that appeared on the first click would lose the user's drag: installing a scene drops every rect
the user gave a float.

## The chart library arrives as an artifact

The module is one hand-written file. There is no npm, no bundler and no build step, because the
library it imports is already an ES module:

```js
import Plotly from "./plotly-esm-min.mjs";
```

That specifier is relative, and it resolves against the module's own URL. The browser has no import
map, so a bare `"plotly.js"` would resolve to nothing.

So the library must sit **beside** the module. The server serves one directory per module, the entry
file's own, under `/modules/<id>/`, and the package builds it when the scene is installed:

```julia
dir = mktempdir()
cp(joinpath(pkgdir(RegionCount), "assets", "regioncount.js"), joinpath(dir, "regioncount.js"))
cp(joinpath(artifact"plotly-esm-min", "plotly-esm-min.mjs"), joinpath(dir, "plotly-esm-min.mjs"))
register_module!(server, ModuleEntry(MODULE_ID, joinpath(dir, "regioncount.js")))
```

**The directory the browser loads is assembled by Julia and is not a folder in this repository.** The
Full source section shows the two files it is made of.

Three points about those four lines:

- The artifact is **lazy**. `Artifacts.toml` names a tarball in a GitHub release, and Julia fetches
  it the first time `artifact"plotly-esm-min"` is asked for. A reader who never runs this example
  downloads nothing.
- The files are **copied, not linked**. A symlink breaks this on Windows.
- Nothing is written into the artifact or into the installed package. Both are content addressed and
  belong to no scene.

The package depends on CesiumLink, a chart library and two standard libraries: four lines of
`[deps]`.

## The click, and the answer

The regions are one [`Areas`](@ref) family: two coarse rings written by hand, there to be clicked
and not a map. One [`on_pointer`](@ref) listener answers a click on either:

```julia
i = findfirst(e -> e.kind == "region", ev.entities)
i === nothing && return nothing
idx = ev.entities[i].idx
1 <= idx <= length(scene.regions) || return nothing
command!(reply, MODULE_ID, TOPIC, counts_payload(scene, idx))
```

- A pick is the **whole stack** under the cursor, nearest first. A satellite over a ring is nearer,
  so the listener looks for the kind it wants instead of taking `ev.entity`.
- `idx` is already **1-based**. Adding one gives an off-by-one that reads like a region nothing can
  pick.
- Bound the index before it indexes anything. **A listener that raises sends no commands frame and
  no error**, which looks like a click that reached nobody.

The answer travels as a command on the module's own topic, not through the float. Per-keyframe data
reaches a mounted module the same way, through the window addressed to it, so a keyframe crossing
leaves the mount standing.

The module holds the last answer, so a resized box redraws without asking again. It does not compare
the sequence number against the click that asked: a late answer to a click is still the answer, and
dropping a stale reply is the receiving module's policy.

## What the recording carries

`make.jl` records this scene, and a recording replays commands but runs no listeners. So the
recording step drives the same path by hand: install the scene, open the recording, count one
region, send the answer.

```julia
scene = serve_scene!(server, RegionCount.Satellites())
record!(server, "region-count.jsonl")
answer!(server, scene, 1)
```

`answer!` is what the listener calls too, so the frame on the wire is the frame a real click makes.

## Full source

{{source}}
