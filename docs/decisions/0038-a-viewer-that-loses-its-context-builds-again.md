---
status: accepted
---

# A viewer that loses its WebGL context builds again

A browser keeps a small number of WebGL contexts for each page: 16 in Chrome. When a page makes one
more, Chrome loses a context to make room. Three measurements in headless Chrome decide what a
viewer can do about it:

- Chrome loses the context that the page made first, not the one that it used last. A viewer
  that drew every frame for 3 s still lost its context to 15 idle contexts made after it. A figure
  that makes new contexts and frees none thus stops a globe that the reader looks at. A Plotly
  `scattergl` figure that a notebook cell draws again at each re-run can do this.
- Chrome does not give a lost context back by itself. `WEBGL_lose_context.restoreContext()` gives
  it back, but only when a listener called `preventDefault()` on the `webglcontextlost` event.
- Cesium draws nothing on a context that comes back. Its buffers, textures and shaders went with
  the old context. The render loop runs again with no error, `gl.getError()` gives
  `INVALID_OPERATION`, and the canvas stays black.

Before this decision, the next frame after the loss threw `DeveloperError: Expected width to be
greater than 0`, Cesium showed its "Rendering has stopped" panel, and only a reload of the page
brought the globe back.

## Decision

**The viewer builds itself again on a new canvas, on the same transport, and sends `ready` a second
time.**

**A new canvas, not the old context.** The handle that `createViewer` returns destroys the Core of the
lost viewer and builds a new one in the same container. The new widget makes a new context, and that
context is the newest on the page, so it is the last one that Chrome loses next.

**A second `ready`, not a new protocol message.** The server answers `ready` with the declaration
and the retained scene, which is what a client that connects now gets (ADR-0030). The declaration
names the modules that registered after the page loaded, and `core/replay` does not send it. A
second `ready` on the same connection asks the server for nothing that it does not already do. The
server does not change, and every host that forwards frames gets the rebuild: the browser page, the
VSCode tab and the Slate cell.

**The reader's view carries over.** The camera and the clock are plain objects, so the Core reads
them from the lost widget: the camera as a geographic position with heading, pitch and roll, the 2D
or 3D mode, and the time, speed and play state of the clock. The new build puts them back before its
first frame, and again after its first window, because that window puts the clock at its start and
a replayed camera track can move the camera (ADR-0017).

**The build starts when the viewer is in view.** At the loss, the widget stops its render loop and a
note covers it. An `IntersectionObserver` on the container starts the build, so a viewer on screen
builds at once and a viewer below the fold builds when the reader scrolls to it. A click on the note
also starts it. After three automatic builds in a minute, a build waits for a click.

**`destroy` frees the context.** Cesium does not free it, and the browser counts it against the
limit until garbage collection. `destroy` calls `WEBGL_lose_context.loseContext()`.

**A host whose transport cannot answer `ready` again opts out.** The recording player sets `recover:
false`, and its note asks for a reload.

## Consequences

A leak elsewhere on the page costs a globe a rebuild: about 350 ms in software rendering, with the
assets and the workers already in the page cache.

What the server does not hold goes back to the defaults of the session: the basemap that the reader
picked, the annotation toggles, a camera follow. A replayed camera track can also move the camera
again when the clock next crosses a keyframe that the track names.

On a scene that appends windows and answers `core/need`, the second `ready` makes the scene build a
replacement window, which every client receives. A page that joins in mid-session costs the same.

Two viewers on screen, on a page at the limit, can take the context from each other. The limit of
three automatic builds in a minute stops that loop, and a click then decides.

The rebuild cannot stop the leak. A page that makes contexts faster than it frees them loses one
every few re-runs, and the fix of that belongs to the code that leaks.

## Alternatives declined

**Restore the old context.** Cesium draws nothing on it, as measured above. A restore would also
need Cesium to make every GPU object again, which it has no path for.

**Build only the widget, and keep the delivered windows in the Core.** The modules hold primitives
of the old scene, so every module would need a second setup against the kept windows. The second
`ready` reaches the same state through the path that every connecting client already uses.

**Send `core/replay` instead of `ready`.** It sends the retained scene without the declaration, so a
module that registered after the page loaded would not load in the new Core.

**Free the context of a viewer off screen, and build it again on approach.** Chrome loses the oldest
context whatever the reader looks at, so this does not protect a viewer on screen from a leak. It
helps only a page with more than 16 live viewers, and it costs every viewer a rebuild at each scroll.

**Build again at once, on a timer, or with no limit.** A viewer below the fold would take a context
that a viewer on screen needs, and two viewers on screen would take the context from each other with
no end.
