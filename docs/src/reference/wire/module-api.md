# CesiumLink module API — version 1

Normative contract between the viewer's Core and a **module**: one ES module, served same-origin,
that the Core loads because a server declared it. A module draws what the vendored renderer cannot: a
shader-driven heatmap, a raster coverage field, a widget kind of your own.

Most scenes need none. `primitives` draws points, polylines and regular-polygon ground footprints
from payloads built in Julia, and `ui` owns the overlay and the tooltip, so a time-dynamic scene
ships with no JavaScript at all. Write a module when you reach the edge of that.
[`protocol.md`](protocol.md) states the wire the declaration and the payloads travel on.

`lib/ui/` and `lib/primitives/` are two working modules built against this contract.

## The unit

A module's default export is an object with a `setup`:

```js
export default {
  setup(ctx) {
    // build primitives, register handlers
    return () => { /* optional teardown */ };
  },
};
```

`setup` runs **once**, when the module loads. The Core passes it the context described below. If
`setup` returns a function, the Core calls it on unload.

That shape is the `ViewerModule` type, exported from `lib/core`, so a TypeScript module can annotate
its default export with it.

Every registration `ctx` offers returns a **disposable**: a zero-argument function that undoes it.
The Core records each one against the module that made it and drains them all on unload, whether or
not `setup` returned a teardown of its own. A module that adds Cesium primitives to the scene must
remove them itself, in the returned teardown.

The Core warns about and skips a module that throws during import or during `setup`. The other
modules still load, and the viewer still runs.

## The one hard rule: one Cesium

**A module must not `import` `@cesium/engine` at run time.** Import it for types only: the build
erases the type annotations, so no code survives them. Reach the live namespace through
`ctx.Cesium`.

```ts
import type { Cartesian3, Scene } from "@cesium/engine";   // erased
// const C = await import("@cesium/engine");                // never
```

Two live copies of Cesium in one page is the dual-package hazard: a primitive built by one cannot be
added to the other's scene, and the failure shows as blank geometry. `ctx.Cesium` is the Core's own
instance, and every module shares it.

The same applies to everything else the Core owns: the scene, the clock, the pointer handler and the
overlay arrive through `ctx`. A module constructs none of them.

## `ctx`

One options bag. A module reads only the keys it needs, so adding keys is never a breaking change.

### Identity and scene

```ts
readonly id: string;                                // this module's declared id
readonly Cesium: typeof import("@cesium/engine");   // the one shared namespace
readonly viewer: CesiumWidget;
readonly scene: Scene;
readonly container: HTMLElement;                    // the element the viewer was created in
readonly clock: Clock;                              // read it; the Core drives it
```

`id` is the id the server declared. The Core stamps it onto this module's pick ids and onto the
events it sends.

### Time

```ts
onWindow(cb: (w: WindowInfo, payload: unknown) => void): Disposable;
onFrame(cb: (f: Frame) => void): Disposable;
onKeyframe(cb: (index: number) => void): Disposable;
placement(index: number): Placement | null;
perWindow<T>(): Timeline<T>;       // a store for what a window handed this module

readonly frame: Frame | null;      // where the clock is now, or null before the first tick
readonly window: WindowInfo | null;

interface Frame { index: number; alpha: number }

interface Placement {
  window: WindowInfo;              // the window carrying that absolute keyframe
  k: number;                       // window-relative index — `index - window.startFrame`
}

interface Timeline<T> {
  install(value: T, window: WindowInfo): void;
  at(p: Placement | null | undefined): { w: T; k: number } | undefined;
  latest: T | undefined;           // the most recently installed value
  clear(): void;
}

interface WindowInfo {
  startFrame: number;              // absolute index of the payload's first frame
  count: number;                   // keyframes this window carries
  id: number | null;               // window identity, for supersession guards
  mode: "replace" | "append";
  totalFrames: number;             // the declared range
  dtSeconds: number;               // mission-time seconds between keyframes
  epoch: JulianDate;               // mission time of absolute frame 0
}
```

- **`onWindow`** fires once per delivered window, with the payload the server addressed to **this**
  module and nothing else. A module absent from a window's `payloads` map is not called for that
  window. A module whose import finishes after a window lands gets the last payload addressed to it
  at registration.
  A window that **extends** the buffer fires no crossing: the keyframe on screen does not change. An
  `append` that continues the buffer extends it. Any other window re-indexes, so it fires a crossing
  at the index the clock is on, as part of delivering it, provided the window carries that index.
  Where it does not, the first tick that covers that index fires the crossing instead.
  **Do not draw at install time.** A module that draws per crossing registers `onKeyframe` and
  nothing else. A module that interpolates per tick also places its primitives in `setup` (see
  *Place the primitives before the first render*).
- **`onFrame`** fires every render tick the buffer covers the clock for. `index` is the bracketing
  absolute keyframe and `alpha ∈ [0,1)` the blend toward `index + 1`. **This is where interpolation
  happens**: in the module, next to its own arrays, never throttled.
