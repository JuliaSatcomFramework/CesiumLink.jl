# CesiumLink module API — version 1

Normative contract between the viewer's Core and a **module**: one ES module, served same-origin,
that the Core loads because a server declared it. A module is how anything reaches the scene that the
vendored renderer cannot draw — a shader-driven heatmap, a raster coverage field, a sprite atlas whose
glyph depends on entity state, a widget kind of your own.

Most scenes need none. The vendored `primitives` module draws points, polylines and regular-polygon
ground footprints from payloads built in Julia, and `ui` owns the overlay and the tooltip, so a
time-dynamic scene ships with no JavaScript at all. Write a module when you have hit the edge of
that, and read [`protocol.md`](protocol.md) for the wire the declaration and the payloads travel
on.

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

`setup` runs **once**, when the module loads, and is handed the context described below. Whatever it
returns, if it is a function, is called on unload.

That shape is the `ViewerModule` type, exported from `lib/core`, so a TypeScript module can
annotate its default export with it and have the compiler check the contract rather than trust this
paragraph.

Every registration `ctx` offers returns a **disposable** — a zero-argument function that undoes it.
The Core records each one against the module that made it and drains them all on unload, whether or
not `setup` returned a teardown of its own, so a module physically cannot leave a listener behind. A
module that adds Cesium primitives to the scene still has to remove them itself; that is what the
returned teardown is for.

A module that throws during import or during `setup` is warned about and skipped. The others still
load, and the viewer still runs.

## The one hard rule: one Cesium

**A module must not `import` `@cesium/engine` at run time.** Import it for types only — the type
annotations are erased at build and no code survives them — and reach the live namespace through
`ctx.Cesium`.

```ts
import type { Cartesian3, Scene } from "@cesium/engine";   // erased
// const C = await import("@cesium/engine");                // never
```

Two live copies of Cesium in one page is the dual-package hazard: a primitive built by one cannot be
added to the other's scene, a `Cartesian3` from one fails an `instanceof` in the other, and the
failures surface as blank geometry rather than as an error. `ctx.Cesium` is the Core's own instance,
and every module shares it.

The same applies to anything else the Core owns: the scene, the clock, the pointer handler and the
overlay all arrive through `ctx`. A module constructs none of them.

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

`id` is the id the server declared, and is what the Core stamps onto this module's pick ids and onto
the events it sends.

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
  window. A module whose import finishes after a window has landed is handed the last payload
  addressed to it at registration, so load order does not decide whether it has a scene.
  A window that **extends** the buffer fires no crossing: it adds keyframes beside the ones already
  held, so the keyframe on screen is unchanged and the window that already drew it still carries it.
  An `append` that continues the buffer extends it. Any other window re-indexes, so it fires a
  crossing at the index the clock is on, as part of delivering it — provided the window carries that
  index. Where it does not, the first tick a window covers that index fires the crossing instead.
  **Do not draw at install time.** A module that draws per crossing registers `onKeyframe` and
  nothing else; a module that interpolates per tick also places its primitives in `setup` (see
  *Place the primitives before the first render*).
- **`onFrame`** fires every render tick the buffer covers the clock for. `index` is the bracketing
  absolute keyframe and `alpha ∈ [0,1)` the blend toward `index + 1`. **This is where interpolation
  happens** — in the module, next to its own arrays, never throttled.
- **`onKeyframe`** fires once per crossing into an absolute keyframe index, for every module, not
  only one driving geometry. A handler registered after a crossing already happened is called for
  that one on the microtask that follows, so load order does not decide whether it has drawn. The
  wait also frees you from a set registration order. `onWindow` delivers its held payload at once,
  so your store holds the window before the crossing reaches you — whichever you asked for first.
- **`placement`** answers *which* window carries an absolute keyframe and where in it that keyframe
  sits. Null where no retained window covers it — not an error: windows and crossings arrive
  independently, and a module with nothing to say for a keyframe leaves what is on screen alone.

