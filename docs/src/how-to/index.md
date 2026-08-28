# How-to guides

Each guide solves one problem and assumes you can already start a server and push a window. If you
cannot, read the [tutorials](../tutorials/index.md) first. For the whole surface of a function, go to
[Reference](../reference/index.md). For why the system is shaped this way, go to
[Explanation](../explanation/index.md).

## Put something on the globe

- [Draw points, lines and areas](primitives.md) — the three families the `primitives` module draws,
  and the array shapes they take.
- [Drape a scalar field over the globe](heatmap.md) — a grid of values as colour on the surface.
- [Put your own model on a satellite](models.md) — a glTF file on an entity `primitives` owns, and
  what it costs to draw.
- [Work in map coordinates](coordinates.md) — degrees in, ECEF metres out, on the ellipsoid the
  session declared.

## Answer the user

- [Show a value on hover](tooltips.md) — a hover listener that writes the tooltip for the entity
  under the cursor.
- [Put controls in the overlay](overlay-controls.md) — the caption, the colour bar, the checkbox, the
  dropdown, and the box that holds several.
- [Put a box on screen](floating.md) — a box anchored to the screen, to an entity, or to a point on
  the globe.

## Decide what the viewer shows

- [Choose the on-screen furniture](furniture.md) — which of the Core's own items are on screen, and
  where the buttons sit.
- [Show a scene with no clock](static-scene.md) — one keyframe, and no time controls beside it.
- [Choose what the globe is textured with](basemap.md): the basemap set the reader picks inside,
  how to take the network out of it, and how to put satellites around the Moon.
- [Give a recording a tour](camera-tour.md) — declare where the camera looks, and when it goes
  there.

## Write JavaScript

- [Write a module with no build step](no-build-module.md) — several files, a library from the web, or
  a module held as a Julia string.

## Move the data

- [Send large arrays](large-arrays.md) — what the wire carries cheaply, and what it refuses.

## Deliver the data

- [Deliver a long mission a piece at a time](lazy-delivery.md) — declare the whole range, send a
  chunk, and answer `core/need` with the rest.

## Look at the scene

- [Show a scene in a VSCode tab](vscode-tab.md) — a live scene in an editor panel, with no forwarded
  port.
- [Show a scene in a notebook cell](slate-cell.md) — a live scene in a KaimonSlate cell, on the
  socket the notebook page already holds.

## Look at what happened

- [Record and replay a session](record-replay.md) — write the frames to a file, and drive a viewer
  from that file later.
- [Take a picture of the globe](capture.md) — one PNG of the canvas, to a file from Julia or to
  the clipboard from a button.
- [Look at what the wire carried](inspect-the-wire.md) — read a frame, its header and its region by
  hand.
