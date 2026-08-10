# A control the server answers

You add two checkboxes to the scene of [tutorial 2](moving-scene.md). Julia answers the first one and
refuses the second one. By the end you have seen that a control decides nothing in the browser. It
takes about twenty minutes.

Close the Julia session from the previous tutorial first. It holds the port this one needs. Then
start a fresh session.

```julia
using CesiumLink
```

## 1. Start the server and build the data

This is the whole of tutorial 2, up to the point where it pushes the window.

```julia
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

city_family = Nodes(:city; position = cities, size = 14,
                    color = (255, 209, 102, 255), label = names)
sat_family = Nodes(:sat; position = satellites, size = 10,
                   color = (51, 224, 255, 255))
```

## 2. Hold the scene's state in Julia

```julia
show_sats = Ref(true)
```

This one `Bool` is the whole state of the scene. Julia owns it, and nothing in the browser holds a
copy of it.

## 3. Write the two functions that state the scene

```julia
function declare!()
    declare_overlay(server, [
        Title(show_sats[] ? "Five cities and eight satellites" : "Five cities"),
        Toggle("sats", "Satellites", show_sats[]),
        Toggle("locked", "Locked by the server", false),
    ])
end

function push_scene!()
    families = show_sats[] ? (city_family, sat_family) : (city_family,)
    push_window(server, Dict(:primitives => primitives_payload(families...));
                start_frame = 1, count = nframes, dt_seconds = 600,
                total_frames = nframes, interval_seconds = 0.5,
                start_time = "2026-01-01T00:00:00Z")
end
```

[`Toggle`](@ref) takes an `id`, a label and the value the server declares. The widget shows that
value. [`declare_overlay`](@ref) states the whole overlay every time, so both functions read
`show_sats` and state the scene that goes with it.

## 4. Answer the control

```julia
on_event(server, "ui", "control") do ev, reply
    id = ev.payload.id
    println("the viewer reported ", id, " = ", ev.payload.value)
    if id == "sats"
        show_sats[] = ev.payload.value
        declare!()
        push_scene!()
    else
        declare!()
    end
    return nothing
end
```

[`on_event`](@ref) registers a listener for one `(module, topic)` pair. The `ui` module reports a
control on its `control` topic, and the payload carries the `id` you declared and the `value` the
user chose. The listener is called as `f(ev, reply)`.

The `sats` branch changes the state, states the overlay again and pushes the scene that state
implies. The other branch states the overlay again and nothing else, so `locked` returns to `false`.

## 5. Declare and push the opening scene

```julia
declare!()
push_scene!()
```

## 6. Open the viewer

```julia
viewer_url(server)
```

## What you see, and what to do

The scene of tutorial 2 plays, with two checkboxes at the bottom right. It plays below as well: the
player holds a recording of the script at the end of this page, and no Julia process is behind it.
Read [Record and replay a session](../how-to/record-replay.md) for what a recording holds.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/controls.jsonl&modules=modules"
        title="Two checkboxes over a moving scene, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

**The recorded page answers no click.** A replay runs no listener, so the two boxes above report to
nobody and return to the value the recording carries. The answer the server sends is the whole point
of this tutorial, so run the script yourself. The three steps below describe your own run.

**Clear the `Satellites` box.** Three things happen in order:

1. The box shows `true` again at once. The browser reports your click and then shows the value the
   server last declared.
2. Julia prints `the viewer reported sats = false`.
3. The satellites go, the caption becomes `Five cities`, and the box clears. That is the server's
   answer arriving.

The clock keeps running where it was. The run's keyframe count, step and epoch did not change, so the
new window replaces the scene without touching the range the ruler spans.

**Tick the `Locked by the server` box.** Julia prints the report, and the box stays clear. Nothing
else changes. The listener declares the overlay again with `false`, and the widget shows what the
server declared.

Now tick `Satellites` again to bring the satellites back.

You have just seen the rule the whole design rests on. The browser reports the input, and the server
decides what the scene becomes. Read
[Why the server decides](../explanation/server-authoritative.md) for what that buys.

## Stop the server

```julia
stop_server(server)
```

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

city_family = Nodes(:city; position = cities, size = 14,
                    color = (255, 209, 102, 255), label = names)
sat_family = Nodes(:sat; position = satellites, size = 10,
                   color = (51, 224, 255, 255))

show_sats = Ref(true)

function declare!()
    declare_overlay(server, [
        Title(show_sats[] ? "Five cities and eight satellites" : "Five cities"),
        Toggle("sats", "Satellites", show_sats[]),
        Toggle("locked", "Locked by the server", false),
    ])
end

function push_scene!()
    families = show_sats[] ? (city_family, sat_family) : (city_family,)
    push_window(server, Dict(:primitives => primitives_payload(families...));
                start_frame = 1, count = nframes, dt_seconds = 600,
                total_frames = nframes, interval_seconds = 0.5,
                start_time = "2026-01-01T00:00:00Z")
end

on_event(server, "ui", "control") do ev, reply
    id = ev.payload.id
    println("the viewer reported ", id, " = ", ev.payload.value)
    if id == "sats"
        show_sats[] = ev.payload.value
        declare!()
        push_scene!()
    else
        declare!()
    end
    return nothing
end

declare!()
push_scene!()

println("open ", viewer_url(server))
```

Next: [Write a viewer module](first-module.md).
