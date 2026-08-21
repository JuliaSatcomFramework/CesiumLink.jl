# Deliver a long mission a piece at a time

Your mission is fifty thousand keyframes. One window means you compute all of it before anything
appears, hold all of it in the browser, and pay for the part nobody plays.

Declare the whole range and deliver a part of it. The viewer asks for the rest as playback
approaches the end of what it holds.

## 1. Declare the whole range, deliver a part

```julia
push_window(server, payload_for(1:10);
            start_frame = 1, count = 10, total_frames = 50_000,
            dt_seconds = 30, interval_seconds = 0.15)
```

`total_frames` is the mission. `count` is the buffer, what the viewer holds now. The clock, the ruler
and scrubbing all work against the declared range, so the ruler spans the whole fifty thousand from
the first window on.

**Prefer a small `count`.** This package streams a mission a chunk at a time, and `count` is the
chunk. A small window reaches the browser sooner, so the scene starts drawing earlier and the
interaction stays responsive. It also bounds what the Core keeps: a `:replace` window is held
entire, and an `append` is trimmed back to the span the buffer had before it, so the first window's
`count` sets the memory footprint for the run.

Ten frames is a reasonable place to start. The Core keeps at least eight, so a smaller chunk saves
nothing. Raise it when a measurement asks you to: a payload heavy enough that one chunk per interval
does not keep up, or a link whose round trip is long enough that the buffer runs dry between asks.

Keep `total_frames` fixed for the run. A window that states a different one re-declares the range,
which forces a `:replace` and drops the buffer — the opposite of what this page is for.

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

Register it. Without a listener:

- a client that joins mid-session is sent only what the server retains, and
- an append cannot stand on its own for that client, so it gets a scene that is missing whatever rode
  the window it never saw.

Answer with more than you were asked for. The Core asks for the frames it wants, which can be two.
Round the count up to a chunk you choose.

## 3. Answer with an append

`mode = :append` extends the buffer the viewer holds. The window it extends keeps its identity, so a
request raised against the earlier window is still valid.

!!! warning "An append preserves the index space"
    Entity `i` is the same entity it was. An [`Edges`](@ref) family joins two other families by
    index, and a pick reports an index, so a window that orders the entities differently makes both
    address something else. On screen it reads as every entity teleporting at the seam.

## 4. When it is not an append

**A gap is not an append.** An append that starts past the end of the buffer leaves keyframes with no
value, and there is nothing to interpolate across them. The viewer clears the buffer and refills it
from the new window. Answer from the end of what you delivered.

**A control is a `:replace`.** Push the replacement over the frames already delivered with
`mode = :replace`. That window is free to renumber the entities, carry other families, or drop one.

!!! warning "A `:replace` drops the batch the listener was building"
    The server compares the window identity before and after the listener chain runs, and sends
    nothing when it changed. Every command the chain put in `reply` is discarded: a tooltip, a
    float, a camera move and an overlay alike. A replace may renumber the entities, so an index
    resolved against the scene the event was raised on addresses something else now.

    State what the new scene needs with a call of its own, such as [`declare_overlay`](@ref),
    rather than through `reply`.

## 5. What a reconnecting client gets

A retained `:append` extends a `:replace` the new client never saw, so on its own it is a scene with
holes in it.

The `core/need` listener answers that. When the last window was an append **and the scene answers
`core/need`**, a joining client is not sent the retained window: the scene is asked for a `:replace`
over the same frames, and the client is sent that. A scene with no such listener replays the retained
append as it stands.

A listener that always appends, whatever `ev.mode` says, does not leave that client blank. The
server warns and falls back to the retained append, so the client draws the part of the scene that
window covers.

So obey `ev.mode`:

```julia
push_window(server, payload;
            start_frame = ev.start_frame, count = ev.count, mode = ev.mode, ...)
```

## 6. Build the frames before they are asked for

`core/need` gives you very little warning. The Core asks two keyframes before the buffer runs out,
so at `interval_seconds = 0.15` you have about 300 ms. That is enough to look a payload up. It is
not enough to compute one.

Two events say where the clock is and where it goes, so a listener can build the frames first and
answer `core/need` from a cache:

```julia
const TOTAL = 50_000             # the declared range, which is what an index must stay inside
const DT = 30                    # the dt_seconds this scene declared

cache = Dict{Int,Any}()          # absolute keyframe index → the payload for it
lead = Ref(8)                    # how many frames ahead to hold
step = Ref(1)                    # +1 forwards, -1 backwards

# Which way playback runs, and how fast. `ev.multiplier` is mission seconds per real second, so
# `abs(ev.multiplier) / DT` is keyframes per real second.
on_event(server, "core", "clock") do ev, _
    step[] = ev.multiplier < 0 ? -1 : 1
    rate = abs(ev.multiplier) / DT
    lead[] = max(4, ceil(Int, rate * 0.5))    # half a second of frames
end

# Where the clock is now. Build what comes next, off the listener task.
on_event(server, "core", "keyframe") do ev, _
    @async for k in ev.index .+ step[] .* (0:lead[])
        # The run ends at both ends. Near either one the clock has fewer frames left to play than
        # the lead asks for, and a frame outside the range is one nothing can ever ask for.
        1 <= k <= TOTAL || continue
        get!(() -> payload_for(k), cache, k)
    end
end

on_event(server, "core", "need") do ev, _
    frames = ev.start_frame:(ev.start_frame + ev.count - 1)
    push_window(server, [get!(() -> payload_for(k), cache, k) for k in frames];
                start_frame = ev.start_frame, count = ev.count, mode = ev.mode,
                total_frames = TOTAL, dt_seconds = DT)
end
```

`ev.index` and `ev.start_frame` are both **1-based**, like every index the Julia API reports.

Three things to know:

- **A crossing stops arriving when you fall behind.** The viewer reports a crossing only while the
  buffer covers the clock. An instant it does not cover raises `core/need`. So a crossing means
  playback runs well, and a need means it starves. Do not build a timer that waits for crossings.
- **`ev.playing` is the button, not the buffer.** The Core holds the clock while the buffer fills,
  and `ev.playing` stays true through it. Use it to know what the user wants. Do not use it to ask
  whether you keep up.
- **Do not try to hold a copy of the viewer's buffer.** The Core drops frames on its own and you
  cannot see which. Key the cache on the absolute index, answer whatever `core/need` asks for, and
  let the overlap be free. Bound the cache yourself: drop what the clock left behind.

A scrub needs no event of its own. A scrub inside the buffer crosses keyframes, so the crossings
tell you where the user went. A scrub outside it raises `core/need` at the new index, and you build
from there.

## A worked example

[Constellation](../examples/constellation.md) delivers three hundred keyframes sixty at a time, with
a control beside it. Its page states the declared range against the buffer, and holds the whole
source.

## Next

- [Windows, keyframes and identity](../explanation/windows.md) — what a window is the unit of.
- [Windows and scenes](../reference/windows.md) — `push_window` and its keywords.
- [Send large arrays](large-arrays.md) — what one window carries cheaply.
