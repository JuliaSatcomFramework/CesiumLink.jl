```@meta
CurrentModule = CesiumLink
```

# The camera

A **viewpoint** says where the camera stands and which way it looks. A **camera track** is the whole
ordered set of viewpoints the server declares, each one carrying its own schedule. The server states
the track in one declaration, like the furniture and the overlay.

The camera is user state. The server holds it at the start of a session, so a declared viewpoint
seeds the opening view. A drag or a wheel on the globe gives the camera to the user, and the viewer
ignores every viewpoint after that until the user rejoins, or until one arrives that carries `take`.
A button never takes the camera: the canvas is the camera's surface.

| Schedule | The viewer applies the viewpoint |
|---|---|
| `at` | when the clock crosses that keyframe. A 1-based absolute keyframe index |
| `after` | that many seconds after the declaration. Absolute per entry, not cumulative |
| neither | on arrival |

A viewpoint can **ride** a moving thing instead of standing at a point, so the camera holds station
on a satellite and the ground sweeps below it. A drag on a camera that rides detaches, and does not
dismount: the user steers around the thing and carries on riding it. The `home` button gets off, and
so does any later viewpoint that flies somewhere else.

A tour rides something through a `Viewpoint`, and a listener answering a click rides something
through [`declare_follow`](@ref). The second leaves the declared track alone, so one scene does both.

```@docs
Viewpoint
declare_camera
declare_follow
```
