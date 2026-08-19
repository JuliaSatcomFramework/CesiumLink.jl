# Ship a module from a Julia package

In this tutorial you build a Julia package that carries a viewer module. The package holds the
JavaScript, the payload the module reads, and the entry that declares it. A user of the package adds
one `using`, registers the module and pushes a window, with no JavaScript and no Node.js.

The package is called `Poles`, and it ships the module from
[Write a viewer module](first-module.md). You write five files, build the JavaScript once, and end
with a script that draws four coloured poles out of the package's own vocabulary.

A module ships from a package when its vocabulary names a domain concept: a site, a rain fade, a
beam. A module told only a shape, a value or a colour is vendored inside the viewer instead, and
[`vendored`](@ref) declares those.

## The layout

```
Poles/
├── Project.toml
├── assets/
│   └── poles.js          ← the built module; this is what the browser imports
├── js/
│   ├── build.mjs
│   ├── package.json
│   └── src/
│       └── index.js      ← the module source
└── src/
    └── Poles.jl
```

Two rules decide that tree.

- **The built file is in the tree.** Pkg installs the package as it stands, and a user has no way to
  run your build. Commit `assets/poles.js`. `js/` is where that file comes from, and nothing reads
  it at run time.
- **The package points at its own asset with `pkgdir`.** An installed copy of the package is the
  only tree the module is ever loaded from.

CesiumLink's own [`viewer_dist`](@ref) is a special case: it serves a viewer built from `lib/` in
the same repository, so the package builds that tree rather than committing it.

## 1. `Project.toml`

```toml
name = "Poles"
uuid = "74499542-e75f-465e-98c4-501613f81846"
version = "0.1.0"

[deps]
CesiumLink = "fe4ddbe3-63a4-4ce0-8a5b-46bb22807cc2"

[compat]
CesiumLink = "0.1"
julia = "1.12"
```

Give your package a UUID of its own: `using UUIDs; uuid4()`.

## 2. The module source

Write `js/src/index.js`. This is the file from [Write a viewer module](first-module.md), unchanged:
nothing about a module differs because a package ships it.

```js
// One vertical pole per site, drawn from the payload the server addresses to this module.
//
// Never import "@cesium/engine" here. Two live copies of Cesium cannot share one scene, and the
// failure looks like an empty globe rather than like an error. The Core hands you its own copy as
// `ctx.Cesium`.

export default {
  setup(ctx) {
    const { Cesium, scene } = ctx;
    const poles = scene.primitives.add(new Cesium.PolylineCollection());
    const plain = Cesium.Material.fromType("Color", { color: Cesium.Color.CYAN });
    const hot = Cesium.Material.fromType("Color", { color: Cesium.Color.ORANGE });

    let names = [];
    let highlighted = new Set();

    const paint = () => {
      for (let i = 0; i < names.length; i++) {
        poles.get(i).material = highlighted.has(names[i]) ? hot : plain;
      }
    };

    const disposables = [
      ctx.onWindow((_, payload) => {
        const { lon, lat, height, label } = payload;
        names = label;
        poles.removeAll();
        for (let i = 0; i < names.length; i++) {
          poles.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(lon.data[i], lat.data[i], 0),
              Cesium.Cartesian3.fromDegrees(lon.data[i], lat.data[i], height.data[i]),
            ],
            width: 6,
            id: ctx.pickId("pole", i),
          });
        }
        paint();
      }),

      ctx.onCommand("highlight", (payload) => {
        highlighted = new Set(payload.names);
        paint();
      }),

      ctx.onPointer((e) => {
        if (e.type === "click" && e.entity?.module === ctx.id) {
          ctx.notify("picked", { name: names[e.entity.idx] });
        }
      }),
    ];

    return () => {
      for (const dispose of disposables) dispose();
      scene.primitives.remove(poles);
    };
  },
};
```

## 3. The build step

A build is optional. The server mounts the module's whole directory, so a module split over several
files imports them relatively and needs no bundler, and a library reached by URL needs none either.
See [Write a module with no build step](../how-to/no-build-module.md). This package builds because
that shape keeps working once the module grows a TypeScript file or a dependency named by a bare
specifier.

Write `js/package.json`:

```json
{
  "name": "poles-module",
  "private": true,
  "type": "module",
  "scripts": { "build": "node build.mjs" },
  "devDependencies": { "esbuild": "^0.23.0" }
}
```

Write `js/build.mjs`:

```js
// Bundle the module source into the one ES module file the package ships.
import esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "src/index.js")],
  bundle: true,
  format: "esm",                                   // the Core loads the file with import()
  sourcemap: true,
  outfile: join(here, "..", "assets", "poles.js"),
  logLevel: "info",
});
```

Build it:

```sh
cd js
npm install
npm run build
```

`assets/poles.js` now exists, with `assets/poles.js.map` beside it. The server mounts the whole
directory, so the browser finds the source map itself.

The vendored modules are built the same way, with the same three settings that matter: one entry
point, `bundle: true`, and `format: "esm"`.

- **`@cesium/engine` needs no `external` entry.** A module never imports it for its values, and a
  TypeScript module that imports it for its types leaves nothing behind after the build. No copy of
  Cesium reaches the bundle.
- **Today the bundle is a copy of one file.** It stops being one as soon as the source grows a
  second file or an npm dependency, and nothing else in the package changes.

Add `js/node_modules` to the package's `.gitignore`, and keep `assets/poles.js` out of it.

## 4. The Julia side

Write `src/Poles.jl`. It holds the entry that declares the module, the vocabulary that builds its
payload, and one helper for the topic the module listens on.

````julia
"""
    Poles

A vertical pole per ground site, drawn on the CesiumLink globe. Register the module with
`register_module!(server, Poles.poles_module())`, then push a window carrying `poles_payload`.
"""
module Poles

