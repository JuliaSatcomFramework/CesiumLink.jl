# Show a scene in a VSCode tab

Your Julia runs on a server and your editor is on your laptop. The usual answer is a forwarded port
and a browser tab. The CesiumLink extension is the other answer: it runs beside the Julia process,
holds the WebSocket itself, and relays every frame to a webview panel. **A scene on a remote machine
needs no forwarded port**, whatever port it picked.

The page in that panel is the same viewer a browser gets, running the same Core.

## 1. Install the extension

Search the Extensions view for **CesiumLink**, or install
[disberd.cesiumlink](https://marketplace.visualstudio.com/items?itemName=disberd.cesiumlink) from
the marketplace page. It needs VSCode 1.102 or later.

Over Remote-SSH, install it **from the remote window**. The extension runs beside your Julia
process rather than beside your editor, and VSCode installs it on the host that owns the workspace,
which is the remote one only when the window is.

The extension ships no Cesium. It reads the built viewer tree that the server records, so the page
and the server cannot drift apart. **The extension host and the Julia process must share a
filesystem**; a scene on a third machine reports the path it looked for and opens nothing.

### Building it from this repository instead

To run a build of your own, package the sources and install the file:

```sh
cd extension
npx @vscode/vsce package
```

Install the `.vsix` it writes with **Extensions: Install from VSIX…** from the command palette, run
in the remote window over Remote-SSH.

**Installing a rebuilt `.vsix` whose version has not changed does nothing, and says nothing.** Raise
the version in `extension/package.json`, or install from the command line with `--force`, whenever
you rebuild the extension and want to run what you rebuilt.

## 2. Open a scene

Start a scene as usual. The port does not matter:

```julia
server = start_server()
register_module!(server, vendored(:primitives))
```

Run **CesiumLink: Pick a Scene**. The rows are the scenes this user serves, and the panel opens on
the one you pick. Every scene gets a row, including the only one: each row carries a **Stop this
scene** button, and a shortcut past the list would leave a lone scene with no way to stop it.

That button stops the server it names, over the socket, exactly as `stop_server` does. It is the one
action in this extension that reaches back into your Julia process.

The last row, **Enter a host and port**, reaches a scene that writes no discovery file — a server on
another machine you have forwarded a port from, for instance. The extension still needs a viewer
tree to grant the tab: it takes that from the `cesiumLink.distDir` setting, and asks for a path when
the setting is empty. Set it once and manual entry costs one prompt instead of two.

Every row reads `CesiumLink` unless you say otherwise, because [`start_server`](@ref) names a scene
after the directory it started in. The port and the start time beside the title are what tell two
scenes apart. Pass `title` when you want to read the list rather than decode it:

```julia
server = start_server(; title = "coverage, 12 GHz")
```

The list comes from a file each server writes for itself — see [`discovery_dir`](@ref). A scene
whose process is gone is skipped, so a crashed session leaves no row you can pick.

## 3. Let a scene open its own tab

From a terminal **inside VSCode**, a scene opens its own tab and you run no command:

```julia
server = start_server()
```

`open` decides this, and `:auto` is the default. It asks from a VSCode terminal and does nothing
anywhere else, so the same script on a plain SSH session, in CI or under the test suite opens
nothing and prints nothing.

| `open` | What happens |
|---|---|
| `:auto` | Asks for a tab from a VSCode terminal. Silent everywhere else. |
| `true` | Asks wherever it runs, and says why it could not. |
| `false` | Never asks. |

**Which window the tab opens in.** A terminal of a remote window names the socket that reaches that
window, so the tab opens where you started the scene. A terminal of a local window names no such
socket — VSCode publishes one for remote windows alone — and the request goes to whichever window is
active. With one window open the two are the same thing.

**VSCode asks you for permission before the tab opens, and asks again for every scene** until you
tick *"do not ask again for this extension"* in that dialog. The server does not wait for your
answer: the scene serves while the dialog stands. Pass `open = false` for a scene that must open
nothing.

A tab that fails to open never costs you the scene. A missing extension, a missing `code` program
and a refused request all cost one `@debug` line, and the server serves.

## What the panel does, and does not, do

**Close the tab and the server keeps serving.** Closing the panel closes the socket and nothing
else. The scene belongs to your REPL, and [`stop_server`](@ref) is what stops it.

**Stop the server and the panel says so.** A red banner appears over the scene, which stays drawn
and stays interactive. Its one action is to pick another scene, because a server that dropped has
usually stopped, and a restarted one binds a new port — the address the panel held is dead.

**The fullscreen button enters Zen Mode.** A webview cannot go fullscreen, so the button asks the
extension for the nearest thing the editor has: one editor group, no bars, and the window itself
full screen. Click it again to leave. Two things follow from that:

- an editor group beside the panel is maximized away on the way in, and comes back **evenly sized**
  on the way out. VSCode reports no group widths, so a split you sized by hand cannot be put back;
- `zenMode.centerLayout` is held off for as long as Zen Mode is on, and your own value is written
  back when you leave. Leave Zen Mode another way — Escape twice — and it stays off until the next
  time you press the button.

Every other item behaves as it does in a browser — see
[Choose the on-screen furniture](furniture.md).

## When nothing appears

A webview that fails shows a black rectangle and says nothing on its own. Open the **CesiumLink**
output channel: it carries the socket lifecycle — dialled, open, closed with a reason — and every
error the page reports.

Two failures look identical from the outside and are named there:

- The recorded viewer tree holds no `vscode.js`. Build it with `npm run build` in `lib/`.
- The recorded path does not exist on this machine, which is the third-machine case above.

## Next

- [`start_server`](@ref) and [`discovery_dir`](@ref) for the whole surface.
- [Record and replay a session](record-replay.md) to look at a scene with no Julia at all.
