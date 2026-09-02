# React to a click or a hover on a box

An overlay row, a group box, and a float report their own pointer events once the declaration
carries an `id`. A box that carries one is an [addressed box](../explanation/glossary.md), and
[`on_ui_pointer`](@ref) registers a listener for what it raises.

The `ui` module draws the boxes and raises the events, so register it once:

```julia
register_module!(server, vendored(:ui))
```

## Give a box an `id`

[`Title`](@ref), [`Legend`](@ref) and [`Group`](@ref) take an optional `id`. [`Toggle`](@ref),
[`Select`](@ref) and a [`Floating`](@ref) already carry one, so any of the six is addressable:

```julia
declare_overlay(server, [
    Title("Run 42"; id = "run-title"),
    Group([Toggle("trails", "Trails", true)]; region = :bottom_right, id = "panel"),
])
```

A box with no `id` raises nothing. A group's `id` names the box itself, and each control inside it
keeps its own name.

## Answer an alt-click on a title

The argument says which box to answer, and the keywords narrow the crossing:

```julia
on_ui_pointer(server, "run-title"; type = :click, alt = true) do ev, reply
    @info "alt-clicked the title" ev.id ev.screen
end
```

A plain click on that title never reaches this listener. The viewer forwards a crossing only where a
registered listener asked for it, and this one asked for the alt key held.

The event carries four fields of its own:

| Field | What it holds |
|:--|:--|
| `ev.type` | `:click`, `:enter` or `:leave` |
| `ev.id` | The id of the box that raised the event |
| `ev.mods` | The modifiers held at the crossing, as a tuple of symbols |
| `ev.screen` | The pointer, as `(; x, y)` in container pixels |

The `ui` module measures `ev.screen` against the viewer container, which is the space a
[`Screen`](@ref) anchor places a float in.

## Highlight something while the pointer is inside a box

A box has edges, so `:enter` and `:leave` happen once each. Two listeners on a float highlight the
entity the float anchors to, for as long as the pointer rests on the box:

```julia
declare_floating(server, [
    Floating("pin"; anchor = Entity("primitives", "site", 1), html = "<b>Paris</b>"),
])

# `hot` and `push_scene!` are your own code, not CesiumLink names.
hot = Ref(0)   # the 1-based site to highlight, 0 for none

on_ui_pointer(server, "pin"; type = :enter) do ev, reply
    hot[] = 1
    push_scene!()   # your helper: calls `push_window` with the highlight applied
end

on_ui_pointer(server, "pin"; type = :leave) do ev, reply
    hot[] = 0
    push_scene!()
end
```

Restyling the box itself is safe. A re-declaration rebuilds a box in place, and a box rebuilt under
the same `id` keeps its pointer state. It raises nothing, so a listener that restyles its own box on
`:enter` gets no second crossing and no loop.

Removing a box while the pointer is inside it raises the `:leave` anyway. Every `:enter` therefore
has one `:leave` behind it, and state you set on the way in always comes back off.

## Watch every box at once

Leave the argument off to answer every addressed box:

```julia
on_ui_pointer(server) do ev, reply
    @info "ui pointer" ev.type ev.id ev.mods ev.screen
end
```

Read the lines in the **server** log. This is the quickest way to see which boxes a declaration
addresses, and which crossings they raise.

## What a box does not raise

Four things this path leaves out:

- No `:move`. A box reports the two crossings and the click, and nothing between them.
- No event for a key pressed or released while the pointer is already inside. `ev.mods` is the set
  held at the moment of the crossing.
- Nothing from the furniture. The Core owns the timeline, the clock, and the buttons beside them.
  Only a box the `ui` module draws takes an `id`.
- No ordering between the two topics. A click on a `Toggle` or a `Select` raises both `ui/control`
  and `ui/pointer`, as two events. Act on the value from `ui/control`.

See ADR-0035 for the reasons, and for the alternatives it declines.

## Next

- [UI vocabulary](../reference/ui.md): every control, `Floating`, and where an `id` goes.
- [Events and commands](../reference/events.md): `on_ui_pointer`, the event fields, and the command
  batch.
- [Show a value on hover](tooltips.md): the globe's own pointer path, which a box never reaches.
- [Put a box on screen](floating.md): the anchors, the mount, and the rect a drag records.