Indices are **absolute within the declared range**. `placement` is how a module maps one onto its own
arrays. It answers for exactly the frames the buffer covers — so every keyframe the Core crosses into
is placed, whether the server streamed the run a window at a time or sent it whole — and for nothing
outside them, since a tick there paints nothing anyway. **Do not rebuild this mapping module-side**:
it is the same bookkeeping a second time, against a retention bound that then has to be kept in step
with the Core's.

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

Put in whatever you want to address by window: the payload itself, or state you built from it.
`install(value, window)` records it, `at(placement)` reads it back as `{ w, k }`, `latest` is the
most recent value, and `clear()` drops the lot. Each call to `perWindow` makes a store of its own,
and it registers nothing on the Core — the store dies with your reference to it.

The store keys on the **window object**, never on `startFrame`. A `replace` gives the same absolute
indices to a different window, so a number-keyed map addresses the wrong one across the seam. Keying
on the object is
also why the store needs no retention bound: a value becomes unreachable exactly when the Core stops
naming its window.

`readonly frame` is where the *clock* is, which is not always a keyframe the buffer covers — a scrub
past the delivered frames reports where the user went, because that is the index the Core stamps on
this module's events and the one a server answering a control has to be told about. Its `placement`
may therefore be null.

A `replace` window clears the buffer and may renumber entities; an `append` extends it and preserves
the index space. Modules do not install windows, declare schedules or request keyframes: the Core
owns the buffer, the coverage bookkeeping and the requests.

### Payloads

A window's payload, and a command's, arrive **decoded**. Every encoded array anywhere inside them, at
any nesting depth, has already become

```js
{ data: Float32Array, shape: [264, 3] }
```

`shape` is row-major with the last dimension varying fastest, which is the reverse of the `size` the
array had in Julia. Nothing else about a payload's structure is interpreted, so what a payload
contains is entirely between the module and whatever authors it.

The dtypes are `f32`, `f64`, `u8`, `u32` and `i32`, and **only those arrive as typed arrays**. An
array of anything else is walked element by element into an ordinary JSON list, which is what makes
a list of label strings work.

A numeric array whose element type is none of the five is converted to the one that carries it
without loss, so what a Julia author writes decides which typed array a module receives:

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

So a Julia `Vector{Int}` — 64-bit, and what an integer literal produces there — arrives as an
`Int32Array` rather than as a nested plain array. There is no 64-bit integer dtype: a value past
`Int32` is refused, and travels only if its author converts it to `Float64`.

#### An array is a view into the frame, not a buffer of its own

`data.buffer` is the **whole received frame**, and `data.byteOffset` is where this array sits in it.
The array is a view: the bytes are never copied, because copying costs about 1 ms per megabyte and
that is most of what the binary wire exists to save.

Two things follow.

- A module that keeps a slice past its window keeps the frame alive with it. Retention is bounded —
  `ctx.perWindow<T>()` is keyed on the `WindowInfo` object, and `primitives` holds two windows
  across a seam — so about twice a window is the ceiling.
- To detach a copy, write `new Float32Array(a.data)`.

Nothing travels upward as bytes. A typed array in an event payload is refused, with a message
naming `Array.from()`: zero arrays go up today, and the server is authoritative (ADR-0007), so bulk
data flowing upward inverts the model rather than using it.

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
  contiguous block at `k × len`, where `len` is the product of the trailing dimensions. Shapes are
  row-major, so that block is contiguous; the trailing Julia axis is the keyframe.
- Any higher rank is an error, and `blockAt` throws.

`count` is the keyframes the window carries, which is `placement(index).window.count`. An array whose
leading axis disagrees with it throws: a payload that claims seven keyframes inside a window of five
is a bug, not a short block. `blockAt` returns null where `k` falls outside the window, which is not
an error — a module with nothing to say for a keyframe leaves what is on screen alone.

`blockAt` does the arithmetic and nothing else. Every check about what the values **mean** — the
components an entity takes, the four RGBA bytes of a texel, the entities in a family — stays in the
module that owns the form.

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
drilled past rather than picked**, so a decoration drawn over something pickable never masks it.

