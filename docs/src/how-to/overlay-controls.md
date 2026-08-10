# Put controls in the overlay

The overlay is the list of widgets over the globe: captions, colour bars, checkboxes and dropdowns.
The `ui` module draws them, so register it once:

```julia
register_module!(server, vendored(:ui))
```

[Tutorial 3](../tutorials/controls.md) walks through one checkbox from the click to the answer. This
guide is the rest of the vocabulary.

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

## Offer a choice out of several

[`Select`](@ref) is a dropdown. It takes the option list as `value => label` pairs, and the value the
server declares:

```julia
Select("cells", "Cells", "served", ["all" => "All", "served" => "Served", "idle" => "Idle"])
```

The declared value must be one of the options. A declaration that rejects its own value is refused at
the constructor, because a widget showing one state while the scene is filtered by another is worse
than an error.

An option's value travels as JSON, so it comes back to your listener as JSON carries it. A `Symbol`
option is recorded as a `String`, and the value the listener reports is one of the options you
declared:

```julia
on_event(server, "ui", "control") do ev, reply
    ev.payload.id == "cells" || return nothing
    filter[] = ev.payload.value      # "all", "served" or "idle"
    declare!()
    push_scene!()
end
```

## Put related controls in one box

[`Group`](@ref) draws several controls inside one box, so they read as one thing rather than as a
stack:

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

A group does not nest. One level is what grouping related controls needs, and the four regions
already separate the corners.

## Choose a corner

Every control takes `region`, one of `:top_left`, `:top_center`, `:top_right` and `:bottom_right`.
Each region stacks its own controls in declaration order. `Title` sits at `:top_center`, `Legend` at
`:top_left`, and every other control at `:bottom_right`, so a list you write without regions already
lands in sensible places.

`style` is CSS merged over the widget's own rule, with `_` lowered to `-`:

```julia
Title("Fleet status"; region = :top_left, style = (; font_size = "20px"))
```

## Next

- [UI vocabulary](../reference/ui.md) — every control and its keywords.
- [A control the server answers](../tutorials/controls.md) — the click, the report and the answer.
- [Why the server decides](../explanation/server-authoritative.md) — why a widget shows the declared
  value and never the clicked one.
