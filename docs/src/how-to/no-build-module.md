# Write a module with no build step

You want a module of your own and no bundler. The browser loads a module with `import()`, so
anything the browser resolves by itself needs no build and no npm.

## Several files, imported relatively

The server mounts the entry file's **containing directory** under `/modules/<id>/`, so a file beside
the entry is served too.

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

The browser resolves the import against the entry's URL, asks the same server for
`/modules/poles/shapes.js`, and gets it. A subdirectory works the same way.

The browser applies two rules here:

- **Write the extension.** Use `"./shapes.js"`, never `"./shapes"`. The browser adds nothing.
- **Write a relative specifier**, starting with `./` or `../`. The browser resolves nothing from a
  bare specifier such as `"d3-scale"`, and the import fails.

Keep every file inside the entry's directory. The server refuses a path that climbs out of it.

## A library that lives elsewhere on disk

The mount is one directory, so a library elsewhere on disk is out of reach whatever URL the module
asks for. Put it in the entry file's directory first.

**Link it** to make no copy. The server follows a link, and a link inside the mount stays inside it:

```julia
dir = joinpath(@__DIR__, "assets")                     # holds plot.js
symlink(joinpath(artifact"plotly", "plotly.min.js"), joinpath(dir, "plotly.min.js"))
register_module!(server, :plot, joinpath(dir, "plot.js"))
```

Use this for a large library, for one from a Julia artifact, and for one several modules share. On
Windows a symlink needs a privilege the user may not hold, so copy there instead.

**Copy it** when you distribute the module: a package that ships `assets/plot.js` ships
`assets/plotly.min.js` beside it, and the two travel together.

Then import it by a URL built against the module's own:

```js
// Resolved against this module's served URL, which is /modules/plot/ — not against the page.
await import(new URL("plotly.min.js", import.meta.url).href);
```

Three points about that line:

- **A static relative import does the same job** when the module always needs the library:
  `import { … } from "./plotly.min.js"`. Use the `new URL` form for a **dynamic** import, where the
  library loads late or only on the branch that needs it.
- **A bundler leaves a computed specifier alone.** esbuild inlines a literal specifier and skips this
  one, so a library beside the module stays out of the bundle even under `bundle: true`, and the
  browser caches it once per URL. Use that for a library of several megabytes.
- **A UMD library installs a global.** Some ready-made bundles are not ES modules. One installs its
  name on `globalThis`, so the `import()` runs for the side effect and you read the API back
  afterwards:

  ```js
  await import(new URL("plotly.min.js", import.meta.url).href);
  const Plotly = globalThis.Plotly;
  ```

## A library from the web

An absolute URL is a specifier the browser resolves on its own:

```js
import { scaleLinear } from "https://cdn.jsdelivr.net/npm/d3-scale@4/+esm";
```

!!! warning "A URL import ends offline operation"
    Do not use a URL import in a viewer that must run without access to the internet. The server
    serves the page, the Cesium runtime and every module from its own port. One URL import makes the
    CDN a second host that every browser must reach.

    Put the file in the module's directory and import it from there, as
    [A library that lives elsewhere on disk](#a-library-that-lives-elsewhere-on-disk) shows.

Three more points:

- **Pin the version** in the URL, as `d3-scale@4` does. An unpinned URL resolves to whatever the CDN
  serves that day.
- **The CDN must send `Access-Control-Allow-Origin`.** The browser fetches every cross-origin module
  with CORS. jsDelivr and esm.sh send it; a plain file host may not.
- **Never import `@cesium/engine`, from a CDN or from anywhere else.** Two live copies of Cesium
  cannot share one scene, and the failure shows an empty globe rather than an error. Use
  `ctx.Cesium`. See [the module API](../reference/wire/module-api.md).

An import that fails unloads that one module. The browser console names it, and the viewer and the
other modules keep running.

## JavaScript written in Julia

[`register_module!`](@ref) asks for a file on disk. Write a module you hold as a Julia string into a
directory of its own, then register the path.

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

Four points about that:

- **Write the source as `raw"""..."""`.** A JavaScript template literal writes `${...}`, and Julia
  reads `$` in a plain string as its own interpolation. `raw` turns Julia's interpolation off.
- **Keep Julia values out of the source.** The values a module draws arrive over the wire: push them
  in a window, or send them with [`send_command`](@ref). String interpolation rebuilds the module for
  every value, and a browser that connects later gets the last build.
- **Give the module a directory of its own.** The server serves every file in the containing
  directory. `mktempdir()` hands you an empty one; a shared directory publishes its other files under
  `/modules/<id>/`. A library the module needs goes beside it, by a link or a copy.
- **A recording made this way cannot be replayed.** [`record!`](@ref) writes each module's path into
  the recording header, and [`replay`](@ref) registers the module from that path, which a temporary
  directory no longer holds. See [Record and replay a session](record-replay.md).

Write the module into a real file as soon as you edit it more than once. An editor that understands
JavaScript catches a mistake that a string hands straight to the browser.

## When you do need a build step

Two cases, and no others:

- **TypeScript.** The browser loads JavaScript, so something must erase the types first.
- **A dependency named by a bare specifier**, such as `import * as d3 from "d3-scale"`. Bundle it,
  or reach the same library by URL, or put the library file beside the module and import it
  relatively.

[Ship a module from a Julia package](../tutorials/package-with-module.md) shows the esbuild build the
vendored modules use.
