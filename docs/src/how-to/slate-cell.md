# Show a scene in a notebook cell

A [KaimonSlate](https://github.com/kahliburke/KaimonSlate.jl) notebook page already holds one
WebSocket open. A cell that gives back a `Server` draws the scene on that socket, so **a scene on a
remote notebook worker needs no forwarded port**. The cell shows the same viewer a browser gets.

## 1. Show the server

Write the scene as usual, and put the server last in the cell:

```julia
using CesiumLink

server = start_server()
register_module!(server, vendored(:primitives))
server
```

Slate puts `SlateExtensionsBase` on every notebook worker, so `using CesiumLink` alone loads the
part of the package that draws in a cell. There is no other import and no boot cell.

Push windows from that cell, or from any cell after it. The server sends each frame down the socket
of the page.

The server still binds a port of its own. A browser that reaches that port shows the same scene —
see [`viewer_url`](@ref).

## 2. One cell draws one server

Show one server in one cell. A second cell that shows the same server gives a line of text and no
viewer. That line names the cell which holds the server.

Slate keeps one handler for each channel. A second viewer on the channel of a server takes the
frames from the first viewer, and the first cell then stops with no message. The refusal makes that
visible.

Two views of one scene are two servers:

```julia
# in another cell
other = start_server()
install_scene!(other, my_scene)
other
```

A cell that only pushes to a server needs no viewer of its own. Do not put the server last in it.

## 3. What a re-run does

The teardown of the cell is the teardown of the viewer. It runs before the cell evaluates again,
when you delete the cell, and before Slate rebuilds the namespace. Each time, the client leaves the
server and the channel is free again.

**Close the viewer and the server keeps serving.** The teardown drops the viewer and nothing else.
The scene belongs to your worker, and [`stop_server`](@ref) stops it.

**A browser reload keeps the scene.** Slate sends the output of the cell to the page again. The
viewer starts again, asks the server what the session declares, and catches up on the same path as a
client that connects in mid-session.

**A worker that restarts needs one re-run.** A new worker marks every cell stale. Run the cell
again, and it mounts the viewer again.

## When nothing appears

**A line of text, which names another cell.** That cell holds this server. Read section 2.

**The text form of the server, with a URL beside it.** The evaluation ran outside a cell, so the
render reached no page. Open that URL in a browser instead.

**An empty box.** The cell mounts the built viewer. An installed package downloads that build once,
as a Julia artifact. In a clone of this repository, run `npm run build` in `lib/`.

## Next

- [`examples/Constellation/notebook.jl`](https://github.com/JuliaSatcomFramework/CesiumLink.jl/blob/main/examples/Constellation/notebook.jl)
  runs the Constellation example in one cell. It is this page as a notebook.
- [`start_server`](@ref) and [`viewer_url`](@ref) for the whole surface.
- [Show a scene in a VSCode tab](vscode-tab.md) for the same scene in an editor panel.
