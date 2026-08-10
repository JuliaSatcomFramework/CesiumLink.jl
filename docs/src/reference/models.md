```@meta
CurrentModule = CesiumLink
```

# Models vocabulary

`CesiumLink.ModelFamilies` is the payload vocabulary of the vendored `models` module: one glTF model
per entity of a node family, turned by a reference frame and an attitude. `CesiumLink` re-exports
the two names below, so `using CesiumLink` reaches them.

The submodule is named `ModelFamilies` and not `Models`, because a module and a type inside it
cannot share a name. The file and the wire id both read `models`.

A model family carries neither a position nor a colour. Where a model stands belongs to the
[`CesiumLink.Primitives.Nodes`](@ref) family it names as its anchor, and what it looks like belongs
to the file. A click on a model reports the anchor entity, and never the model.

## The family and its payload

```@docs
Models
models_payload
CesiumLink.ModelFamilies.FRAMES
```

## See also

- [Put your own model on a satellite](../how-to/models.md) — mounting the folder, and turning the
  model.
- [Primitives vocabulary](primitives.md) — the node family a model family anchors to.
