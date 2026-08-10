```@meta
CurrentModule = CesiumLink
```

# Windows and scenes

A **window** is a contiguous run of keyframes pushed together. One window message carries every
module's payload for those frames and installs them together. Every window carries an identity the
server assigns: a `:replace` takes a new identity and may re-index the entities its indices address,
an `:append` keeps the identity of the window it extends and preserves that index space.

A **scene** is whatever builds those windows and answers the events they raise. One server drives at
most one scene.

## Pushing a window

```@docs
push_window
CesiumLink.window_message
CesiumLink.window_id!
```

## Installing a scene

```@docs
serve_scene!
install_scene!
```

## Sending a frame that is already built

```@docs
CesiumLink.send_message
```
