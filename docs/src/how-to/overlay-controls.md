# Put controls in the overlay

The overlay is the list of widgets over the globe: captions, colour bars, checkboxes and dropdowns.
The `ui` module draws them, so register it once:

```julia
register_module!(server, vendored(:ui))
```

[Tutorial 3](../tutorials/controls.md) walks through one checkbox from the click to the answer.

## Declare the whole list

[`declare_overlay`](@ref) states the **whole** overlay. Re-declaring replaces it, so you remove a
widget by declaring the list without it:

```julia
declare_overlay(server, [
    Title("Ninety satellites over Europe"),
    Legend("Throughput (Gbps)", 0, 12, CMAP),
    Toggle("trails", "Trails", true),
])
```

The list is retained, so a browser that connects later comes back to the same overlay.

## Dropdown selection

[`Select`](@ref) is a dropdown. It takes the options as `value => label` pairs, then the value the
server declares:

```julia
Select("cells", "Cells", "served", ["all" => "All", "served" => "Served", "idle" => "Idle"])
```

The constructor refuses a declared value that is not one of the options.

An option's value travels as JSON, so a `Symbol` option arrives as a `String`. The listener reports
one of the options you declared:

```julia
on_event(server, "ui", "control") do ev, reply
    ev.payload.id == "cells" || return nothing
    # `filter`, `declare!` and `push_scene!` are your own code, not CesiumLink names.
    filter[] = ev.payload.value  # your Ref, now holding "all", "served" or "idle"
    declare!()                   # your helper: calls `declare_overlay` with the new value
    push_scene!()                # your helper: calls `push_window` for the chosen filter
end
```

[Tutorial 3](../tutorials/controls.md) defines both helpers in full.

## Group controls in a box

[`Group`](@ref) draws several controls inside one box:

```julia
Group([Toggle("trails", "Trails", true),
       Select("cells", "Cells", "served", ["all" => "All", "served" => "Served"])];
      region = :bottom_right)
```

The group's `region` places the box, and the `region` of a control inside it says nothing. Each
control still reports under its own `id`.

The box is a column of its children, so two colour bars stand side by side on one property:

```julia
Group([Legend("Throughput (Gbps)", 0, 12, SAT_CMAP),
       Legend("Satisfaction", 0, 1, CELL_CMAP)];
      region = :top_left, style = (; flex_direction = "row"))
```

A group does not nest.

## Choose a corner

Every control takes `region`, one of `:top_left`, `:top_center`, `:top_right` and `:bottom_right`.
Each region stacks its own controls in declaration order. `Title` sits at `:top_center`, `Legend` at
`:top_left`, and every other control at `:bottom_right`.

`style` is CSS merged over the widget's own rule, with `_` lowered to `-`:

```julia
Title("Fleet status"; region = :top_left, style = (; font_size = "20px"))
```

## Next

- [UI vocabulary](../reference/ui.md) — every control and its keywords.
- [A control the server answers](../tutorials/controls.md) — the click, the report and the answer.
- [Why the server decides](../explanation/server-authoritative.md) — why a widget shows the declared
  value and never the clicked one.