- **`onKeyframe`** fires once per crossing into an absolute keyframe index, for every module, not
  only one that drives geometry. The Core calls a handler registered after a crossing for that
  crossing, on the microtask that follows, so load order does not decide whether it has drawn.
  `onWindow` delivers its held payload at once, so your store holds the window before the crossing
  reaches you, whichever you registered first.
- **`placement`** answers *which* window carries an absolute keyframe, and where in that window the
  keyframe sits. It is null where no retained window covers it, which is not an error: a module with
  nothing to say for a keyframe leaves what is on screen alone.

Indices are **absolute within the declared range**, and `placement` maps one onto a module's own
arrays. It answers for exactly the frames the buffer covers, and for nothing outside them. **Do not
rebuild this mapping module-side**: it duplicates the Core's bookkeeping.

Keep what a window handed you in a **`ctx.perWindow<T>()`** store and read it at the placement:

```ts
const held = ctx.perWindow<MyWindow>();
ctx.onWindow((w, payload) => held.install(payload as MyWindow, w));
ctx.onKeyframe((index) => {
  const at = ctx.placement(index);
  const mine = held.at(at)?.w;    // undefined where this module holds nothing for that keyframe
  if (at && mine) draw(mine, at.k, at.window.count);
});
```

`install(value, window)` records a value, `at(placement)` reads it back as `{ w, k }`, `latest` is
the most recent value, and `clear()` drops all of it. Each call to `perWindow` makes a store of its
own and registers nothing on the Core.

The store keys on the **window object**, never on `startFrame`. A `replace` gives the same absolute
indices to a different window, so a number-keyed map addresses the wrong one across the seam. The
object key is also why the store needs no retention bound.

`readonly frame` is where the *clock* is, which is not always a keyframe the buffer covers: a scrub
past the delivered frames reports where the user went. That index is what the Core stamps on this
module's events. So its `placement` may be null.

A `replace` window clears the buffer and may renumber entities; an `append` extends it and preserves
the index space. Modules do not install windows, declare schedules or request keyframes: the Core
owns the buffer, the coverage bookkeeping and the requests.

### Payloads

A window's payload, and a command's, arrive **decoded**. Every encoded array inside them, at any
nesting depth, arrives as

```js
{ data: Float32Array, shape: [264, 3] }
```

`shape` is row-major with the last dimension varying fastest, the reverse of the `size` the array had
in Julia. The Core interprets nothing else about a payload's structure.

The dtypes are `f32`, `f64`, `u8`, `u32` and `i32`, and **only those arrive as typed arrays**. The
server walks an array of anything else element by element into an ordinary JSON list, which is how a
list of label strings travels.

A numeric array of any other element type converts to the one that carries it without loss, so what a
Julia author writes decides which typed array a module receives:

| the payload's author holds | the module receives | |
|---|---|---|
| `Float32`, `Float64` | `Float32Array`, `Float64Array` | |
| `UInt8`, `UInt32`, `Int32` | `Uint8Array`, `Uint32Array`, `Int32Array` | |
| `Bool` (and `BitVector`) | `Uint8Array` | read a flag as `data[i] !== 0` |
| `Int8`, `Int16`, `Int64` | `Int32Array` | the server errors unless every value fits `Int32` |
| `UInt16`, `UInt64` | `Uint32Array` | the server errors unless every value fits `UInt32` |
| `Float16` | `Float32Array` | |
| any other `<: Number` | — | the server errors rather than sending it |
| anything not `<: Number` | a plain JavaScript array | strings, nested objects, `Array{Any}` |

So a Julia `Vector{Int}`, which is 64-bit, arrives as an `Int32Array` rather than as a nested plain
array. There is no 64-bit integer dtype: the server refuses a value past `Int32`, and it travels only
if its author converts it to `Float64`.

#### An array is a view into the frame, not a buffer of its own

`data.buffer` is the **whole received frame**, and `data.byteOffset` is where this array sits in it.
The array is a view: nothing copies the bytes, and a copy costs about 1 ms per megabyte.

Two things follow.

- A module that keeps a slice past its window keeps the frame alive with it. Retention is bounded:
  `ctx.perWindow<T>()` keys on the `WindowInfo` object, and `primitives` holds two windows across a
  seam, so about twice a window is the ceiling.
- To detach a copy, write `new Float32Array(a.data)`.

Nothing travels upward as bytes. The Core refuses a typed array in an event payload, with a message
naming `Array.from()`. The server is authoritative (ADR-0007), so bulk data flowing upward inverts
the model.

#### How a keyframe addresses an array

```ts
isNdArray(v: unknown): v is NdArray;
blockAt(a: NdArray, k: number, baseRank: number, count: number): Block | null;

interface NdArray { data: TypedArray; shape: number[] }

interface Block {
  data: ArrayLike<number>;
  offset: number;                  // where the block starts in `data`
  len: number;                     // values in it: the product of the trailing dimensions
  keyframed: boolean;              // true when the values switch at keyframe crossings
}
```

**This is the one rule that says how far an array varies, and the Core implements it once.** A module
knows the **base rank** of the form it expects — 1 for a value per entity, 3 for an `[H, W, 4]`
raster. Then:

- An array **at or below** the base rank holds one value for the whole window. Every keyframe reads
  all of it, and `keyframed` is false.
