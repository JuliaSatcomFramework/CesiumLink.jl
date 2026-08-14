# Your first scene

You build a static scene: five labelled points on the globe, under a caption. Julia decides
everything on screen. It takes about fifteen minutes.

Start a fresh Julia session in a project that has CesiumLink installed.

```julia
using CesiumLink
```

## 1. Start the server

```julia
server = start_server()
```

[`start_server`](@ref) opens one port for the viewer page and the WebSocket the page connects back
on. The operating system picks the number, so two people on one machine never collide. Julia now
waits for a browser.

## 2. Declare the two modules the scene needs

```julia
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:ui))
```

A module draws part of the scene, and the browser loads only the modules the server declares.
`primitives` draws points, lines and footprints; `ui` draws the overlay. [`vendored`](@ref) names a
module that ships inside the viewer.

## 3. Place five points on the globe

```julia
lons = [12.50, -0.13, -74.01, 139.69, 151.21]
lats = [41.90, 51.51, 40.71, 35.69, -33.87]
names = ["Rome", "London", "New York", "Tokyo", "Sydney"]

cities = ecef(lons, lats; ellipsoid = server)
```

The renderer takes cartesian metres, so [`ecef`](@ref) converts the degrees. It returns a `3 × 5`
matrix: one column of `(x, y, z)` per point. Pass `server` as the `ellipsoid`, so the points land on
the shape the browser builds its globe on.

## 4. Put a caption on screen

```julia
declare_overlay(server, [Title("Five cities")])
```

[`declare_overlay`](@ref) states the whole overlay as one list. [`Title`](@ref) is a caption at the
top centre.

## 5. Push the scene

```julia
push_window(server,
            Dict(:primitives => primitives_payload(
                     Nodes(:city; position = cities, size = 14,
                           color = (255, 209, 102, 255), label = names)));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```

[`Nodes`](@ref) is one family of points: a name, the positions, and how they look.
[`primitives_payload`](@ref) collects the families into the payload that module reads.
[`push_window`](@ref) broadcasts one **window**: a run of keyframes with every module's data for
them. This window holds one keyframe, which is how a static scene travels.

The call returns `0`, the number of clients it reached: no browser is connected yet. The server
keeps the window and sends it to the first client that arrives.

## 6. Open the viewer

[`viewer_url`](@ref) says which URL to open:

```julia
viewer_url(server)      # "http://127.0.0.1:38391/?ws=auto"
```

Open it in your browser. Keep the `?ws=auto` part: it tells the page to connect back to Julia. The
plain URL shows an empty globe.

## What you see

The scene below is a recording of the script at the end of this page. Read
[Record and replay a session](../how-to/record-replay.md) for what a recording holds.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/first-scene.jsonl&modules=modules"
        title="Five labelled cities on the globe, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

- Five yellow points on the globe, each with its city name beside it.
- The caption **Five cities** at the top centre.
- A band along the bottom edge with a clock, a timeline ruler and a keyframe readout. This scene
  holds one keyframe, so the band has nothing to play.
- Three buttons in the top right corner: the home view, the 2D/3D picker and the fullscreen toggle.

Drag the globe to turn it, and scroll to zoom. The browser does that on its own.

## Stop the server

```julia
stop_server(server)
```

Then close the Julia session.

## The whole script

```julia
using CesiumLink

server = start_server()
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:ui))

lons = [12.50, -0.13, -74.01, 139.69, 151.21]
lats = [41.90, 51.51, 40.71, 35.69, -33.87]
names = ["Rome", "London", "New York", "Tokyo", "Sydney"]

cities = ecef(lons, lats; ellipsoid = server)

declare_overlay(server, [Title("Five cities")])

push_window(server,
            Dict(:primitives => primitives_payload(
                     Nodes(:city; position = cities, size = 14,
                           color = (255, 209, 102, 255), label = names)));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)

println("open ", viewer_url(server))
```

Next: [A scene that moves](moving-scene.md).