To draw something over **another** module's entity and have a click report that entity, borrow its
stamp rather than minting one here — see [Anchoring](#anchoring-drawing-over-another-modules-entity).

`onPointer` is **local** dispatch: every registered handler sees every event, returns nothing and
cannot bail the others. It exists for reactions that must not round-trip — anchoring a box, tracking
the cursor, a hover highlight. Anything that *decides* something belongs on the server, as a listener
reached through the subscription the server derives from its own listeners.

A local handler sees every pointer event the Core raises, whether or not the server subscribed to it.
It raises a hover on every pointer move, and again from the resting cursor on each keyframe crossing
— so a box anchored locally follows the clock as well as the pointer. The one it does not raise is a
clock-driven hover that resolves to nothing where the last one also resolved to nothing: the cursor
has not moved and the scene under it is still empty.

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

The getter is asked afresh every rendered frame, so answer with where the thing is **now**. Nothing
here has to predict where it will be. A viewpoint that states a `range` or an angle does not fly to
that seat in world coordinates — it installs the frame first and closes on the seat inside it, tick
by tick. A world flight is aimed once, and a satellite crossing 9° of longitude a second is most of
a continent away by the time a four-second flight lands.

Answer `null` once the thing is gone — a family that shrank, a window that renumbered it. The camera
then lets go and says so. The Core resolves an anchor when the viewpoint **applies**, never when the
track arrives, so a target that does not exist yet is not an error.

The resolver is keyed by this module's own id, so no module can answer for another's names. Unloading
the module withdraws it, and a camera riding one of its anchors lets go.

### Assets

```ts
assetUrl(path: string): string | null;
```

A scene may name folders of its own for the server to serve, and a payload then points at a file in
one. `assets/<mount>/<file>` is what travels on the wire; `assetUrl` turns it into a URL this host
can fetch — pass the result to `fetch`, to a Cesium loader, or to an `<img>`.

**Always resolve; never concatenate.** The three hosts disagree about where a mount is. A browser
page is served by the server itself, so the declared path already resolves. A webview page lives at
an origin that holds no files, and every folder the extension grants it gets its own opaque URI. A
recording player has no server at all. A module that builds the URL itself works in the browser and
fails silently in the editor panel.

```js
const url = ctx.assetUrl(spec.uri);          // "assets/models/sat.glb"
if (url) entity.model = { uri: url };        // and nothing at all if it did not resolve
```

**An unresolvable path answers `null` and warns once** — a path that is not `assets/<mount>/<file>`,
a mount the session never declared, or one this host cannot reach. It never throws: a throw inside a
window callback takes down more than the one family that asked. Draw what you can and skip the rest.
The warning is one line per distinct path, because a family resolves once per entity per tick.

The mounts are the `assets` map of the `modules` declaration ([`protocol.md`](protocol.md)).
They are fixed for the session: a webview is given the folders it may read when its panel is created,
and taking a new one needs a new panel.

### Messaging

```ts
onCommand(topic: string, cb: (payload: unknown, seq: number | null) => void): Disposable;
notify(topic: string, payload?: unknown): void;
```

`onCommand` registers the single handler for one of this module's command topics. **One handler per
topic**: a second registration for the same topic is refused and warned about, so a module cannot
silently shadow its own routing.

`seq` is the sequence number of the event the arriving batch answers, or `null` for a command the
server sent on its own. **Deciding what to do with a stale reply is the module's business, not the
Core's** — the Core applies every batch, because a late answer to a click can still be worth having
while a late answer to a hover usually is not, and only the module holding it knows which it has. A
module that cares keeps the `seq` of the last event it sent and compares.

The Core retains the latest command per topic and replays it to the handlers `setup` registers, in
the order the topics were sent, once every declared module's `setup` has returned. This is what makes
a server's reconnect replay safe: the module declaration arrives first and the imports answering it
are asynchronous, so retained commands land before any handler exists. A replayed command carries the
`seq` it originally arrived with, and — because the replay waits for the whole set — sees whatever
every module contributed, not only the modules ahead of its own.

`notify` sends `event {module: <this id>, topic, payload}` upward. The Core stamps the sequence
number, the absolute frame the clock is on and the identity of the window on screen; the payload is
the module's own and is opaque to the Core. It is subject to no subscription — the module already
decided to send it — and is a no-op when no transport is attached.

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

Returns another module's exports — **code only**: classes, factories, functions. Sharing mutable
runtime state across modules is not supported and is what the one-owner rule below exists to prevent.

**Every module the same declaration named is reachable, whatever order the two were declared in.** A
module never reaches its own exports, and an id nobody declared returns `undefined`. Order is not
part of this: a consumer may be declared either side of its provider, and a module may both feed
another and extend it.

The one thing order still decides is *when* a peer's `setup` has run — so **do not call another
module's functions from inside your own `setup`**. Every module's exports exist by then, but an
accessor reading state the peer builds in its own `setup` answers `undefined` until that setup runs.
Call a peer from a frame, window or command callback instead, by which point the whole declared set
is ready. The Core catches the mistake rather than letting it answer wrongly, with

```
module <yours>: reached <peer> during setup, before <peer>'s own setup ran; its state is not built yet — read it from a frame, window or command callback instead
```

and still hands back the exports, so the warning changes nothing but tells you where to look.

**One owner per entity.** A module may read what another draws through accessors that provider
exports, and may draw its own primitives coincident with them; it may never restyle or mutate
another module's. A viewer-side mutation has no author on the server, so the next window silently
overwrites it. If a decoration should persist, it is data, and the server sends it.

**A module that owns entities and wants them anchorable exports `positionOf(kind, idx)`**, returning
the live interpolated position of that entity or `undefined`. `ui` calls it on the module a floating
object's anchor names, so anchoring is a capability of whichever module draws the entity rather than
a property of the vendored renderer; a module that does not export it simply cannot be anchored to,
and a float naming it hides.

`kind` names whatever a module calls its families, and a module answers for every kind it draws —
not only the ones whose position it happens to hold outright. What the vendored renderer resolves,
and in what order, is under [The vendored modules](#the-vendored-modules).

```ts
export function positionOf(kind: string, idx: number): Cartesian3 | undefined;
```

#### Anchoring: drawing over another module's entity

Position alone is enough for a label or a box. It is not enough for a shape the pointer can hit. A
sensor cone drawn over a satellite by a module of its own is either unpickable, or it reports a kind
no server listener knows about — `ctx.pickId` closes over **your** module id, so it cannot say "this
is satellite 12" even when that is exactly what the cone is.

**A module that owns entities publishes their stamps; a module that draws something anchored sets the
stamp it is given.** The vendored renderer publishes three accessors beside `positionOf`:

```ts
export function pickIdOf(kind: string, idx: number): object | undefined;
export function showOf(kind: string, idx: number): boolean | undefined;
export function countOf(kind: string): number | undefined;
```

`countOf` says how many entities a family holds, which is what a module drawing **one primitive per
entity** needs before it can build anything. An anchored family carries no positions of its own, so
nothing else tells it how many to make. Read it per window: a replacing window may resize the family
under you.

Set the stamp as your primitive's `id` and do nothing else. A click on your cone then reports
`{module: "primitives", kind: "sat", idx: 12}` — the satellite, in the owner's namespace. The Core
collapses two primitives carrying one stamp into one stack entry, so the cone and the satellite's own
marker are one entity in the event, exactly as an area's fill and its outline already are.

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

- **Borrow, never mint.** The stamp has to come from the owner's export. Building one yourself lets
  your module speak for entities whose owner never offered them, and nothing detects it.
- **Expect `undefined` on any frame.** A replacing window prunes the family you are anchored to, and
  it does so under you. Draw what you can and skip the rest.
- **Hide with your anchor.** A masked entity keeps its index and is not pickable. `showOf` is what
  keeps a cone from standing over a satellite that nothing on screen shows.

A module that wants an identity of its own keeps calling `ctx.pickId`. The choice is per family, made
by whoever draws.

## Loading

The server declares an id, a URL and an API version per module — the `modules` message of
[`protocol.md`](protocol.md).

**`apiVersion` gates the import.** The Core compares it against the version it implements — **1** —
*before* importing, so a module written against a different one never has its code run: the mismatch
is warned about and that module is skipped, while the rest of the declaration still loads. The number
is in `API_VERSION` in `lib/core/src/index.ts` and defaults into `ModuleEntry` from
`MODULE_API_VERSION` in `src/messages.jl`. It is unstable and bumps whenever this
contract changes in a way a loaded module can notice. A new key on `ctx` is not one of those: a
module reads only the keys it needs, so one it never asked for cannot break it.

**The declaration loads in three passes.** Every module is imported first, concurrently, so nothing
runs until the whole set is in hand. Then each `setup` runs, in declaration order. Then the retained
commands are replayed, once every `setup` has returned — which is why a command applied at load, such
as a `ui` declaration naming a widget kind or a float mounting another module, sees what every module
contributed rather than only what was declared ahead of it.

**Declaration order therefore decides draw order and overlay stacking, and nothing else.** It is an
authorial choice about what is drawn over what, not a dependency ordering. Because the imports run
concurrently, a module whose URL never answers delays every module's `setup`, not only those declared
after it.

The module set is established **per connection**. A second declaration on one connection is refused;
changing the set means the client reconnects.

## Shipping a module

The server declares a **file on disk** and mounts that file's containing directory under
`/modules/<id>/`, so the module and its siblings — chunks, workers, images — are served same-origin
with the page.

A module ships from its own package when its vocabulary names a domain concept — a rain fade, an
elevation angle, a beam. A module that is told only a shape, a value or a colour is vendored instead.

```julia
register_module!(server, :rainfade, joinpath(pkgdir(RainFade), "assets", "rainfade.js"))
```

Registration order is the order the viewer draws and stacks the modules in; a module reaching another
through `ctx.modules` may be registered either side of it. Registering after a client has connected
has no effect on that client.

**A module needs no build step unless the browser cannot resolve what it imports.** The Core imports
the registered file natively, and the server mounts that file's whole directory, so two forms work
with no bundler:

- **Several files, imported relatively.** `import { pole } from "./shapes.js"` resolves against the
  entry's URL and is served from the same mount. Write the extension; the browser adds none.
- **A ready-made library file beside the entry.** Put it in the mount by a copy or a symlink, then
  reach it with `await import(new URL("lib.min.js", import.meta.url).href)`. A computed specifier is
  one a bundler does not follow, so a large library stays out of the bundle and the browser caches it
  once per URL. A UMD bundle installs its name on `globalThis`; read the API back from there.
- **A library named by an absolute URL**, such as `https://cdn.jsdelivr.net/npm/d3-scale@4/+esm`. The
  browser fetches it, so the CDN must send `Access-Control-Allow-Origin`, and the page stops being
  offline-capable: the viewer otherwise reaches no host but the one that served it. Vendoring the
  file into the module's directory and importing it relatively gives that back.

What is left for a build is TypeScript, which the browser will not load, and a dependency named by a
bare specifier, which the browser cannot resolve. The vendored modules are built like this, and any
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

The output is one ES module with a default export. Nothing else about it is prescribed — no manifest,
no naming convention, no registration side-effect.

**To consume another module's exports, use `ctx.modules`.** It is the one mechanism: the provider is
reachable wherever either was declared, and the Core has already version-gated it.

Marking a provider `external` and aliasing it to `/modules/<id>/<file>.js` also works — it is plain
ES modules, and the browser keys instances by resolved URL — but it bypasses the `apiVersion` gate
entirely, since the browser resolves the import and the Core never sees it. Keep that route for what
it is genuinely for: not shipping a second copy of a third-party library a sibling module already
bundles.

## A worked module

Complete and registerable as it stands. It draws one point per entity from the payload the server
addresses to it, interpolates positions every tick, makes each point pickable, paints a subset red
when the server sends it a `highlight` command, and reports the cursor upward when it rests on one.

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

Two things in it are worth naming, because both are invisible until they bite:

- **A retained command can arrive before the first window.** The server replays what it retains in
  the order it was sent, and a command sent before any window is sent before any window on the replay
  too — so a handler that only writes into primitives that do not exist yet does nothing at all. Keep
  what the command said and apply it again when the window lands, which is what `highlighted` and
  `paint()` are for.
- **A module that interpolates per tick places its primitives before the first render**, not on the
  first tick. A primitive left where a bare `new Cartesian3()` puts it sits at the centre of the
  globe, and a scene whose near plane is computed from that is not one the renderer can frame. A
  module that draws per crossing needs none of this: the opening window fires its crossing as part
  of delivering it, which is already before the first render.

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
Core reads it, and CesiumLink converts only what it interprets — the window's start frame, a pointer
event's entity index, a `Title`'s keyframe keys, an `Entity` anchor's index. A payload it does not
interpret it does not convert.

## The vendored modules

`primitives`, `ui`, `heatmap` and `models` ship inside the core dist and load only when a server
declares them, through the same call as anyone else's. `CesiumLink.vendored(:primitives)` and its
siblings return their declaration entries.

A module is vendored when its vocabulary is domain-free: it is told a shape, a value or a colour, and
never a domain concept. A module that must be told about rain fade or elevation angles ships from the
package that owns those words.

The vendored modules implement this contract and nothing more:

- **`primitives`** draws node, edge and area families from one payload per window, and exports
  `positionOf`, `countOf`, `edgeEndpoints`, `pairsOf`, `pickIdOf` and `showOf` as read-only
  accessors for a module drawing alongside it. There is deliberately no setter.

  Its `positionOf` answers for all three families, resolved in the order **node, area, edge**: a node
  family gives the entity's position, an area family the centre its footprint stands on, an edge
  family the midpoint of the link — so a float on a link sits on the link. The node and area answer
  is the same lookup an edge hangs its own endpoints off, so an anchor and an endpoint cannot
  disagree about where a kind sits. Every answer is read live and the midpoint recomputed per call,
  so an anchor follows the per-tick interpolation. A kind no family owns, an index a family does not
  have, and an edge missing either end each resolve to `undefined`, and the float naming one hides.

  `pickIdOf`, `showOf` and `countOf` answer for the two families that own entities, **node and
  area**. An edge is a line between two of them and is not something to anchor a primitive to; draw
  over one through `edgeEndpoints` and carry an identity of your own. `countOf` answers `undefined`
  for a kind no family owns, which is not the same as a family of zero.

  A camera rides one of its entities through a target of one kind and one index, written `sat[7]`.
  **That index counts from 1**, because it is the index a pointer event hands a Julia listener: a
  listener answers a click with `"$kind[$(ev.entity.idx)]"` and nothing converts in between. The ride
  resolves through `positionOf`, so a camera rides the midpoint of a link as readily as a satellite.
  A target it cannot read, a kind no family owns, and an index a family does not have all answer
  nothing; the Core writes one line and the camera stands still.
- **`ui`** owns the overlay panel, the tooltip, the floating objects and the widget registry, and
  exports `defineWidget(kind, factory)` so another module can add a widget kind under an
  owner-namespaced name such as `"orbits.shell-picker"`. Nothing about it is privileged: it reaches a
  mounted module the same way any module reaches another, from wherever either was declared. So one
  module can both feed `ui` — a float `mount`, a `positionOf` an anchor names — and extend it with a
  widget kind, from a single declaration entry, on either side of `ui`.
- **`heatmap`** drapes a continuous field over the globe as imagery. It is told a box of degrees and
  a grid of RGBA bytes per raster, in the order the rasters stack, and it copies those bytes onto a
  canvas. It holds no colormap, no legend and no value: the server bakes the colour, which is what
  keeps a colorbar and the texels it describes from drifting apart. It does not know what the field
  measures, and it reads no value to answer a hover — the server samples the grid it sent.
- **`models`** draws one glTF model per entity of a node family, turned by a reference frame and an
  attitude. It carries no position of its own: a model stands where its anchor stands, and a click
  on it reports that entity in the `primitives` namespace, as though no model were there. So this
  vocabulary names neither a position nor a colour — where a model stands belongs to the family it
  is anchored to, and what it looks like belongs to the file.

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

A module becomes mountable by exporting `mount` with that signature. **`ui` owns the box, the module
owns everything inside it, and neither reaches across.** The element is plain rather than shadowed,
because a library that installs its stylesheet in `document.head` gets nothing of it across a shadow
boundary. A module named by a float but never declared, or one that exports no `mount`, renders
nothing and warns, and the float stays in the declared set so a later declaration still reconciles
against it. Where the mounted module sits in the declaration does not matter; `ui` reaches it from
either side.

Per-keyframe data reaches a mounted module through **the window addressed to that module**, not
through the float, which is why a keyframe crossing leaves the mount standing rather than rebuilding
it. A float showing HTML keyframes its fragment through `ui`'s own window instead, as below.

`ui` reads a window payload of its own, which is how overlay content follows the clock without an
event per keyframe. A declared widget carrying `keyframed` names the fields a window may supply, and
the window carries one value per keyframe for each, addressed by the widget's `id` and positional
from the window's first frame:

```julia
# A control of your own, whose payload is (; id = "load", text = "—", keyframed = ["text"]).
declare_overlay(server, [Readout("load", "—", :top_left)])
push_window(server, Dict(:ui => (; tracks = Dict("load" => (; text = ["4.2 Gbps", "5.0 Gbps"]))));
            start_frame = 1, count = 2, dt_seconds = 60, total_frames = 240)
```

None of the built-in controls names a keyframed field, so the opt-in is reached by declaring a
control of your own — `CesiumLink.AbstractControl` documents the whole of it.

The declaration remains the only source of structure — a track supplies the fields it named and no
others — and a keyframe a track says nothing about keeps the value it had. It is for what a widget
**displays**; a value the user also owns stays a re-declaration.

A track rides a window, and windows are pushed ahead of the clock, so **a keyframed widget or float
declared while a scene is already playing shows its declared value until a window carrying its track
arrives** — every window already buffered was built before it existed and addresses nothing to it. A
scene declaring one in answer to an event pushes a window too, a `:replace` covering where the clock
is, and the box reads the keyframe on screen from the moment it appears. `tools/tracks/serve.jl`
pins a float from a click that way.

### A module's own window in a float

No vendored module is mountable; a scene that wants a drawn box ships the module that fills it. That
module reads its per-keyframe data from the window addressed to itself, in the vocabulary it defines
— one entry per content site it fills, addressed by the site's id:

```julia
register_module!(server, :charts, joinpath(@__DIR__, "assets", "charts.js"))   # either side of `ui`
register_module!(server, vendored(:ui))
declare_floating(server, [Floating("load"; anchor = Screen(24, 120), mount = "charts")])

seen = Float32[value(u, k) for u in 1:nuser, k in 1:count]     # trailing axis = keyframes
push_window(server, Dict(:charts => (; bars = Dict("load" => (; names, y = seen))));
            start_frame = 1, count, dt_seconds = 60, total_frames = 240)
```

The base rank of a field is the module's own convention (§ Payloads). At a base rank of 1 a flat
array is the same at every keyframe, and an array of rank 2 carries a row per keyframe, the trailing
Julia axis being the keyframe as everywhere else. So the box follows the clock with no event, no
round trip, and no re-declaration — the float that placed it never moves.