- An array **one rank above** the base rank carries a leading keyframe axis. Keyframe `k` is the
  block at `k × len`, where `len` is the product of the trailing dimensions. Shapes are row-major, so
  that block is contiguous, and the trailing Julia axis is the keyframe.
- Any higher rank is an error, and `blockAt` throws.

`count` is the keyframes the window carries, which is `placement(index).window.count`. An array whose
leading axis disagrees with it throws: a payload that claims seven keyframes inside a window of five
is a bug. `blockAt` returns null where `k` falls outside the window, which is not an error.

`blockAt` does the arithmetic and nothing else. Every check about what the values **mean** stays in
the module that owns the form: the components an entity takes, the four RGBA bytes of a texel.

```js
const at = ctx.placement(index);
if (!at) return;
const block = ctx.isNdArray(v) ? ctx.blockAt(v, at.k, 1, at.window.count) : null;
if (block) for (let i = 0; i < block.len; i++) use(block.data[block.offset + i]);
```

A module that builds from this tree may import `isNdArray` and `blockAt` from `core/src/codec.ts`
instead. The two are the same functions: `blockAt` reads no Core state.

### Picking

```ts
pickId(kind: string, idx: number): object;
onPointer(cb: (e: PointerEvent) => void): Disposable;

interface PickEntity { module: string; kind: string; idx: number }

interface PointerEvent {
  type: "hover" | "click";
  entities: PickEntity[];                 // everything owned under the cursor, nearest first
  entity: PickEntity | null;              // the nearest of them
  mods: string[];                         // some subset of "alt", "ctrl", "shift"
  screen: { x: number; y: number };
  getCoordinate(): Cartographic | null;   // globe raycast, lazy and memoised per event
}
```

`pickId` returns an opaque stamp carrying this module's id, its `kind` and its index. Set it as a
pickable primitive's `id` and the Core learns who owns a hit. **A primitive carrying no such stamp is
drilled past rather than picked.**

