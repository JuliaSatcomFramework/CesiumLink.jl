# Tutorials

These five tutorials teach CesiumLink from nothing. Work through them in order: each one starts
where the one before it stopped. Together they take about an hour.

## Before you start

You need:

- Julia 1.10 or later.
- CesiumLink installed in the project you start Julia in.
- A browser on the same machine as Julia.

Every tutorial runs in one Julia session and one browser tab, and ends with the complete script.

## The five tutorials

1. [Your first scene](first-scene.md) — start the server, draw five points on the globe, and put a
   caption above them.
2. [A scene that moves](moving-scene.md) — push a run of keyframes, and let the clock and the ruler
   play it.
3. [A control the server answers](controls.md) — add a toggle, answer it in Julia, and push the scene
   it asks for.
4. [Write a viewer module](first-module.md) — write an ES module of your own, and declare it over
   the wire beside the vendored ones.
5. [Ship a module from a Julia package](package-with-module.md) — put that module in a Julia package
   that serves it, and reach it from any scene.
