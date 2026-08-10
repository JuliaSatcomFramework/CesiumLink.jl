# CesiumLink for VSCode

Show a live CesiumLink scene in an editor tab.

This extension is the companion of
[**CesiumLink.jl**](https://github.com/JuliaSatcomFramework/CesiumLink.jl), a Julia package that
draws a time-dynamic 3D scene on a Cesium globe. You describe the scene in Julia — satellites,
ground stations, links, footprints, a scalar field over the globe — and the package streams it to a
browser over one WebSocket. The browser plays it back against its own clock.

The extension replaces that browser with an editor tab. It does nothing on its own: it needs a Julia
process that runs CesiumLink.jl. Read the
[documentation](https://juliasatcomframework.github.io/CesiumLink.jl/) to write the Julia half
first.

## Requirements

- Julia, with [CesiumLink.jl](https://github.com/JuliaSatcomFramework/CesiumLink.jl) installed.
- The extension host and the Julia process must share a filesystem. The extension reads the built
  viewer tree from disk, so a scene on a machine that VSCode cannot see does not open. A remote
  Julia process is fine when you work through Remote SSH, WSL or a dev container, because the
  extension host then runs beside it.

## Use it

A scene started in a VSCode terminal opens its own tab, and you run no command. `start_server()`
asks this extension for the tab. VSCode asks you for permission first, and asks again for every
scene until you tick "do not ask again for this extension" in that dialog. Pass
`start_server(; open = false)` for a scene that opens no tab.

To open a scene that is already running, run **CesiumLink: Pick a Scene** from the command palette.
The extension lists the scenes that this user serves, and opens the one you pick in a webview panel.
The extension holds the WebSocket and relays every frame to the page, so a scene on a remote machine
needs no forwarded port.

Close the tab to close the socket. The Julia server continues to serve: the scene belongs to your
REPL, and you stop it with `stop_server`.

## The viewer comes from Julia

The extension ships no viewer. It reads the built viewer tree that the Julia server records, so the
page and the server cannot drift apart. An update of the extension therefore never changes the
viewer, and an update of the Julia package changes it for both the browser and the tab.

## Settings

- `cesiumLink.distDir` — absolute path of the built viewer tree. A scene found in the discovery
  directory names its own tree, so this setting applies only to a host and port typed by hand.

## Diagnostics

The **CesiumLink** output channel reports the socket lifecycle, and every error the page reports.
Open it when a tab stays blank.

## License

MIT. See [LICENSE](LICENSE). The viewer carries the CesiumJS runtime, which is Apache-2.0.