To draw something over **another** module's entity and have a click report that entity, borrow its
stamp rather than minting one here — see [Anchoring](#anchoring-drawing-over-another-modules-entity).

`onPointer` is **local** dispatch: every registered handler sees every event, returns nothing and
cannot stop the others. Use it for reactions that must not round-trip, such as anchoring a box or a
hover highlight. Anything that *decides* something belongs on the server, as a listener reached
through the subscription the server derives from its own listeners.

A local handler sees every pointer event the Core raises, whether or not the server subscribed to it.
The Core raises a hover on every pointer move, and again from the resting cursor on each keyframe
crossing, so a locally anchored box follows the clock as well as the pointer. The one it does not
raise is a clock-driven hover that resolves to nothing where the last one also resolved to nothing.

### Anchors: letting the camera ride what you draw

```ts
anchors(resolve: (target: string) => AnchorPosition | null): Disposable;

type AnchorPosition = () => Cartesian3 | null;
```

A viewpoint can hold station on a moving thing instead of standing at a point. It names that thing as
`{module, target}`, and the Core hands `target` to whichever module the viewpoint named. **The Core
never reads the string**: what a target name looks like is this module's business, the way a pick
`kind` is. Answer `null` for a name this module does not know.

```ts
ctx.anchors((target) => {
  const m = /^(\w+)\[(\d+)\]$/.exec(target);      // this module's own spelling, not the Core's
  if (!m) return null;
  return () => positionOf(m[1], Number(m[2])) ?? null;
});
```

The Core asks the getter again every rendered frame, so answer with where the thing is **now**.
Nothing here predicts where it will be. A viewpoint that states a `range` or an angle does not fly to
that seat in world coordinates: it installs the frame first, then closes on the seat inside it, tick
by tick.

Answer `null` once the thing is gone: a family that shrank, a window that renumbered it. The camera
then lets go and says so. The Core resolves an anchor when the viewpoint **applies**, never when the
track arrives, so a target that does not exist yet is not an error.

The resolver is keyed by this module's own id, so no module answers for another's names. Unloading
the module withdraws it, and a camera riding one of its anchors lets go.

### Assets

```ts
assetUrl(path: string): string | null;
```

A scene may name folders of its own for the server to serve, and a payload then points at a file in
one. `assets/<mount>/<file>` travels on the wire. `assetUrl` turns it into a URL this host can fetch:
pass the result to `fetch`, to a Cesium loader, or to an `<img>`.

**Always resolve; never concatenate.** The four hosts disagree about where a mount is: the server
serves a browser page itself, so the declared path already resolves; a webview page lives at an
origin that holds no files, and every folder the extension grants it gets its own opaque URI; a
recording player has no server at all. A module that builds the URL itself fails silently in the
editor panel.

```js
const url = ctx.assetUrl(spec.uri);          // "assets/models/sat.glb"
if (url) entity.model = { uri: url };        // and nothing at all if it did not resolve
```

**An unresolvable path answers `null` and warns once**: a path that is not `assets/<mount>/<file>`, a
mount the session never declared, or one this host cannot reach. It never throws, because a throw
inside a window callback takes down more than the one family that asked. Draw what you can and skip
the rest. The warning is one line per distinct path.

The mounts are the `assets` map of the `modules` declaration ([`protocol.md`](protocol.md)).
They are fixed for the session: the extension gives a webview the folders it may read when it creates
the panel, and a new folder needs a new panel.

### Messaging

```ts
onCommand(topic: string, cb: (payload: unknown, seq: number | null) => void): Disposable;
notify(topic: string, payload?: unknown): void;
```

`onCommand` registers the single handler for one of this module's command topics. **One handler per
topic**: the Core refuses and warns about a second registration for the same topic, so a module
cannot silently shadow its own routing.

`seq` is the sequence number of the event the arriving batch answers, or `null` for a command the
server sent on its own. **A stale reply is the module's business, not the Core's.** The Core applies
every batch: a late answer to a click can still be worth having, a late answer to a hover usually is
not. A module that cares keeps the `seq` of the last event it sent and compares.

The Core retains the latest command per topic and replays it to the handlers `setup` registers, in
the order the topics were sent, after every declared module's `setup` returns. The wait makes a
server's reconnect replay safe: retained commands land before any handler exists. A replayed command
carries the `seq` it first arrived with, and sees what every module contributed, not only the modules
declared ahead of its own.

`notify` sends `event {module: <this id>, topic, payload}` upward. The Core stamps the sequence
number, the absolute frame the clock is on and the identity of the window on screen. The payload is
the module's own and stays opaque to the Core. No subscription gates it, and it is a no-op when no
transport is attached.

### Overlay

```ts
readonly overlay: { addControl(region: OverlayRegion, el: HTMLElement): Disposable };
type OverlayRegion = "top-left" | "top-center" | "top-right" | "bottom-right";
```

The Core owns the positioned regions and stacks contributions within one in insertion order. **A
module never absolute-positions its own overlay.** A region host is click-through and each control
re-enables pointer events on itself, so the gaps between stacked controls never steal a globe drag.

### Other modules

```ts
readonly modules: { get(id: string): unknown | undefined };
```

Returns another module's exports, **code only**: classes, factories, functions. Shared mutable
runtime state across modules is not supported.

**Every module the same declaration named is reachable, whatever order the two were declared in.** A
module never reaches its own exports, and an id nobody declared returns `undefined`. A module may
both feed another and extend it.

Order still decides *when* a peer's `setup` runs, so **do not call another module's functions from
inside your own `setup`**. Every module's exports exist by then, but an accessor that reads state the
peer builds in its own `setup` answers `undefined` until that setup runs. Call a peer from a frame,
window or command callback instead. The Core catches the mistake rather than answering wrongly, with

```
module <yours>: reached <peer> during setup, before <peer>'s own setup ran; its state is not built yet — read it from a frame, window or command callback instead
```

and still hands back the exports, so the warning changes nothing.

**One owner per entity.** A module may read what another draws through accessors that provider
exports, and may draw its own primitives coincident with them; it may never restyle or mutate
another module's. A viewer-side mutation has no author on the server, so the next window silently
overwrites it. A decoration that must persist is data, and the server sends it.

**A module that owns entities and wants them anchorable exports `positionOf(kind, idx)`**, which
returns the live interpolated position of that entity or `undefined`. `ui` calls it on the module a
floating object's anchor names. A module that does not export it cannot be anchored to, and a float
naming it hides.

`kind` names whatever a module calls its families, and a module answers for every kind it draws, not
only the ones whose position it holds outright. [The vendored modules](#the-vendored-modules) states
what the vendored renderer resolves, and in what order.

```ts
export function positionOf(kind: string, idx: number): Cartesian3 | undefined;
```

#### Anchoring: drawing over another module's entity

Position alone is enough for a label or a box, but not for a shape the pointer can hit. `ctx.pickId`
closes over **your** module id, so a sensor cone you draw over another module's satellite is either
unpickable or reports a kind no server listener knows.

**A module that owns entities publishes their stamps; a module that draws something anchored sets the
stamp it is given.** The vendored renderer publishes three accessors beside `positionOf`:

```ts
export function pickIdOf(kind: string, idx: number): object | undefined;
export function showOf(kind: string, idx: number): boolean | undefined;
export function countOf(kind: string): number | undefined;
```

`countOf` says how many entities a family holds, which a module drawing **one primitive per entity**
needs before it builds anything: an anchored family carries no positions of its own. Read it per
window, because a replacing window may resize the family under you.

Set the stamp as your primitive's `id` and do nothing else. A click on your cone then reports
`{module: "primitives", kind: "sat", idx: 12}`: the satellite, in the owner's namespace. The Core
collapses two primitives carrying one stamp into one stack entry, so the cone and the satellite's own
marker are one entity in the event.

**Where your primitive's `id` is not free, hang the stamp on its `pickId` property.** Cesium's entity
visualizers set an entity's primitives' `id` to the `Entity` itself, so a module drawing through the
entity API cannot put the stamp there. The Core reads that one property as a fallthrough:

```ts
const p = peer.pickIdOf("sat", i);
entity.pickId = p;              // drawn through the entity API
primitive.id  = p;              // drawn as a primitive of your own
```

The property name is contract, not implementation detail. A primitive carrying neither form is still
decoration and never masks a pickable underneath it.

Three rules come with it.

- **Borrow, never mint.** The stamp must come from the owner's export. A stamp you build yourself
  lets your module speak for entities the owner never offered, and nothing detects it.
- **Expect `undefined` on any frame.** A replacing window prunes the family you are anchored to,
  under you. Draw what you can and skip the rest.
- **Hide with your anchor.** A masked entity keeps its index and is not pickable. `showOf` keeps a
  cone from standing over a satellite that nothing on screen shows.

A module that wants an identity of its own keeps calling `ctx.pickId`. The choice is per family.

## Loading

The server declares an id, a URL and an API version per module, in the `modules` message of
[`protocol.md`](protocol.md).

**`apiVersion` gates the import.** The Core compares it against the version it implements, **1**,
*before* it imports. A module written against a different version never runs its code: the Core warns
about the mismatch and skips that module, and the rest of the declaration still loads. The number is
`API_VERSION` in `lib/core/src/index.ts`, and defaults into `ModuleEntry` from `MODULE_API_VERSION`
in `src/messages.jl`. It is unstable and bumps whenever this contract changes in a way a loaded
module can notice. A new key on `ctx` is not such a change.

**The declaration loads in three passes.** The Core imports every module first, concurrently, so
nothing runs until the whole set is in hand. Then each `setup` runs, in declaration order. Then the
Core replays the retained commands, after every `setup` returns.

**Declaration order therefore decides draw order and overlay stacking, and nothing else.** Because
the imports run concurrently, a module whose URL never answers delays every module's `setup`, not
only those declared after it.

The module set is fixed **per connection**. The Core refuses a second declaration on one connection:
to change the set, the client reconnects.

## Shipping a module

The server declares a **file on disk** and mounts that file's directory under `/modules/<id>/`. So
the module and its siblings — chunks, workers, images — are served same-origin with the page.

A module ships from its own package when its vocabulary names a domain concept, such as a rain fade
or an elevation angle. A module that is told only a shape, a value or a colour is vendored instead.

```julia
register_module!(server, :rainfade, joinpath(pkgdir(RainFade), "assets", "rainfade.js"))
```

Registration order is the order the viewer draws and stacks the modules in. A registration after a
client connects has no effect on that client.

**A module needs no build step unless the browser cannot resolve what it imports.** The Core imports
the registered file natively, so two forms work with no bundler:

- **Several files, imported relatively.** `import { pole } from "./shapes.js"` resolves against the
  entry's URL and is served from the same mount. Write the extension; the browser adds none.
- **A ready-made library file beside the entry.** Put it in the mount by a copy or a symlink, then
  reach it with `await import(new URL("lib.min.js", import.meta.url).href)`. A bundler does not
  follow a computed specifier, so a large library stays out of the bundle and the browser caches it
  once per URL. A UMD bundle installs its name on `globalThis`: read the API back from there.
- **A library named by an absolute URL**, such as `https://cdn.jsdelivr.net/npm/d3-scale@4/+esm`. The
  browser fetches it, so the CDN must send `Access-Control-Allow-Origin`, and the page stops being
  offline-capable: the viewer otherwise reaches no host but the one that served it. Copy the file
  into the module's directory and import it relatively to get that back.

A build is left for TypeScript, which the browser does not load, and for a dependency named by a bare
specifier, which the browser cannot resolve. The vendored modules are built like this, and any
third-party module can copy it:

```js
// build.mjs
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",              // the Core imports it with import()
  sourcemap: true,
  outfile: "assets/heatmap.js",
  // No `external: ["@cesium/engine"]` is needed: the source imports it for types only,
  // so nothing of it survives the build.
});
```

The output is one ES module with a default export. Nothing else about it is prescribed: no manifest,
no naming convention, no registration side-effect.

**To consume another module's exports, use `ctx.modules`.** It is the one mechanism: the provider is
reachable wherever either was declared, and the Core version-gated it already.

Marking a provider `external` and aliasing it to `/modules/<id>/<file>.js` also works, because the
browser keys instances by resolved URL. It bypasses the `apiVersion` gate entirely: the browser
resolves the import and the Core never sees it. Keep that route for what it is for: not shipping a
second copy of a third-party library a sibling module already bundles.

## A worked module

Complete and registerable as it stands. It draws one point per entity from the payload the server
addresses to it, interpolates positions every tick, makes each point pickable, paints a subset red on
a `highlight` command, and reports the cursor upward when it rests on one.

```js
// assets/dots.js — a module in one file, no build step
export default {
  setup(ctx) {
    const { Cesium, scene } = ctx;
    const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const scratch = new Cesium.Cartesian3();

    let track = null;            // {data: Float32Array, shape: [count, n, 3]}, or [n, 3] if static
    let win = null;              // the window the track rode in on
    let n = 0;
    let highlighted = new Set();

    // Blend toward the next keyframe. The base rank of a position is 2, `[n, 3]`, so a family with
    // no leading keyframe axis stands still and both ends of the blend are the one block it has.
    const place = (index, alpha) => {
      if (!track) return;
      const last = win.count - 1;
      const i = Math.max(0, Math.min(index - win.startFrame, last));
      // Both keyframes are clamped inside the window, so neither block comes back null.
      const a = ctx.blockAt(track, i, 2, win.count).offset;
      const b = ctx.blockAt(track, Math.min(i + 1, last), 2, win.count).offset;
      const t = 1 - alpha;
      for (let k = 0; k < n; k++) {
        scratch.x = track.data[a + k * 3]     * t + track.data[b + k * 3]     * alpha;
        scratch.y = track.data[a + k * 3 + 1] * t + track.data[b + k * 3 + 1] * alpha;
        scratch.z = track.data[a + k * 3 + 2] * t + track.data[b + k * 3 + 2] * alpha;
        // Assign, never mutate what the getter returns: the setter is what marks the primitive
        // dirty, and a point written through its own position object never moves.
        points.get(k).position = scratch;
      }
    };

    const paint = () => {
      for (let k = 0; k < n; k++) {
        points.get(k).color = highlighted.has(k) ? Cesium.Color.RED : Cesium.Color.CYAN;
      }
    };

    const disposables = [
      // One window's payload for this module, arrays already decoded.
      ctx.onWindow((w, payload) => {
        track = payload.position;
        win = w;
        n = track.shape[track.shape.length - 2];
        points.removeAll();
        for (let k = 0; k < n; k++) {
          points.add({
            position: new Cesium.Cartesian3(),
            pixelSize: 10,
            // The stamp that makes this point pickable and tells the Core who owns it.
            id: ctx.pickId("dot", k),
          });
        }
        // Place and paint before the first render rather than waiting for a tick: a point left at
        // the centre of the globe is not a position any camera can frame, and a command retained
        // from before this window arrived when there was nothing yet to paint.
        place(ctx.frame?.index ?? w.startFrame, 0);
        paint();
      }),

      // Every render tick the buffer covers.
      ctx.onFrame(({ index, alpha }) => place(index, alpha)),

      // One command topic, addressed as {module: "dots", topic: "highlight"}.
      ctx.onCommand("highlight", (payload) => {
        highlighted = new Set(payload?.idx ?? []);
        paint();
      }),

      // Local reaction, no round trip: report the cursor upward only when it is over one of ours.
      ctx.onPointer((e) => {
        if (e.entity?.module === ctx.id) ctx.notify("hovered", { idx: e.entity.idx });
      }),
    ];

    return () => {
      for (const dispose of disposables) dispose();
      scene.primitives.remove(points);
    };
  },
};
```

Two things in it need naming:

- **A retained command can arrive before the first window.** The server replays what it retains in
  the order it was sent, so a command sent before any window also arrives before any window on the
  replay. A handler that only writes into primitives that do not exist yet does nothing. Keep what
  the command said and apply it again when the window lands, which is what `highlighted` and
  `paint()` are for.
- **A module that interpolates per tick places its primitives before the first render**, not on the
  first tick. A primitive left where a bare `new Cartesian3()` puts it sits at the centre of the
  globe, and the renderer cannot frame a scene whose near plane comes from that. A module that draws
  per crossing needs none of this.

Serve and drive it from Julia:

```julia
register_module!(server, :dots, joinpath(@__DIR__, "assets", "dots.js"))

push_window(server, Dict(:dots => (; position = positions));   # 3 × N × count, Float32
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)

send_command(server, "dots", "highlight", (; idx = [0, 3, 7]))   # 0-based, as the wire is

on_event(server, "dots", "hovered") do ev, reply
    @info "hovered" ev.payload.idx ev.frame
end
```

Indices inside a module payload are the module's own convention. The wire is 0-based everywhere the
Core reads it, and CesiumLink converts only what it interprets: the window's start frame, a pointer
event's entity index, a `Title`'s keyframe keys, an `Entity` anchor's index. It does not convert a
payload it does not interpret.

## The vendored modules

`primitives`, `ui`, `heatmap` and `models` ship inside the core dist and load only when a server
declares them, through the same call as anyone else's. `CesiumLink.vendored(:primitives)` and its
siblings return their declaration entries.

They implement this contract and nothing more:

- **`primitives`** draws node, edge and area families from one payload per window, and exports
  `positionOf`, `countOf`, `edgeEndpoints`, `pairsOf`, `pickIdOf` and `showOf` as read-only
  accessors for a module drawing alongside it. There is no setter, by design.

  Its `positionOf` answers for all three families, in the order **node, area, edge**: a node family
  gives the entity's position, an area family the centre its footprint stands on, and an edge family
  the midpoint of the link, so a float on a link sits on the link. Every answer is read live and the
  midpoint recomputed per call, so an anchor follows the per-tick interpolation. A kind no family
  owns, an index a family does not have, and an edge missing either end each resolve to `undefined`,
  and the float naming one hides.

  `pickIdOf`, `showOf` and `countOf` answer for the two families that own entities, **node and
  area**. An edge is a line between two of them and is not something to anchor a primitive to. To
  draw over one, use `edgeEndpoints` and carry an identity of your own. `countOf` answers `undefined`
  for a kind no family owns, which is not the same as a family of zero.

  A camera rides one of its entities through a target of one kind and one index, written `sat[7]`.
  **That index counts from 1**, because it is the index a pointer event hands a Julia listener: a
  listener answers a click with `"$kind[$(ev.entity.idx)]"` and nothing converts in between. The ride
  resolves through `positionOf`, so a camera rides the midpoint of a link as readily as a satellite.
  A target it cannot read, a kind no family owns, and an index a family does not have all answer
  nothing. The Core writes one line and the camera stands still.

  It also exports `defineNodeSprite(name, factory)` and `defineEdgeMaterial(name, factory)`, so
  another module adds a glyph or a line material to the set a family draws from — see
  [Extending a vendored module](#extending-a-vendored-module).
- **`ui`** owns the overlay panel, the tooltip, the floating objects and the widget registry, and
  exports `defineWidget(kind, factory)` so another module can add a widget kind under an
  owner-namespaced name such as `"orbits.shell-picker"`. Nothing about it is privileged: it reaches a
  mounted module the way any module reaches another. So one module can both feed `ui` — a float
  `mount`, a `positionOf` an anchor names — and extend it with a widget kind, from a single
  declaration entry, on either side of `ui`. A box that carries an `id` is an **addressed box**, and
  raises `:click`, `:enter` and `:leave` on the `ui/pointer` topic.
- **`heatmap`** drapes a continuous field over the globe as imagery. It is told a box of degrees and
  a grid of RGBA bytes per raster, in the order the rasters stack, and it copies those bytes onto a
  canvas. It holds no colormap, no legend and no value: the server bakes the colour, which keeps a
  colorbar and its texels from drifting apart. It does not know what the field measures, and it reads
  no value to answer a hover. The server samples the grid it sent.
- **`models`** draws one glTF model per entity of a node family, turned by a reference frame and an
  attitude. It carries no position of its own: a model stands where its anchor stands, and a click
  on it reports that entity in the `primitives` namespace, as though no model were there. It names no
  colour either: what a model looks like belongs to the file.

### Extending a vendored module

A vendored module draws stock things from a list it owns. A module of your own adds to that list
rather than replacing the vendored one.

**One rule names every customizable thing, and the first token of the name says where the thing
comes from.** The four forms cannot collide, so no seam depends on the order they are read in
(ADR-0032):

| The name | Where the thing comes from |
|---|---|
| `data:image/png;base64,…` | the bytes travel in the payload |
| `assets/<mount>/<file>` | the server serves the file, and the host rebases the URL |
| `orbits.pulse` — holds a `.` | a module registered it in the browser under its own id |
| `star` — holds neither | a stock name the vendored module owns |

A stock name never holds a `.` or a `/`. **Namespace a registered name with the id of the module
that registers it**: a name that holds no dot is refused, with a line saying so.

Three seams take a registration:

| Module | Call | What it adds |
|---|---|---|
| `ui` | `defineWidget(kind, factory)` | a widget kind for the overlay and the tooltip |
| `primitives` | `defineNodeSprite(name, factory)` | what a `Nodes` family draws its markers with |
| `primitives` | `defineEdgeMaterial(name, factory)` | the material an `Edges` appearance is drawn in |

```ts
import type { Color, Material } from "@cesium/engine";

type SpriteFactory = () => HTMLCanvasElement | string;
type EdgeMaterialFactory =
  (C: typeof import("@cesium/engine"), look: { color: Color; dashLength: number }) => Material;
```

A sprite factory answers a canvas or an image URL, and **answers the same one every call**: Cesium
keys its texture cache on what comes back, so a fresh canvas per call costs a texture per call. An
edge material factory runs once per distinct appearance and answers a **fresh** material every call:
the family owns what it is handed and destroys it when that appearance goes out of use.

Call `define…` from your own `setup`, and **declare the vendored module first**. Registration order
is the order the viewer runs the setups in, so a module declared ahead of the one it extends reaches
that one before its state is built, and the Core says so.

```js
export default {
  setup(ctx) {
    ctx.modules.get("primitives").defineEdgeMaterial("pulse.travelling", travelling);
  },
};
```

The registry empties when the vendored module unloads, so a factory never outlives the context it
closed over. A name nobody registered writes one line and falls back to the stock default — a
missing material draws solid, a missing sprite draws the disc. It never throws.

**Reach for a registration last.** Prefer a stock name; then an assets mount, for a file; then a
`data:` URI, for something small. A registration is for a thing that needs code in the browser — a
shader, or a canvas drawn per frame.

`examples/PulseEdges/` is both halves of one registration in working code: the JavaScript that
registers an edge material, and the Julia `Edges` family that names it.

### Filling a `ui` content site

A **floating object** is a declared box at a point on screen — `CesiumLink.Floating`, declared as a
set with `declare_floating`. Its content is either a server-authored HTML fragment or a **mount**:
a plain element handed to a named module, which owns everything inside it.

```ts
type MountFactory = (site: MountSite) => Mount | void;

interface MountSite {
  el: HTMLElement;             // the box; its contents are the module's alone
  id: string;                  // the site's id — a float's — so two mounts are told apart
  report: (value: unknown) => void;   // reports as the site: the same `ui/control` event a widget sends
}

interface Mount {
  resize?(): void;             // the box was declared again and may be a different size
  dispose?(): void;            // take down everything the module put in it
}
```

A module becomes mountable when it exports `mount` with that signature. **`ui` owns the box, the
module owns everything inside it, and neither reaches across.** The element is plain rather than
shadowed, so a library that installs its stylesheet in `document.head` reaches inside it. A module
named by a float but never declared, or one that exports no `mount`, renders nothing and warns. The
float stays in the declared set, so a later declaration still reconciles against it.

Per-keyframe data reaches a mounted module through **the window addressed to that module**, not
through the float. So a keyframe crossing leaves the mount standing rather than rebuilding it. A
float that shows HTML takes its fragment from `ui`'s own window instead, as below.

`ui` reads a window payload of its own. A declared widget carrying `keyframed` names the fields a
window may supply, and the window carries one value per keyframe for each, addressed by the widget's
`id` and positional from the window's first frame:

```julia
# A control of your own, whose payload is (; id = "load", text = "—", keyframed = ["text"]).
declare_overlay(server, [Readout("load", "—", :top_left)])
readouts = Dict("load" => (; text = ["4.2 Gbps", "5.0 Gbps"]))
push_window(server, Dict(:ui => (; per_keyframe = readouts));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```

No built-in control names a keyframed field, so declare a control of your own to opt in.
`CesiumLink.AbstractControl` documents it.

The declaration remains the only source of structure: a `per_keyframe` entry supplies the fields it
named and no others, and a keyframe an entry says nothing about keeps the value it had. An entry is
for what a widget **displays**; a value the user also owns stays a re-declaration.

An entry rides a window, and windows are pushed ahead of the clock. So **a keyframed widget or float
declared while a scene is already playing shows its declared value until a window carrying its entry
arrives**. A scene that declares one in answer to an event pushes a window too, a `:replace` covering
where the clock is, and the box reads the keyframe on screen as soon as it appears.
`tools/tracks/serve.jl` pins a float from a click that way.

### A module's own window in a float

No vendored module is mountable. A scene that wants a drawn box ships the module that fills it. That
module reads its per-keyframe data from the window addressed to itself, in the vocabulary it defines:
one entry per content site it fills, addressed by the site's id:

```julia
register_module!(server, :charts, joinpath(@__DIR__, "assets", "charts.js"))   # either side of `ui`
register_module!(server, vendored(:ui))
declare_floating(server, [Floating("load"; anchor = Screen(24, 120), mount = "charts")])

seen = Float32[value(u, k) for u in 1:nuser, k in 1:count]     # trailing axis = keyframes
push_window(server, Dict(:charts => (; bars = Dict("load" => (; names, y = seen))));
            start_frame = 1, count, dt_seconds = 60, total_frames = 240)
```

The base rank of a field is the module's own convention (§ Payloads). At a base rank of 1, a flat
array is the same at every keyframe, and an array of rank 2 carries a row per keyframe, with the
trailing Julia axis as the keyframe. So the box follows the clock with no event and no round trip,
and the float that placed it never moves.

### Pointer events on an addressed box

An overlay row, a group box, and a float raise their own pointer events when the declaration carries
an `id`. The `ui` module listens on the DOM element it built, so a crossing never reaches the canvas and
the Core raises nothing for it (ADR-0035). Two topics carry the traffic.

`ui/subscribe` travels downward, and the server retains it as it retains `core/subscribe`. It states
which crossings the server wants, as one list:

```json
{ "module": "ui", "topic": "subscribe",
  "payload": [
    { "id": "run-title", "type": "click", "mods": ["alt"] },
    { "id": null, "type": "enter", "mods": null }
  ]}
```

The module sends a crossing upward when it matches **any** entry. A `null` in a field matches
anything, and an absent field reads as `null`:

| Field | Semantics |
|---|---|
| `id` | Which addressed box the entry covers. `null` → every addressed box |
| `type` | `click`, `enter` or `leave`. `null` → all three |
| `mods` | Exact match on the modifier set held, in any order. `null` → any modifier state. `[]` → only when the user holds none |

An empty list sends nothing upward. The server derives this list from its registered
`on_ui_pointer` listeners and sends it again whenever that set changes, so no author writes it by
hand.

`ui/pointer` travels upward, one event per crossing an entry asked for:

```json
{ "method": "event",
  "params": {
    "module": "ui",
    "topic": "pointer",
    "seq": 42,
    "frame": 17,
    "window": 3,
    "payload": { "type": "click", "id": "run-title", "mods": ["alt"],
                 "screen": { "x": 412, "y": 88 } }
  }}
```

`mods` is the set held at the moment of the crossing, in the order `alt`, `ctrl`, `shift`. The module
measures `screen` against the viewer container, which is the space a `Screen` anchor places a float
in.

`mouseenter` and `mouseleave` do not bubble, so one box raises one crossing whatever its children
are. A box removed while the pointer is inside it raises a synthetic `leave` carrying what its
`enter` carried, so every `enter` has one `leave` after it.
