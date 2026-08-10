# CesiumLink for VSCode

Show a live CesiumLink scene in an editor tab.

Run **CesiumLink: Pick a Scene**. The extension lists the scenes that this user serves, and opens
the one you pick in a webview panel. The extension holds the WebSocket and relays every frame to
the page, so a scene on a remote machine needs no forwarded port.

A scene started in a VSCode terminal opens its own tab, and you run no command. `start_server()`
asks this extension for the tab. VSCode asks you for permission first, and asks again for every
scene until you tick "do not ask again for this extension" in that dialog. Pass
`start_server(; open = false)` for a scene that opens no tab.

The extension ships no viewer. It reads the built viewer tree that the Julia server records, so the
page and the server cannot drift apart. The extension host and the Julia process must therefore
share a filesystem.

Close the tab to close the socket. The Julia server continues to serve: the scene belongs to your
REPL, and you stop it with `stop_server`.

Diagnostics go to the **CesiumLink** output channel: the socket lifecycle, and every error the page
reports.
