```@meta
CurrentModule = CesiumLink
```

# The server

One `Server` holds the HTTP listener, the connected clients, the declared module set, the retained
scene state and the registered event listeners. It serves the page, the Cesium runtime and every
module from one port, so the page and its live connection are same-origin.

## Starting and stopping

```@docs
Server
start_server
stop_server
```

## Finding a running server

A server picks its own port, so the number is not known in advance. Print `viewer_url` for a person.
A picker reads the discovery file to list the scenes a user serves.

```@docs
viewer_url
bound_port
discovery_dir
```

## Modules

The server declares the module set over the wire. It mounts each module folder under
`/modules/<id>/` and names the resulting URL in the declaration. Registration order is the order the
viewer draws and stacks the modules in.

```@docs
ModuleEntry
register_module!
vendored
CesiumLink.module_url
```

## The viewer bundle

```@docs
viewer_dist
```

## The basemap

`imagery` says what the globe is textured with: one basemap, or a **basemap set** the reader picks
inside. A directory of tiles becomes the reserved assets mount `imagery`, which responds on
`assets/imagery/` and reaches the page same-origin. The server declares anything else as the URL it
is.

```@docs
Imagery
KNOWN_EARTH_BASEMAPS
```

[Choose what the globe is textured with](../how-to/basemap.md) is the guide, and it covers the
sources this package ships no name for.

## Assets mounts

`assets` names the directories this server serves besides the viewer bundle and the modules. Each
mount has a name of one path element, and `/assets/<name>/<file>` is the path a payload declares. A
module asks the Core to resolve that path, because each host answers it its own way. `imagery` is
reserved for the basemap's tiles, and an `assets` key of that name throws.

`trusted_origins` names the origins the page may reach off-site. It widens the image policy and the
connection policy the VSCode webview runs under, because Cesium fetches a tile as bytes and makes an
image of them. A basemap named as a URL adds its own origin.

[`start_server`](@ref) reads both keywords once. See
[Put your own model on a satellite](../how-to/models.md) for a mounted folder a payload points into.

## The session declaration

The server sends this frame once per connection, before any state addressed to a module.

```@docs
CesiumLink.modules_message
```

## How a client is written to

Every client holds a bounded queue of frames and one task that drains it. A broadcast copies the
client set, releases the server's lock, then enqueues. A client that stops reading fills its own
queue and holds up nothing else: no other client, and no request the same lock guards. The drain
task serialises one client's writes (ADR-0030).

A full queue drops the frame and counts it. A `core/dropped` command carrying the count goes before
the next frame that fits. The client answers with a `core/replay` event, and the server sends the
retained scene — the same frames a client connecting now receives.

`send_frame` is the one function that knows how to write to a client of a given kind. A host that
reaches its page by another route than a WebSocket adds a method for its own connection type.

A host whose page needs no port says so with `in_notebook`, and a server started under it opens
none.

```@docs
CesiumLink.Client
CesiumLink.send_frame
CesiumLink.in_notebook
```

## Reading back what the session declares

The server keeps the last command per `(module, topic)` pair and replays the set to every client
that connects. Ask it what one pair says:

```@docs
CesiumLink.declared
CesiumLink.retained
```
