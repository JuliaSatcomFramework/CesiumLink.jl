# Deliver a long mission a piece at a time

Your mission is fifty thousand keyframes. Sending it as one window means computing all of it before
anything appears, holding all of it in the browser, and paying for the part nobody ever plays.

Declare the whole range and deliver a part of it. The viewer asks for the rest as playback
approaches the end of what it holds.

## 1. Declare the whole range, deliver a part

```julia
push_window(server, payload_for(1:200);
            start_frame = 1, count = 200, total_frames = 50_000,
            dt_seconds = 30, interval_seconds = 0.15)
```

`total_frames` is the mission. `count` is the buffer — what the viewer holds now. The two are
independent: the clock, the ruler and scrubbing all work against the declared range, so the ruler
spans the whole fifty thousand from the first window on.

`total_frames` is fixed for the run. A mission that grows while it plays is a different problem, and
this page does not solve it.

## 2. Register the listener

```julia
on_event(server, "core", "need") do ev, _
    push_window(server, payload_for(ev.start_frame, ev.count);
                start_frame = ev.start_frame, count = ev.count, mode = :append,
                total_frames = 50_000, dt_seconds = 30)
end
```

The Core raises `core/need` as playback nears the end of the buffer. The event carries the **1-based**
`ev.start_frame`, the `ev.count` asked for, and `ev.mode`.

This listener is what makes a scene able to produce a window at all. The server asks exactly one
question — is anything registered for `core/need`? Without it:

- a client that joins mid-session is sent only what the server retains, and
- an append cannot stand on its own for that client, so it gets a scene that is missing whatever rode
  the window it never saw.

Answer with more than you were asked for. The Core asks for the frames it wants, which can be two;
answering that literally extends the buffer two keyframes at a time. Round the count up to a chunk
you choose.

## 3. Answer with an append

`mode = :append` extends the buffer the viewer holds. The window it extends keeps its identity, so a
request raised against the earlier window is still valid.

!!! warning "An append preserves the index space"
    Entity `i` is the same entity it was. An [`Edges`](@ref) family joins two other families by
    index, and a pick reports an index, so a window that orders the entities differently makes both
    address something else. Nothing the user did asked for that change, and on screen it reads as
    every entity teleporting at the seam.

## 4. When it is not an append

**A gap is not an append.** An append that starts past the end of the buffer leaves keyframes with no
value, and there is nothing to interpolate across them. The viewer clears the buffer and refills it
from the new window. Answer from the end of what you delivered.

**A control is a `:replace`.** When the user asks for a different scene, push the replacement over the
frames already delivered with `mode = :replace`. That window is free to renumber the entities, carry
other families, or drop one — the change is the one the user asked for. A `:replace` mints a new
window identity, and a batch the same listener chain built is dropped with it, so declare the overlay
again with a call of its own rather than through `reply`.

## 5. What a reconnecting client gets

A retained `:append` extends a `:replace` the new client has never seen, so on its own it is a scene
with holes in it.

CesiumLink handles this, and the `core/need` listener is what it handles it with: when the last
window was an append **and the scene answers `core/need`**, a joining client is not sent the
retained window. The scene is asked for a `:replace` over the same frames instead, and that is what
the client is sent. A scene with no such listener has nothing to ask, so it replays the retained
append as it stands — which is the case described in step 1.

A listener that always appends, whatever `ev.mode` says, does not leave that client blank: the
server warns and falls back to the retained append, so the client draws the part of the scene that
window covers. A partial scene reports itself; silence would not.

So obey `ev.mode`:

```julia
push_window(server, payload;
            start_frame = ev.start_frame, count = ev.count, mode = ev.mode, ...)
```

## A worked example

[Constellation](../examples/constellation.md) delivers three hundred keyframes sixty at a time, with
a control beside it. Its page states the declared range against the buffer, and the whole source is
on it.

## Next

- [Windows, keyframes and identity](../explanation/windows.md) — what a window is the unit of.
- [Windows and scenes](../reference/windows.md) — `push_window` and its keywords.
- [Send large arrays](large-arrays.md) — what one window carries cheaply.
