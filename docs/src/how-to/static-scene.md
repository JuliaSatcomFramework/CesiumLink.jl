# Show a scene with no clock

Some scenes are a statistic drawn on the globe rather than a state at a time: a coverage map, a
demand raster, a year of traffic summed per cell. There is nothing to play, scrub or name a date for.
Say so in two steps.

## 1. Push a window of one keyframe

```julia
push_window(server, Dict(:primitives => primitives_payload(
                Areas(:cell; center = cells, radius = 12_000, color = rgba(CMAP, demand))));
            start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
```

`count = 1` with `total_frames = 1` is the whole run. `dt_seconds` is a required keyword and nothing
steps, so any positive value does. Leave `start_time` alone: without it the viewer takes a synthetic
epoch, which nobody sees.

The viewer holds the whole declared range, so it never asks for more. You need no `core/need`
listener.

## 2. Declare no time furniture

```julia
declare_furniture(server; timeline = false, animation = false, keyframe = false)
```

That takes the whole band down: the ruler, the clock face and the keyframe readout. The corner
buttons stay, and the region below them moves down to the bottom edge with no gap.

**This is the only statement the scene makes about time.** The wire carries the furniture set, not
the reason for it. A scene of one keyframe that shows a real instant still wants its clock, so the
frame count says nothing on its own.

Both calls are retained, so a browser that connects later comes back to the same scene and the same
furniture.

## When the one keyframe does name an instant

Keep the band, and give the instant a date:

```julia
push_window(server, payload; start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1,
            start_time = "2026-08-04T12:00:00Z")
declare_furniture(server)
```

The readout and the ruler then say something true. The ruler spans one keyframe and scrubs nowhere.

## Answer a control with another still scene

Answer the event with a fresh one-keyframe `:replace` window, then declare the overlay again so the
widget shows the value the scene is in:

```julia
on_event(server, "ui", "control") do ev, reply
    ev.payload.id == "metric" || return nothing
    metric[] = ev.payload.value
    push_window(server, Dict(:primitives => primitives_payload(areas(metric[])));
                start_frame = 1, count = 1, dt_seconds = 60, total_frames = 1)
    declare_overlay(server, overlay_items())
end
```

A `:replace` pushed from inside a listener voids that listener's reply. So call
[`declare_overlay`](@ref) after the push, rather than contribute the declaration to the reply.

## Going back to a run

Push a window over the longer range and declare the band on again:

```julia
push_window(server, payload(1:24); start_frame = 1, count = 24, dt_seconds = 600, total_frames = 24)
declare_furniture(server)
```

Do not leave `timeline = false` over a run of more than one keyframe. The viewer obeys and warns in
the browser console that the frames after the first are unreachable.

## Next

- [Choose the on-screen furniture](furniture.md) — the rest of the item set.
- [Windows and scenes](../reference/windows.md) — `push_window` and its keywords.
- [Windows, keyframes and identity](../explanation/windows.md) — what a window is the unit of.
