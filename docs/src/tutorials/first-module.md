# Write a viewer module

In this tutorial you write a **module**: one ES module the viewer's Core loads because your server
declared it. A module is the unit that draws in the scene, and it is how anything reaches the globe
that the vendored modules cannot draw.

You will build a module called `poles`. It draws one vertical line per ground site, from the surface
up to a height the server sends. Then you make the server change a pole's colour, and answer a click
on one. At the end you have four coloured poles over Europe, and a click on one turns it orange.

The vendored `primitives` module draws points, lines between two families, and ground footprints. It
does not draw a line from the surface up to an altitude that a value decides, so this module is
worth writing.

Before you start, finish [Your first scene](first-scene.md). You need CesiumLink installed and the
viewer served.

## 1. Write the module file

Make a directory for this tutorial and change into it:

```sh
mkdir poles-demo
cd poles-demo
```

Write the whole module into one file, `poles.js`:

```js
// poles.js — one vertical pole per site, drawn from the payload the server addresses to this module.
//
// Never import "@cesium/engine" here. Two live copies of Cesium cannot share one scene: a primitive
// built by one is refused by the other, and the failure looks like an empty globe rather than like
// an error. The Core hands you its own copy as `ctx.Cesium`.

export default {
  setup(ctx) {
    const { Cesium, scene } = ctx;
    const poles = scene.primitives.add(new Cesium.PolylineCollection());
    // Two materials for the whole collection. Cesium batches the poles that share one.
    const plain = Cesium.Material.fromType("Color", { color: Cesium.Color.CYAN });
    const hot = Cesium.Material.fromType("Color", { color: Cesium.Color.ORANGE });

    // The site names the last window sent, in pole order, and the names the server last highlighted.
    let names = [];
    let highlighted = new Set();

    const paint = () => {
      for (let i = 0; i < names.length; i++) {
        poles.get(i).material = highlighted.has(names[i]) ? hot : plain;
      }
    };

    const disposables = [
      // One window's payload for this module, and nothing else. Every array in it is already decoded.
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
            // The stamp that makes a pole pickable and tells the Core which module owns it.
            id: ctx.pickId("pole", i),
          });
        }
        // Paint after the rebuild: a highlight that arrived before this window found no poles to
        // paint, and this is where it takes effect.
        paint();
      }),

      // This module's `highlight` topic. One handler per topic — a second one is refused.
      ctx.onCommand("highlight", (payload) => {
        highlighted = new Set(payload.names);
        paint();
      }),

      // A local reaction: report the pole under the pointer, and let the server decide what it means.
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

Three things in that file carry the whole contract.

- **The default export is an object with a `setup(ctx)`.** `setup` runs once, when the module loads.
  Everything the module may use arrives in `ctx`: the shared Cesium namespace, the scene, the window
  payloads, the topics and the pointer.
- **The payload is yours.** The Core routes it to your module and never reads inside it. It decodes
  the arrays and nothing else, so `lon` arrives as `{ data: Float64Array, shape: [4] }`, and the
  strings in `label` arrive as a plain JavaScript array.
- **`setup` returns a teardown.** The Core drains your registrations for you. The primitives you add
  to the scene are yours to remove, and that is what the returned function is for.

## 2. Serve the module

Start Julia in the `poles-demo` directory, in the environment where CesiumLink is installed. Start a
server and register the module:

```julia
using CesiumLink

server = start_server()
register_module!(server, :poles, "poles.js")
```

[`register_module!`](@ref) resolves the path at once, against the working directory, and refuses a
file that is not there. The server then mounts the file's **containing directory** under
`/modules/poles/`, and declares the URL `/modules/poles/poles.js`. The browser imports the module
from that URL, same-origin with the page, so a sibling file beside `poles.js` resolves too.

Register every module before a browser connects. The module set is established per connection: the
server declares it once, and a module registered later reaches that client only after a reload.

Now open the viewer at the URL [`viewer_url`](@ref) gives:

```julia
viewer_url(server)
```

The `?ws=auto` it carries tells the page to connect to the server that served it. You see a globe
and no poles. The browser console names the server it connected to, and names any module it refused
to load.

## 3. Push a window

A **window** is a run of keyframes, and it carries one payload per module. Push one with four sites:

```julia
lon   = [12.50, 10.75, -0.13, 18.06]
lat   = [41.90, 59.91, 51.51, 59.33]
value = [4.2, 1.6, 7.8, 3.1]                     # Gbps
label = ["Rome", "Oslo", "London", "Stockholm"]

push_window(server, Dict(:poles => (; lon, lat, height = value .* 100_000, label));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```

Four cyan poles stand over Europe, the tallest of them over London. This scene has one keyframe, so
nothing moves.

The key `:poles` is the id you registered, and it is what addresses this payload to your module. A
module absent from a window's payloads is not called for that window.

## 4. Send it a command

A **command** is one instruction the server addresses to a module's topic. Send one to the
`highlight` topic your module registered:

```julia
send_command(server, "poles", "highlight", (; names = ["London"]))
```

The London pole turns orange. Send the command again with another name, and the orange moves.

[`send_command`](@ref) also retains what it sent. A browser that connects later is replayed the
window and then the highlight, so it comes back to the scene you are looking at.

## 5. Answer a click

Your module reports a click on a pole upward, on its own `picked` topic. Register a listener for it:

```julia
on_event(server, "poles", "picked") do ev, reply
    command!(reply, "poles", "highlight", (; names = [ev.payload.name]))
end
```

Click a pole. It turns orange, and the pole that was orange goes back to cyan.

That is the round trip: the module reports, the server decides, and the answer comes back as a
command. The module changes nothing on its own. The server is the only author of what the scene
shows, so the next window it pushes cannot disagree with what a click did.

`ev.payload` is the object your module passed to `ctx.notify`. The pole's index never travels here:
the name is your module's own vocabulary, and a name survives a window that renumbers the poles.

Stop the server when you are finished:

```julia
stop_server(server)
```

## What the Core cleans up

Every registration `ctx` offers hands back a **Disposable** — a function that undoes it. The Core
records each one against your module and drains them all on unload, whether or not you collect them.
A module cannot leave a handler behind in a shared service.

What the Core does not know about is what you build yourself. This module adds a
`PolylineCollection` to the scene, so this module removes it. That is the work of the function
`setup` returns.

## Where to go next

- [Write a module with no build step](../how-to/no-build-module.md) grows this one file into several,
  reaches a library on the web, and writes a module out of a Julia string.
- [Ship a module from a Julia package](package-with-module.md) puts this file in a package with a
  payload vocabulary of its own, so a user of that package writes only Julia.
- [The module API](../reference/wire/module-api.md) is the normative contract: every key of `ctx`,
  how a keyframe addresses an array, and what the vendored modules already do.
- [Modules, vocabularies and glue](../explanation/modules.md) explains when to write a module at all.
