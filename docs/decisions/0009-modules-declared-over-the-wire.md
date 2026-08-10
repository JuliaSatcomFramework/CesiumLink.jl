---
status: accepted
---

# Modules are declared over the wire, and their assets are mounted by path

The server tells the viewer which ES modules to load. A declaration travels over the WebSocket as
part of establishing a connection — an id, a URL and an API version — and the Core builds them from
it. Declaration order is draw order: it decides what is drawn over what and how overlay
contributions stack, and nothing else.

A declaration is authored in Julia by naming a **file on disk**. The server mounts that file's
directory under a URL segment derived from the module id and serves it same-origin, so any Julia
package can ship a bundle by pointing at its own assets folder. Vendored modules ship inside the
core dist and are declared through the same call as anyone else's: there is no privileged loading
path, and a vendored module that nobody declares does not load.

## Loading is three passes, and order does not decide reachability

The Core loads a declaration in three passes. It imports every module first, concurrently, running
no `setup`. It then runs each `setup` in declaration order. It then replays the retained commands,
once every `setup` has returned.

A module may both **feed** `ui` — a float `mount`, or a `positionOf` an anchor names — and **extend**
it with `defineWidget`. Under a single total order such a module would have to be declared both
before and after `ui`, which is unwritable as one declaration entry; and splitting it in two does
not work either, because `ui` applies its own retained declaration during its `setup`, so a widget
kind registered by a later module would arrive too late and its row would never be built. Deferring
the replay to the third pass is what makes both possible, and it needs nothing of `ui` itself.

Order therefore keeps one meaning — draw order and overlay stacking — which is an authorial choice
about what is drawn over what rather than a dependency puzzle. A dependency declaration, the
`requires` that ADR-0006 rejects for having no consumer, stays unbuilt. ADR-0006's one-owner rule is
untouched: this governs *when* a module may be reached, never what it may do with what it reaches.

## Considered options

- **Declared over the wire, assets mounted by path** (chosen).
- **Static manifest folders discovered from a server-provided list.** Rejected for the inverse of
  the reason such a manifest is usually adopted: its value is making a folder a self-contained
  drop-in unit, but the unit that actually travels is a **Julia package**, which already has a name,
  a version and a place to put assets. A manifest duplicates all three into a file the Core must
  fetch and validate before it can do anything, and the version gate it exists for is one field in a
  message the connection already sends.
- **Bundle every module into the core build.** Rejected: it makes a third-party module impossible,
  which is the whole point of the seam.

## Consequences

Startup costs no manifest round trips: the Core fetches no module list and no per-module manifest
before importing anything.

The module set is established **per connection**. Changing it means reconnecting, which is a real
constraint and is accepted rather than designed around — a session whose module set changes
underneath it has no coherent story for what happens to the state the departing module owned.

`ctx.modules.get(id)` exposes a declared module's exports to every other module of the same
declaration, whatever order the two were declared in. That shares **code**, and the boundary rule
governing it is stated in ADR-0006.

Three consequences of the three-pass load are accepted rather than designed around:

- **A module's `setup` must not call a peer's functions.** Every module's exports exist by then, but
  an accessor reading state the peer builds in its own `setup` answers `undefined` until that setup
  runs. The Core warns, naming both modules and pointing at the remedy — read the peer from a frame,
  window or command callback — and still returns the exports, so the warning changes no behaviour.
- **The exports view is live**, so unloading a provider drops it out from under a consumer that kept
  the id. Nothing on the wire unloads a single module, and the module set is per connection.
  Recorded, not guarded.
- **A hanging import delays every module's `setup`**, where a serial loader would delay only those
  declared after it. The modules are served same-origin by the same server that sent the
  declaration, and the last-declared module carries that risk under any loader, so there is no
  timeout and no retry.

`apiVersion` bumps whenever this contract changes.

A module is fetched with dynamic `import()`, and that is what makes the VSCode webview host
possible. A webview serves its modules from the `vscode-resource.vscode-cdn.net` origin, which is
cross-origin to the `vscode-webview://` page, and `import()` is governed by the content security
policy rather than by the origin: `script-src …vscode-cdn.net` permits it. A top-level `import()`, an
entry module's relative import of a sibling, and a cache-busting `?v=` query all load. Web *workers*
are the opposite case — they enforce same origin, which is why that host pre-bundles each Cesium
worker and runs it as a blob.
