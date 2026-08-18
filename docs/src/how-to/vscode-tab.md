# Show a scene in a VSCode tab

The CesiumLink extension runs beside the Julia process and relays every frame to a webview panel,
so **a scene on a remote machine needs no forwarded port**. The panel shows the same viewer a
browser gets.

## 1. Install the extension

Search the Extensions view for **CesiumLink**, or install
[disberd.cesiumlink](https://marketplace.visualstudio.com/items?itemName=disberd.cesiumlink) from
the marketplace page. It needs VSCode 1.102 or later.

Over Remote-SSH, install it **from the remote window**. VSCode installs the extension on the host
that owns the workspace, and only a remote window owns a remote workspace.

**The extension host and the Julia process must share a filesystem.** The extension ships no Cesium:
it reads the built viewer tree the server records. A scene on a third machine reports the path it
looked for and opens nothing.

### Building it from this repository instead

To run a build of your own, package the sources:

```sh
cd extension
npx @vscode/vsce package
```

Install the `.vsix` it writes with **Extensions: Install from VSIX…** in the command palette. Over
Remote-SSH, run that command in the remote window.

**A rebuilt `.vsix` whose version did not change installs nothing, and says nothing.** Raise the
version in `extension/package.json`, or install from the command line with `--force`.

## 2. Open a scene

Start a scene as usual. The port does not matter:

```julia
server = start_server()
register_module!(server, vendored(:primitives))
```

Run **CesiumLink: Pick a Scene**. Each row is a scene this user serves, and the panel opens on the
row you pick. Every row, a lone scene's included, carries a **Stop this scene** button. The button
stops the server it names over the socket, exactly as `stop_server` does. It is the only action
here that reaches into your Julia process.

The last row, **Enter a host and port**, reaches a scene that writes no discovery file, such as a
server you forwarded a port from. The extension still needs a viewer tree. It takes that from the
`cesiumLink.distDir` setting, and asks for a path when the setting is empty. Set `distDir` once, and
manual entry then costs one prompt instead of two.

[`start_server`](@ref) names a scene after the directory it started in, so every row reads
`CesiumLink` by default. The port and the start time beside the title tell two scenes apart. Pass
`title` to name a scene yourself:

```julia
server = start_server(; title = "coverage, 12 GHz")
```

The list comes from a file each server writes for itself — see [`discovery_dir`](@ref). The
extension skips a scene whose port no longer answers, so a crashed session leaves no row.

## 3. Let a scene open its own tab

From a terminal **inside VSCode**, a scene opens its own tab and you run no command:

```julia
server = start_server()
```

The `open` keyword controls this. Under its default, the same script under SSH, in CI or in the
test suite opens nothing and prints nothing.

| `open` | What happens |
|---|---|
| `:auto` | Asks for a tab from a VSCode terminal. Silent everywhere else. |
| `true` | Asks wherever it runs, and says why it could not. |
| `false` | Never asks. |

**Which window the tab opens in.** A terminal of a remote window names the socket that reaches that
window, so the tab opens where you started the scene. VSCode publishes such a socket for remote
windows alone, so a local terminal sends the request to whichever window is active.

**VSCode asks you for permission before the tab opens, and asks again for every scene** until you
tick *"do not ask again for this extension"* in that dialog. The server does not wait for your
answer: the scene serves while the dialog stands. Pass `open = false` for a scene that must open
nothing.

A failed tab never costs you the scene. A missing extension, a missing `code` program and a
refused request each cost one `@debug` line.

## What the panel does, and does not, do

**Close the tab and the server keeps serving.** The panel closes the socket and nothing else. The
scene belongs to your REPL, and [`stop_server`](@ref) stops it.

**Stop the server and the panel says so.** A red banner appears over the scene, which stays drawn
and interactive. Its one action is to pick another scene: a restarted server binds a new port, so
the address the panel held is dead.

**The fullscreen button enters Zen Mode.** A webview cannot go fullscreen, so the button asks for
the nearest state the editor has: one editor group, no bars, and the window itself full screen.
Click it again to leave. Two effects follow:

- an editor group beside the panel is maximized away on the way in, and comes back **evenly sized**
  on the way out. VSCode reports no group widths, so a split you sized by hand cannot be put back;
- `zenMode.centerLayout` is held off while Zen Mode is on, and your own value is written back when
  you leave. Leave Zen Mode another way — Escape twice — and it stays off until you press the button
  again.

Every other item behaves as it does in a browser — see
[Choose the on-screen furniture](furniture.md).

## When nothing appears

A webview that fails shows a black rectangle and no message. Open the **CesiumLink** output channel.
It carries the socket lifecycle — dialled, open, closed with a reason — and every error the page
reports.

Two failures look identical from outside, and the channel names both:

- The recorded viewer tree holds no `vscode.js`. Build it with `npm run build` in `lib/`.
- The recorded path does not exist on this machine, which is the third-machine case above.

## Next

- [`start_server`](@ref) and [`discovery_dir`](@ref) for the whole surface.
- [Record and replay a session](record-replay.md) to look at a scene with no Julia at all.
