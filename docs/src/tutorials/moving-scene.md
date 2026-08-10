# A scene that moves

You turn the static scene of [tutorial 1](first-scene.md) into a run of 36 keyframes. Eight
satellites travel east around the equator while the five cities stand still. It takes about fifteen
minutes.

Close the Julia session from the previous tutorial first. It holds the port this one needs. Then
start a fresh session.

```julia
using CesiumLink
```

## 1. Start the server and declare the modules

Nothing changes here.

```julia
server = start_server()
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:ui))
```

## 2. Keep the cities

```julia
lons = [12.50, -0.13, -74.01, 139.69, 151.21]
lats = [41.90, 51.51, 40.71, 35.69, -33.87]
names = ["Rome", "London", "New York", "Tokyo", "Sydney"]

cities = ecef(lons, lats; ellipsoid = server)
```

## 3. Build a position for every keyframe

```julia
nsat = 8
nframes = 36
altitude = 700_000.0

satellites = Array{Float64}(undef, 3, nsat, nframes)
for k in 1:nframes, s in 1:nsat
    lon = 360 * ((s - 1) / nsat + (k - 1) / nframes) - 180
    satellites[:, s, k] .= ecef(lon, 0.0, altitude; ellipsoid = server)
end
```

This is the shape convention: a position array is `3 × N` when the family stands still for the whole
window, and `3 × N × K` when it moves over the window's `K` keyframes. The `cities` array has no
keyframe axis, so those five points hold their place; the `satellites` array has one, so the renderer
blends each satellite between one keyframe and the next.

Read [Windows, keyframes and identity](../explanation/windows.md) for what a window holds and why
column `i` means the same satellite in every keyframe of it.

## 4. Declare the caption

```julia
declare_overlay(server, [Title("Five cities and eight satellites")])
```

## 5. Push the run

```julia
push_window(server,
            Dict(:primitives => primitives_payload(
                     Nodes(:city; position = cities, size = 14,
                           color = (255, 209, 102, 255), label = names),
                     Nodes(:sat; position = satellites, size = 10,
                           color = (51, 224, 255, 255))));
            start_frame = 1, count = nframes, dt_seconds = 600,
            total_frames = nframes, interval_seconds = 0.5,
            start_time = "2026-01-01T00:00:00Z")
```

One window carries both families, and five keyword arguments give the run its time:

| Keyword | What it says |
|---|---|
| `count` | How many keyframes this window carries |
| `total_frames` | How many keyframes the whole run has, which is what the ruler spans |
| `dt_seconds` | The mission time between one keyframe and the next: ten minutes here |
| `start_time` | The instant of keyframe 1, as ISO 8601 |
| `interval_seconds` | The wall-clock time one step plays over: half a second here |

`start_frame` is 1, so this window starts the run. `count` equals `total_frames`, so it carries the
whole run at once.

## 6. Open the viewer

```julia
viewer_url(server)
```

## What you see

- Eight blue points that travel east around the equator, and five yellow cities that do not move.
- The clock at the bottom left, which counts from midnight on 1 January 2026.
- The timeline ruler, which spans the whole run: keyframe 1 to keyframe 36, midnight to 05:50. The
  playhead crosses it in about eighteen seconds, then the run repeats.
- The keyframe readout above the ruler, which names the keyframe the positions come from.

Drag the playhead along the ruler. The satellites follow it, backwards as readily as forwards.
Julia sent every keyframe up front, so the browser plays and scrubs the run without asking Julia
for anything.

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

nsat = 8
nframes = 36
altitude = 700_000.0

satellites = Array{Float64}(undef, 3, nsat, nframes)
for k in 1:nframes, s in 1:nsat
    lon = 360 * ((s - 1) / nsat + (k - 1) / nframes) - 180
    satellites[:, s, k] .= ecef(lon, 0.0, altitude; ellipsoid = server)
end

declare_overlay(server, [Title("Five cities and eight satellites")])

push_window(server,
            Dict(:primitives => primitives_payload(
                     Nodes(:city; position = cities, size = 14,
                           color = (255, 209, 102, 255), label = names),
                     Nodes(:sat; position = satellites, size = 10,
                           color = (51, 224, 255, 255))));
            start_frame = 1, count = nframes, dt_seconds = 600,
            total_frames = nframes, interval_seconds = 0.5,
            start_time = "2026-01-01T00:00:00Z")

println("open ", viewer_url(server))
```

Next: [A control the server answers](controls.md).
