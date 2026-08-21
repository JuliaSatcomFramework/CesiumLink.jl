# 5 · A line material of your own

Twelve satellites on one orbit, joined into a ring by twelve links. A bright band travels along each
link. No stock material draws that, so the scene registers one.

```sh
julia examples/PulseEdges/run.jl
```

Or start it from a session that already has CesiumLink — see [Run an example](@ref "Run an example"):

```julia
server = include(joinpath(pkgdir(CesiumLink), "examples", "PulseEdges", "run.jl"))
```

The scene below is a recording of that program, played in the browser.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/pulse-edges.jsonl&modules=modules"
        title="A ring of satellites joined by pulsing links, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

**This example is here for one seam.** The orbit is twenty lines of hand-written geometry and the
scene has nothing else in it.

## The name is the whole contract

The vendored `primitives` module draws a line in one of three stock materials: `:solid`, `:dashed`
and `:glow`. A scene that wants a fourth does not copy the module. It names one:

```julia
Edges(:link; from = :sat, to = :sat, pairs = LINKS, style = "pulse.travelling", width = 3.0)
```

and a module of its own answers to that name:

```js
ctx.modules.get("primitives").defineEdgeMaterial("pulse.travelling", travelling);
```

`"pulse.travelling"` is all that joins the two halves. Nothing else crosses.

**The dot is what makes the name a registration.** A stock name never holds one, so `primitives`
reads a name that does as an owner's and looks it up in what modules have registered. The token
before the dot is the id of the module that registers it. Two other forms of the same name reach
other places: a name holding a `/` is an `assets/<mount>/<file>` path the server serves, and a name
starting `data:` carries its own bytes. One rule covers all four — see
[Extending a vendored module](../reference/wire/module-api.md#extending-a-vendored-module).

## Julia checks the shape, and only the shape

Julia cannot know what a browser registered, so it checks the **form** of the name and passes any
well-formed one on. A typo therefore reaches the viewer, which writes one line to the console and
draws a solid line:

```
primitives: no edge material named "pulse.travelling" is registered; the solid line is drawn
```

It never throws. A scene is already playing by the time a browser reads that name.

## The material is a shader, which is why it needs a module

A pulse that walks along a line cannot be a file, and it cannot be a colour the server sends per
frame either — the wire would carry one window per animation step. It is five lines of GLSL:

```glsl
float t = fract(materialInput.s - czm_frameNumber * 0.004);
float pulse = smoothstep(0.0, 0.15, t) - smoothstep(0.15, 0.35, t);
material.diffuse = color.rgb;
material.alpha = color.a * (0.2 + 0.8 * pulse);
```

`materialInput.s` runs from 0 at one end of the line to 1 at the other, and `czm_frameNumber` counts
the frames the viewer has drawn. So the band moves with no uniform written per frame and nothing
asked of the server.

**Register last.** A stock name costs nothing, an assets mount serves a file once, and a `data:` URI
carries something small. Reach for a registration when the thing needs code in the browser, as this
one does.

## The factory answers one material per appearance

```js
const travelling = (C, look) => new C.Material({ /* … */ uniforms: { color: look.color } });
```

`primitives` calls the factory once per **distinct appearance** of the family, not once per line, and
it owns what it gets back. So answer a fresh material every call: one material shared between two
appearances is destroyed twice.

A custom material therefore costs what a stock one costs. Twelve links in one appearance are one
draw command, the same twelve links in `:solid` would be. [`Edges`](@ref) prices the rest.

## Declare `primitives` before the module that extends it

```julia
register_module!(server, vendored(:primitives))
register_module!(server, MODULE_ID, joinpath(@__DIR__, "assets", "pulse.js"))
```

Registration order is the order the viewer runs the setups in. A module that reaches a peer before
that peer's own setup has run gets state that is not built yet, and the Core writes a line saying so.
Declaring the vendored module first is the whole fix.

The registry empties when `primitives` unloads, so this module takes nothing down of its own.

## Full source

{{source}}
