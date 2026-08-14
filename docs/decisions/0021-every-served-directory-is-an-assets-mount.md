---
status: accepted
---

# Every served directory is an assets mount

The server served a file from one of three places, and each had its own rule. The viewer dist is the
fallback root. A registered module's own directory answers `/modules/<id>/`. A directory of basemap
tiles answers `/imagery/`. `mount_for` in `src/static.jl` holds all three.

A scene that draws a glTF model needs a fourth place: a folder of models the author owns. A fourth
branch beside the other three would make four idioms for one idea, and only one of the three —
`/modules/<id>/` — reads the directory out of a table by name. `/imagery/` is a single directory
with no name at all.

## Decision

**A directory the server serves is an assets mount, and a mount has a name.**

`start_server` takes them as a map:

```julia
start_server(; assets = Dict("models" => "/data/glb", "textures" => "/data/png"))
start_server(; assets = "/data/glb")     # sugar: one mount, named for the directory
```

The bare string names the mount after the last element of the path, so `/data/glb` answers
`/assets/glb/`. The name is part of every URL the scene declares, so a reader can see which folder a
file comes from without reading the server call.

**A payload names an asset by its same-origin path.** `assets/models/sat.glb` is what travels on the
wire. This is the form a basemap directory already declares, so the wire has one convention and not
two.

**A tile directory is the reserved mount `imagery`.** `imagery = "/data/moon_tiles"` is unchanged for
the caller. The server registers the directory under the name `imagery` and declares the URL
`assets/imagery/`. An `assets` key called `imagery` is an error, because a silent shadow would leave
the globe drawing a file the author never meant.

**Mounts are fixed when the server starts.** The set reaches the VSCode extension through the
discovery file, before the extension builds the page. The extension needs it there: a webview
receives its `localResourceRoots` when the panel is created, and the page reads the roots out of
globals the panel's HTML carries.

**One `trusted_origins` list holds every origin the page may reach off-site**, and it widens both
`img-src` and `connect-src`. A basemap declared as a URL adds its own origin to the list, so a
session that names a remote basemap and nothing else declares nothing new.

Both directives, because one asset needs both. Cesium asks for a tile with `preferBlob`: it fetches
the bytes and makes an `ImageBitmap` of them, so the request is a connection and not an image load,
and the image directive covers only the paths that fall back to an `<img>` element. A list that fed
one directive would draw a basemap that works on one code path and fails on the other. This is
forced, not a convenience.

**`ctx.assetUrl(path)` resolves a declared path for the host the module runs in.** This is the one
new part of the module API. A module cannot do the work itself, because the Core never reads inside a
payload and cannot rewrite the path for it.

## Why a module needs the Core to resolve a path

The three hosts disagree about where a mount is.

| Host | `assets/models/sat.glb` resolves to |
|---|---|
| browser | the same path on the server's own origin |
| VSCode webview | a `vscode-webview:` URI, one per mount, that the extension makes |
| recording player | the base the page address gives as `?assets=`, or nothing |

The webview is what forces the seam. Its page lives at an origin that holds no files, and every root
gets its own opaque URI from `asWebviewUri`. A module that builds the URL itself works in the browser
and fails silently in the panel. `lib/vscode/main.ts` already does this rewrite for the module
URLs it imports; `assetUrl` makes the same rewrite reachable by a module.

## Alternatives declined

**A second anonymous mount beside `/imagery/`.** About six lines cheaper on the day, and it leaves
two mount idioms in one function forever. The basemap work had already paid for the directory mount,
the discovery field, the extension root and the CSP allowance; a second copy of all four earns
nothing.

**A structured reference on the wire**, such as `{mount: "models", file: "sat.glb"}`. It needs no
string parsing and a bad mount name is machine-readable. It also gives the wire a second shape for
one idea, because a basemap keeps declaring a plain URL.

**A scheme-prefixed string**, such as `models:sat.glb`. Nobody mistakes it for a URL that works
unresolved. It is invented syntax with no precedent here, and a basemap cannot be written in it.

**Imagery never mounts anything, and points at a mount the author registered.** The purest
separation, and one way for a directory to be served. It breaks `imagery = "/data/moon_tiles"`, which
is the documented one-liner, and makes the layout probe resolve a mount name back to a path on disk.

**A scene declares its own mounts.** A webview cannot take a new root without either a new panel or a
live change to `panel.webview.options`, and the page globals ride HTML that cannot be rewritten
without dropping the scene and the socket. The discovery field and the page global are maps, so this
stays open, but nothing reads a second mount today.

## Consequences

A basemap directory declares `assets/imagery/` and not `imagery/`. Nothing in the browser holds that
string: the imagery provider takes whatever URL the declaration carries.

The recording player reads `?assets=<base>`, beside the `?imagery=` it already reads. A recording
that names a model and a player address that names no base draws the markers and no models.

An unresolvable path is not fatal. `assetUrl` answers `null` and writes a warning, and the family
draws what it can. This is the fallback ADR-0020 sets for a basemap that fails to load. The Julia
constructor checks the shape of the path at the call site, where the author can act on it; the mount
name is checked in the browser, because only the browser holds the map for its host.

An extension absent from `MIME_TYPES` is served as `application/octet-stream`, and Cesium loads a
`.glb` from it. The table needs no new entry.
