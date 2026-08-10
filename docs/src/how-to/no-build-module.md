# Write a module with no build step

The vendored modules are bundled with esbuild, and
[Ship a module from a Julia package](../tutorials/package-with-module.md) shows that build. Your own
module usually needs no build at all. The browser loads a module with `import()`, so anything the
browser resolves by itself needs no bundler and no npm.

This page shows the forms that need no build, and names the two that do.

## Several files, imported relatively

The server mounts the entry file's **containing directory** under `/modules/<id>/`. A file beside the
entry is therefore served too, and the browser resolves a relative import against the entry's URL.

```
poles/
  poles.js        ← the file you register
  shapes.js
```

```js
// poles.js
import { pole } from "./shapes.js";
```

```julia
register_module!(server, :poles, "poles/poles.js")
```

The browser asks the same server for `/modules/poles/shapes.js` and gets it. A subdirectory beside
the entry works the same way.

The browser enforces two rules here, not the server:

- **Write the extension.** Use `"./shapes.js"`, never `"./shapes"`. The browser adds nothing.
- **Write a relative specifier**, which starts with `./` or `../`. A bare specifier such as
  `"d3-scale"` names nothing the browser can resolve, and the import fails.

Keep every file inside the entry's directory. Only that directory is mounted, and the server does not
serve a path that climbs out of it.

## A library that lives elsewhere on disk

The mount is one directory. `/modules/<id>/` is served from the entry file's own directory and from
nothing else, so a library that sits somewhere else on disk is out of reach, whatever URL the module
asks for. Put it in that directory first.

**Link it**, and no copy is made. The server follows a link, and a link inside the mount stays inside
it:

```julia
dir = joinpath(@__DIR__, "assets")                     # holds plot.js
symlink(joinpath(artifact"plotly", "plotly.min.js"), joinpath(dir, "plotly.min.js"))
register_module!(server, :plot, joinpath(dir, "plot.js"))
```

Use this for a large library, for one that comes from a Julia artifact, and for one that several
modules share. On Windows a symlink needs a privilege the user may not hold, so copy there instead.

**Copy it** where the module is what you distribute. A package that ships `assets/plot.js` ships
`assets/plotly.min.js` beside it, and the two travel together.

Then import it from the module by a URL built against the module's own:

```js
// Resolved against this module's served URL, which is /modules/plot/ — not against the page.
await import(new URL("plotly.min.js", import.meta.url).href);
```

Three things about that line:

- **A static relative import does the same job.** Write `import { … } from "./plotly.min.js"` when
  the module always needs the library. Use the `new URL` form for a **dynamic** import, where the
  library loads late, once, or only on the branch that needs it.
- **A bundler leaves a computed specifier alone.** esbuild follows a literal specifier and inlines
  what it finds; it does not follow this one. So a library kept beside the module stays out of the
  bundle even under `bundle: true`, and the browser caches it once per URL. Use that deliberately for
  a library of several megabytes.
- **A UMD library installs a global.** Not every ready-made bundle is an ES module. Evaluating one
  installs its name on `globalThis`, so the `import()` is there for the side effect and the API is
  read back afterwards:

  ```js
  await import(new URL("plotly.min.js", import.meta.url).href);
  const Plotly = globalThis.Plotly;
  ```

## A library from the web

An absolute URL is a specifier the browser resolves on its own:

```js
import { scaleLinear } from "https://cdn.jsdelivr.net/npm/d3-scale@4/+esm";
```

This needs no bundler and no npm. It costs the one property the rest of the viewer keeps.

!!! warning "A URL import ends offline operation"
    Do not use a URL import in a viewer that must run without access to the internet. The server
    serves the page, the Cesium runtime and every module from its own port, so a session otherwise
    reaches no other host. One URL import makes the CDN a second host that every browser must reach.

    Put the file in the module's directory once and import it from there, as
    [A library that lives elsewhere on disk](#a-library-that-lives-elsewhere-on-disk) shows. The
    property comes back, and the module keeps the library.

Three more points:

- **Pin the version** in the URL, as `d3-scale@4` does. An unpinned URL resolves to whatever the CDN
  serves that day.
- **The CDN must send `Access-Control-Allow-Origin`.** The browser fetches every cross-origin module
  with CORS. jsDelivr and esm.sh both send it; a plain file host may not.
- **Never import `@cesium/engine`, from a CDN or from anywhere else.** Two live copies of Cesium
  cannot share one scene, and the failure looks like an empty globe rather than like an error. Use
  `ctx.Cesium`. See [the module API](../reference/wire/module-api.md).

An import that fails leaves that one module unloaded. The browser console names it, and the viewer
and the other modules keep running.

## JavaScript written in Julia

A module is a file on disk, and [`register_module!`](@ref) asks for nothing else. A module held as a
Julia string therefore becomes registerable in three lines: write it into a directory of its own,
then register the path.

```julia
using CesiumLink

source = raw"""
export default {
  setup(ctx) {
    const { Cesium, scene } = ctx;
    const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());

    return () => scene.primitives.remove(points);
  },
};
"""

dir = mktempdir()                       # an empty directory, removed when Julia exits
path = joinpath(dir, "dots.js")
write(path, source)

server = start_server()
register_module!(server, :dots, path)
```

Four things about that:

- **Write the source as `raw"""..."""`.** A JavaScript template literal writes `${...}`, and Julia
  reads `$` in a plain string as its own interpolation. `raw` turns Julia's interpolation off.
- **Keep Julia values out of the source.** A module is code, and the values it draws arrive over the
  wire: push them in a window, or send them with [`send_command`](@ref). A module built by string
  interpolation is rebuilt for every value, and every browser that connects later gets the module the
  last build produced.
- **Give the module a directory of its own.** The server mounts the containing directory and serves
  every file in it. `mktempdir()` hands you an empty one; a shared directory publishes its other
  files under `/modules/<id>/`. A library the module needs goes in beside it, by a link or a copy.
- **A recording made this way cannot be replayed.** [`record!`](@ref) writes each module's path into
  the recording header and [`replay`](@ref) registers the module from that path, which a temporary
  directory no longer holds. See [Record and replay a session](record-replay.md).

Write the module into a real file as soon as you edit it more than once. An editor that understands
JavaScript reports a mistake that a string hands straight to the browser.

## When you do need a build step

Two cases, and no others:

- **TypeScript.** The browser loads JavaScript, so something must erase the types first.
- **A dependency named by a bare specifier**, such as `import * as d3 from "d3-scale"`. Bundle it,
  or reach the same library by URL, or put the library file beside the module and import it
  relatively.

[Ship a module from a Julia package](../tutorials/package-with-module.md) shows the esbuild build the
vendored modules use.
