```@meta
CurrentModule = CesiumLink
```

# UI vocabulary

`CesiumLink.UI` is the payload vocabulary of the vendored `ui` module: the overlay list, the
floating objects and the tooltip. `CesiumLink` re-exports the names below, so `using CesiumLink`
reaches them.

Everything on top of the globe is one ordered list. A declaration replaces the previous list whole,
so removing an item means declaring the list without it. The server retains each declaration, so a
browser that connects later comes back to the same overlay.

A widget always shows the value the server declared. Operating a control reports the user's input
and changes nothing locally.

## The control interface

A third-party control subtypes [`AbstractControl`](@ref) and implements two functions,
`CesiumLink.kind` and `CesiumLink.payload`. `kind` names a widget kind that some module registered.
`payload` gives the fields that widget reads. The struct also carries a `region` field, and may
carry a `style` field.

```@docs
AbstractControl
CesiumLink.UI.kind
CesiumLink.UI.payload
```

## Controls

```@docs
Title
Legend
Toggle
Select
Group
declare_overlay
```

## Floating objects

```@docs
Floating
declare_floating
```

## Anchors

A float names one of three anchors. A `Screen` point stays where it was put. The Core re-projects an
`Entity` and a `World` point every frame, so the box rides what it names.

```@docs
Screen
Entity
World
```
