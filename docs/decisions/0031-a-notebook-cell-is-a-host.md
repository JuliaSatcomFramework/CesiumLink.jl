---
status: accepted
---

# A notebook cell is a host, and it borrows the notebook's socket

A KaimonSlate notebook page already holds one WebSocket open, and Slate carries raw bytes on it in
both directions without reading either payload. A CesiumLink frame —
`[u32 headerLen][header][pad to 8][region]` — therefore crosses it whole.

So the fourth host draws the scene inside the cell that returns the `Server`, over that socket. It
opens no port of its own and frames no other origin. The author writes:

```julia
using CesiumLink
server = start_server()
install_scene!(server, my_scene)
server
```

Slate puts SlateExtensionsBase on every notebook worker, so `using CesiumLink` alone loads the
package extension. There is no import and no boot cell.

## Decision

**A connection that is not a socket is a `send_frame` method.** The host adds one method and takes
the send queue, the drain task and the drop policy as they are (ADR-0030). Nothing else in the
package knows this host exists.

**The render captures the emitter, and captures it once.** `slate_render` runs inside the cell's
execution context, so it can reach `emit`, `on` and `cleanup`. What it captures is the notebook
namespace's own emitter, not a per-page closure: it survives a browser reload, and it works from any
task, which is what a server pushing frames from the scene's task needs.

**The render is static, and the page replays it.** The host declares no `slate_live_render` method.
A live output re-runs the whole cell source on every browser connect, which would start a second
server on the first reload. A static output is replayed to a reconnecting page instead, its script
runs again there, and the viewer's `ready` frame reaches the handler the first render registered —
so a reload catches up over the same path a client connecting mid-session takes.

**One connection per server, and the channel names the process.** `slate_render` runs more than once
per cell run — Slate's `showable` answers by calling the render and discarding the result — so the
connection is looked up by `Server` and built only when it is absent. The
channel is `cesiumlink/<pid>/<n>`. The process id in it is load-bearing: a page mounts an output only
when its bytes differ from the ones it already holds, so a replaced worker must render a different
channel — otherwise the cell keeps a viewer that talks to a process that no longer exists, and the
scene goes quiet with nothing said anywhere.

**A worker reset needs no hook.** Slate's own reset signal exists on both sides and nothing triggers
it, so a host that waited for it would wait forever. A replaced worker marks every cell stale and the
cell runs again, which is what re-mounts the viewer.

**A mount is a route named by rule, not an entry in a map.** The extension serves the dist as
`CesiumLink`, each assets mount as `CesiumLink-mount-<name>` and each module as
`CesiumLink-module-<id>`. The page builds every one of those URLs from the name it already has, so
nothing has to be handed to it and nothing goes stale when a scene registers a module mid-session.
The Core holds the mount map the declaration carries, and this host says where a mount is
(ADR-0021).

**The cell's teardown is the client's.** `slate_on_cleanup` drops the connection from the client set
and releases the channel. It fires before the cell re-evaluates, when the cell is deleted, and before
a namespace rebuild.

## Considered options

- **An iframe onto the server's own port** (what the spike did). Rejected: it needs the port to be
  reachable from the browser, which a remote or region worker cannot promise, and it puts the scene
  on a second origin for no gain.
- **A live render (`slate_live_render = true`).** Rejected: it re-runs the cell source per browser
  connect. It also captures a fresh emitter each time, which the measurement says is unnecessary.
- **A mount map passed to the page as a component prop.** Rejected: a module registered after the
  cell rendered is absent from it, and the page has no way to learn about the mount.
- **A `Server` rendered from a region worker.** Not supported, and it cannot arise: a value crosses a
  region boundary by serialization, and a `Server` holds a listener, tasks and a lock.

## Consequences

The uplink is a `slateCall`, which is a round trip with a timeout while `Transport.notify` is
fire-and-forget. Events are user-driven and rare, so the cost is one wasted promise per event. The
high-rate direction is the downlink, and that one is a push.

Two cells that display one server share one channel. Both viewers receive the same stream and stay in
step, and their uplinks meet at one handler.