using CesiumLink: ModuleEntry, send_command

export Site, poles_payload

# The id the module is declared under, and the key a window addresses its payload to.
const MODULE_ID = :poles

"""
    poles_module() -> ModuleEntry

The declaration entry for this package's viewer module. Pass it to `register_module!`.

The file is the built bundle in the package's `assets` directory. `ModuleEntry` checks that it is
there, so a missing build is an error here rather than a 404 in the browser.

`ModuleEntry` states the module API version for you: it defaults to the version this package
implements. Write the keyword yourself only to declare an older version on purpose.
"""
poles_module() = ModuleEntry(MODULE_ID, joinpath(pkgdir(Poles), "assets", "poles.js"))

"""
    Site(name; lon, lat, height_m)

One pole: where it stands, how tall it is, and the name it answers to. `lon` and `lat` are degrees,
`height_m` is metres above the surface.

```julia
Site("Rome"; lon = 12.50, lat = 41.90, height_m = 420_000)
```
"""
struct Site
    name::String
    lon::Float64
    lat::Float64
    height_m::Float64
    # An INNER constructor, so the checks run for every call form.
    function Site(name, lon, lat, height_m)
        -180 ≤ lon ≤ 180 ||
            throw(ArgumentError("$name: lon is degrees east, -180 to 180 (got $lon)"))
        -90 ≤ lat ≤ 90 ||
            throw(ArgumentError("$name: lat is degrees north, -90 to 90 (got $lat)"))
        height_m > 0 ||
            throw(ArgumentError("$name: a pole stands above the surface (got $height_m m)"))
        return new(String(name), Float64(lon), Float64(lat), Float64(height_m))
    end
end

Site(name; lon, lat, height_m) = Site(name, lon, lat, height_m)

"""
    poles_payload(sites) -> NamedTuple

The `poles` module's payload for one window, out of any collection of [`Site`](@ref)s. Address it to
`:poles` in [`push_window`](@ref).

A name identifies a pole in every message this package sends, so two sites may not share one.

```julia
push_window(server, Dict(:poles => poles_payload(sites));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```
"""
function poles_payload(sites)
    names = [s.name for s in sites]
    length(Set(names)) == length(names) ||
        throw(ArgumentError("two sites share a name; a name identifies a pole"))
    return (; lon = [s.lon for s in sites], lat = [s.lat for s in sites],
            height = [s.height_m for s in sites], label = names)
end

"""
    highlight!(server, names) -> Int

Paint the poles in `names` orange and every other pole cyan. Returns the number of clients reached.

The command is retained, so a browser that connects later comes back to the same highlight.
"""
highlight!(server, names) =
    send_command(server, String(MODULE_ID), "highlight", (; names = collect(String, names)))

end # module Poles
````

The payload is four plain arrays, and CesiumLink encodes each on the way out. The three `Float64`
vectors reach the module as `Float64Array`s. The vector of strings is not numeric, so it travels as
a JSON list and arrives as a plain JavaScript array.

CesiumLink's own vocabularies take this shape: [`Raster`](@ref) and [`heatmap_payload`](@ref) for
the vendored `heatmap` module, [`Nodes`](@ref) and [`primitives_payload`](@ref) for `primitives`.
Each is a checked constructor per thing, and one function that lowers a collection of them into the
payload for one window.

## 5. What a user writes

Add the package to an environment that also has CesiumLink. Then the whole script is Julia:

```julia
using CesiumLink, Poles

server = start_server()
register_module!(server, Poles.poles_module())

sites = [Site("Rome"; lon = 12.50, lat = 41.90, height_m = 420_000),
         Site("Oslo"; lon = 10.75, lat = 59.91, height_m = 160_000),
         Site("London"; lon = -0.13, lat = 51.51, height_m = 780_000),
         Site("Stockholm"; lon = 18.06, lat = 59.33, height_m = 310_000)]

push_window(server, Dict(:poles => poles_payload(sites));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)

Poles.highlight!(server, ["London"])
```

Open the URL `viewer_url(server)` gives. Four poles stand over Europe, and the London one is
orange.

The user's script names the module id twice: through `poles_module()` and as the payload key
`:poles`. A scene uses the same shape for a vendored module, where
`register_module!(server, vendored(:heatmap))` pairs with `Dict(:heatmap => …)`.

## What the package must keep stable

Four things are the package's public surface for the viewer.

- **The module id, `poles`.** It is the URL segment the browser imports from, the key a window
  addresses a payload to, and the name every command and event carries. A change breaks every script
  that pushes a payload for it.
- **The topics: `highlight` downward, `picked` upward.** They are the routing keys between the Julia
  side and the JavaScript side of your package. Change the two together. A user may register a
  listener on `picked`, so renaming that topic breaks the user's code as well.
- **The payload shape: `lon`, `lat`, `height` and `label`.** The Core never reads inside a payload,
  so a field the JavaScript stops reading fails silently: nothing is drawn and nothing is reported.
  Keep the Julia constructor and the module in step, and let the constructor refuse what the module
  cannot draw.
- **The module API version.** Your JavaScript is written against one version of the module API.
  `ModuleEntry` declares the version this package implements, so leave the keyword out and let it
  travel with your `[compat]` bound on CesiumLink. A viewer that implements another version skips
  your module and warns, rather than run it against a contract it does not meet.

## Where to go next

- [The module API](../reference/wire/module-api.md) is the normative contract behind everything in
  `setup`.
- [Modules, vocabularies and glue](../explanation/modules.md) explains which parts belong in your
  package and which belong in CesiumLink.
- [Send large arrays](../how-to/large-arrays.md) covers what a payload costs once its arrays grow.
