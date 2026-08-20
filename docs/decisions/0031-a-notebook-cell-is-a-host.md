---
status: accepted
---

# A notebook cell is a host, and it borrows the notebook's socket

A KaimonSlate notebook page already holds one WebSocket open. Slate carries raw bytes on it in both
directions and reads neither payload. A CesiumLink frame is
`[u32 headerLen][header][pad to 8][region]`, and it therefore crosses whole.

The fourth host thus draws the scene in the cell that returns the `Server`, on that socket. It opens
no port of its own, and it puts no other origin in a frame. The author writes:

```julia
using CesiumLink
server = start_server()
install_scene!(server, my_scene)
server
```

Slate puts SlateExtensionsBase on every notebook worker, so `using CesiumLink` alone loads the
package extension. There is no other import and no boot cell.

## Decision

**A connection that is not a socket is a `send_frame` method.** The host adds one method, and it
uses the send queue, the drain task and the drop policy as they are (ADR-0030). Nothing else in the
package knows that this host exists.

**A server started in a cell opens no port.** The cell host reads no port: it sends on the socket of
the notebook and serves its files through Slate. A port there therefore reaches nobody the cell
already reaches, and it is one more thing to stop. `start_server` defaults `listen` to
`!in_notebook()`. The extension installs the check that answers it, `slate_context() !== nothing` —
the same predicate `slate_render` uses to find a cell. The two agree by construction: an evaluation
that draws in a cell needs no port, and an evaluation that draws nowhere else gets one.
`listen = true` asks for the port, for a scene that a browser must also open.

The host installs a check and does not add a method. `in_notebook` takes no argument, so a method
from the extension would overwrite the one in the package rather than join it. Julia says so, and
the package would lose its own answer to a question it must always be able to answer.

**The render captures the emitter, and captures it one time.** `slate_render` runs in the execution
context of the cell, so it can reach `emit`, `on` and `cleanup`. It captures the emitter of the
notebook namespace, and not a closure for one page. That emitter stays after a browser reload, and
it works from any task. A server that sends frames from the task of the scene needs that.

**The render is static, and the page shows it again.** The host declares no `slate_live_render`
method. A live output runs the whole cell source again at each browser connect, and the first reload
would thus start a second server. Slate sends a static output again to a page that reconnects. The
script of that output runs again on the page, and the `ready` frame of the viewer reaches the handler
that the first render registered. A reload thus catches up on the same path as a client that connects
in mid-session.

**One connection for each server, and the channel names the process.** `slate_render` repeats. Slate
shares one render between the `showable` scan and the `show` of one display, and this host asks for
SlateExtensionsBase 0.9.1 to get that. Two other paths still repeat it. A cell can display one
server more than one time. A `showable` answered outside a display shares nothing with the display
that follows. The host therefore finds the connection by `Server`, and builds it only when it is
absent. The channel is `cesiumlink/<pid>/<n>`. The channel must contain the process id. A page
mounts an output only when its bytes are different from the bytes that it holds, so a new worker
must render a different channel. If not, the cell keeps a viewer that speaks to a process that
stopped. The scene then stops, and no message says why.

**A worker reset needs no hook.** The reset signal of Slate exists on both sides, but nothing sends
it. A host that waited for it would wait forever. A new worker marks every cell stale, and the cell
then runs again and mounts the viewer again.

**A rule names a mount route, and no map holds it.** The extension serves the dist as `CesiumLink`,
each assets mount as `CesiumLink-mount-<name>` and each module as `CesiumLink-module-<id>`. The page
builds each of those URLs from the name that it already has. Nothing must be sent to the page, and
nothing becomes stale when a scene registers a module in mid-session. The Core holds the mount map
that the declaration carries, and this host says where a mount is (ADR-0021).

**One cell draws one server, and a second cell reads why it does not.** Slate holds one stream
handler for each channel. A second viewer on the channel of a server thus takes the frames from the
first viewer, and the first cell stops with no message. The render therefore claims the server for
the cell that it runs in. Slate names that cell in task-local storage under `:slate_cell`. A render
from any other cell gives back a line that names the cell that holds the server. A cell that wants a
second viewer wants a second server. A cell that only sends to this server needs no viewer. The claim
is free again as soon as the cell that holds it no longer shows the server.

**The render registers its own component.** Slate loads the front end of a widget when a notebook
*binds* it. A cell shows a `Server` but does not bind it, so `slate_render` asks for the registration.
Without it, the cell holds a component descriptor that nothing on the page mounts, and no error says
so.

**The teardown of the cell is the teardown of the client.** `slate_on_cleanup` removes the connection
from the client set and releases the channel. It runs before the cell evaluates again, when the cell
is deleted, and before a rebuild of the namespace.

## Considered options

- **An iframe on the server's own port**, which the spike used. Rejected: the browser must reach that
  port, and a remote worker or a region worker cannot promise it. It also puts the scene on a second
  origin for no gain.
- **A live render (`slate_live_render = true`).** Rejected: it runs the cell source again at each
  browser connect. It also captures a new emitter each time, and the measurement shows that this is
  unnecessary.
- **A mount map sent to the page as a component property.** Rejected: a module registered after the
  render of the cell is absent from that map, and the page cannot learn about the mount.
- **A `listen` flag that defaults to `true` in a cell too.** Rejected: it makes the common case pay
  for the rare one. Every notebook scene would then hold a port that nothing reads, and every
  notebook worker would leave discovery files behind for a picker to offer.
- **A `Server` rendered from a region worker.** Not supported, and it cannot occur: a value crosses a
  region boundary by serialization, and a `Server` holds a listener, tasks and a lock.
- **Two cells that draw one server, with the page sending the channel to both viewers.** That is ten
  lines in the transport, and the two viewers then stay in step. Rejected: a notebook is not for two
  views of one scene, and one cell for each camera angle is two servers. The refusal is the smaller
  thing to keep correct, and it says what the fan-out would permit in silence.

## Consequences

The uplink is a `slateCall`, which is a round trip with a timeout, while `Transport.notify` does not
wait for an answer. Events come from the user and are rare, so the cost is one unused promise for
each event. The downlink carries the high rate, and it is a push.

A second cell that shows a server that another cell already draws gives a line and not a viewer. The
cost is one shape that the notebook cannot express: one scene from two cameras at the same time. That
is two servers.
