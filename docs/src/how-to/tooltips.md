# Show a value on hover

A tooltip is a hover listener that contributes HTML, addressed at the `ui` module on its `tooltip`
topic. Register the module once, before the first client connects:

```julia
register_module!(server, vendored(:ui))
```

## Two traps to read first

!!! warning "The entity index is already 1-based"
    Do not add one to `ev.entity.idx`. The wire counts entities from 0 and CesiumLink converts at its
    own boundary, so the index a listener receives already addresses your Julia arrays. A listener
    that adds one is off by one, and where it runs off the end it throws. That looks exactly like an
    unpickable entity.

!!! warning "A listener that throws paints nothing and says nothing on screen"
    Watch the **server** log. The chain isolates a listener that throws: it loses its own
    contribution, the listeners behind it still run, and the browser shows no error. The server
    warning carries the backtrace and is the only report you get.

## Write the listener

```julia
on_pointer(server; type = :hover) do ev, reply
    # Off an entity: null content, which is how the box is hidden.
    ev.entity === nothing &&
        return command!(reply, "ui", "tooltip", (; html = nothing))
    tooltip!(reply) do io
        i = ev.entity.idx
        print(io, "<b>Satellite ", i, "</b><br>", round(throughput[i, ev.frame]; digits = 1),
              " Gbps")
    end
end
```

[`on_pointer`](@ref) is the whole registration. The viewer forwards a hover only because a listener
asked for one: the subscription is derived from the registered set.

Note how the listener explicitly returns `html = nothing` when the hover picks no entity. Nothing
else hides the box. The `ui` module hides it only when a `ui/tooltip` command arrives with null
content, so a listener that replies with no command leaves the last content in place, and the box
goes on following the cursor.

## What the event carries

| Field | What it holds |
|:--|:--|
| `ev.entity` | The nearest entity under the cursor as `(module_id, kind, idx)`, or `nothing` |
| `ev.entities` | Every entity under the cursor, nearest first |
| `ev.frame` | The **1-based** keyframe the clock is on |
| `ev.window` | The identity of the window on screen |
| `ev.mods` | The modifiers held, as a tuple of symbols |
| `ev.screen` | The cursor, as `(; x, y)` in container pixels |
| `ev.coordinate` | The globe point under the cursor, or `nothing` |

`ev.coordinate` is `nothing` unless some listener registers with `coordinate = true`. The raycast is
an opt-in, so a session that never asks never pays for it.

Scan `ev.entities` when several families overlap. A highlight drawn over the shape it belongs to is
nearest and is rarely what the user aimed at:

```julia
i = findfirst(e -> e.kind == "cell", ev.entities)
```

## Contribute from more than one listener

Every listener answering one event shares one reply, and the fragments accumulate in chain order. One
hover paints one tooltip however many listeners spoke. Each fragment is mounted in its own shadow
root, so a fragment's `<style>` reaches nothing but itself.

Pass `bare = true` to drop the `ui` module's own chrome, and your markup owns the whole box:

```julia
tooltip!(reply; bare = true) do io
    print(io, "<div style='padding:8px;background:#111'>", svg, "</div>")
end
```

!!! warning "The HTML is not sanitised"
    Whatever a listener prints reaches the browser as markup and runs there. This is a trusted local
    viewer, so nothing filters it. Escape any string you did not author yourself before you print it
    into a tooltip.

## Keep the hover path fast

The chain runs to completion before the server assembles the batch, so a slow listener delays every
other contribution to the same event.

If the tooltip arrives late, raise the interval:

```julia
on_pointer(server; type = :hover, debounce_ms = 40) do ev, reply
```

The interval belongs to the subscription, not to the listener. Listeners that share a type and a set
of modifiers get one forwarded hover between them, at the smallest `debounce_ms` any of them asked
for. A listener that asked for more is not skipped: it runs on every forwarded hover, at that shared
rate. So raising one listener's interval changes nothing while another listener on the same interest
asks for less. The default is 5 ms.

The viewer forwards on the trailing edge of the interval, so a sweep across the globe costs one
round trip rather than one per rendered move. Hover is the only event an interval applies to.

A hover does not always follow a mouse move. A keyframe crossing under a resting cursor raises one at
the same position, re-picked, so the tooltip follows the clock as well as the pointer.

## Make the content stay put

A tooltip is stateless and is replaced on the next pointer move. Content that must stay while the
cursor moves on is a floating box instead — see [Put a box on screen](floating.md).

## Next

- [Events and commands](../reference/events.md) — `on_event`, `on_pointer`, the event fields and the command
  batch.
- [UI vocabulary](../reference/ui.md) — `tooltip!` and the overlay controls.
- [Why the server decides](../explanation/server-authoritative.md) — why the browser authors none of
  this.
