```@meta
CurrentModule = CesiumLink
```

# Reference

This section describes what CesiumLink offers, one page per part of the package. The Julia pages
carry the docstring of every symbol the package documents. The two JavaScript pages are the
normative contracts the browser side implements, and both sides of the wire are written against
them.

The page order follows the shape of the package. The server comes first, then what travels over its
connection: windows, events and commands. The vocabulary pages after those are what a scene builds a
payload out of, one page per vendored module. The last pages hold the support code a scene reaches
for, and the wire codec beneath all of it.

## The package

```@docs
CesiumLink
```

## Julia

- [The server](server.md): the listener, the module set and the viewer bundle.
- [Windows and scenes](windows.md): pushing keyframes, and installing a scene.
- [Events and commands](events.md): the listener registry, the reply batch and the tooltip.
- [Primitives vocabulary](primitives.md): points, lines and footprints.
- [UI vocabulary](ui.md): the overlay list, the floating objects and their anchors.
- [Heatmap vocabulary](heatmap.md): a coloured field draped over a box of degrees.
- [Models vocabulary](models.md): one glTF model per entity of a node family.
- [Furniture and regions](furniture.md): the Core's own on-screen items, and the overlay CSS.
- [The camera](camera.md): the viewpoints the server declares, and when each one applies.
- [Colours](colormap.md): colormaps, colour bytes and legend stops.
- [Coordinates](geodesy.md): geodetic degrees and ECEF metres.
- [Recording](recorder.md): writing a session to a file, and replaying it.
- [Wire codec](codec.md): the internal frame and array encoding.

## JavaScript

- [Module API](wire/module-api.md): the contract a viewer module implements.
- [Wire protocol](wire/protocol.md): the contract the transport encoding obeys.

## Index

```@index
Pages = [
    "index.md",
    "server.md",
    "windows.md",
    "events.md",
    "primitives.md",
    "ui.md",
    "heatmap.md",
    "models.md",
    "furniture.md",
    "camera.md",
    "colormap.md",
    "geodesy.md",
    "recorder.md",
    "codec.md",
]
```
