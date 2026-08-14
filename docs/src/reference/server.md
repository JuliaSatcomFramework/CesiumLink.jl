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

A server picks its own port, so nothing knows the number in advance. `viewer_url` is what to print
for a person, and the discovery file is what a picker reads to list the scenes a user serves.

```@docs
viewer_url
bound_port
discovery_dir
```

## Modules

The server declares the module set over the wire. It mounts each module's containing directory
under `/modules/<id>/` and names the resulting URL in the declaration. Registration order is the
order the viewer draws and stacks the modules in.

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

`imagery` says what the globe is textured with. A directory of tiles is the reserved assets mount
`imagery`, so it answers on `assets/imagery/` and reaches the page same-origin; anything else is
declared as the URL it is.

```@docs
Imagery
```

## Assets mounts

`assets` names the directories this server serves besides the viewer bundle and the modules. Each
mount has a name of one path element, and `/assets/<name>/<file>` is the path a payload declares. A
module asks the Core to resolve that path, because each host answers it its own way. `imagery` is
reserved for the basemap's tiles, and an `assets` key of that name throws.

`trusted_origins` names the origins the page may reach off-site. It widens both the image policy and
the connection policy the VSCode webview runs under, because Cesium fetches a tile as bytes and
makes an image of them. A basemap named as a URL adds its own origin.

Both keywords are read once, at [`start_server`](@ref). See
[Put your own model on a satellite](../how-to/models.md) for a mounted folder a payload points into.

## The session declaration

The server sends this frame once per connection, before any state addressed to a module.

```@docs
CesiumLink.modules_message
```

## Reading back what the session declares

The server keeps the last command per `(module, topic)` pair and replays the set to every client
that connects. Ask it what one pair says:

```@docs
CesiumLink.declared
CesiumLink.retained
```
