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

**One cell draws one server, and a second cell is told so.** Slate holds one stream handler per
channel, so a second viewer on a server's channel takes the frames off the first one and the cell
that was drawing goes quiet with nothing said anywhere. The render therefore claims the server for
the cell it runs in — Slate names that cell in task-local storage under `:slate_cell` — and a render
from any other cell returns a line naming the cell that holds it. A cell that wants a second viewer
wants a second server. A cell that only pushes to this one needs no viewer at all, and the claim is
free again as soon as the holding cell stops displaying the server.

**The render registers its own component.** Slate loads a widget's front end when a notebook *binds*
it, and a `Server` is displayed rather than bound. So `slate_render` asks for the registration itself.
Without it the cell holds a component descriptor that nothing on the page ever mounts, and no error
says so.

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
- **Two cells drawing one server, with the page fanning the channel out to both viewers.** Ten lines
  in the transport, and both viewers then stay in step. Rejected: two views of one scene is not what
  a notebook is for, and the shape it invites — one cell per camera angle — is two servers. The
  refusal is the smaller thing to keep correct, and it says out loud what the fan-out would have
  quietly permitted.

## Consequences

The uplink is a `slateCall`, which is a round trip with a timeout while `Transport.notify` is
fire-and-forget. Events are user-driven and rare, so the cost is one wasted promise per event. The
high-rate direction is the downlink, and that one is a push.

A second cell that displays a server already drawn elsewhere shows a line rather than a viewer. The
cost is a shape the notebook cannot express: one scene seen from two cameras at once. That is two
servers.
