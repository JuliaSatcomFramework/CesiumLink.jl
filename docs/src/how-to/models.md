# Put your own model on a satellite

A [`Models`](@ref CesiumLink.Models) family draws one glTF model per entity of a node family. It
carries no position of its own: a model stands where its anchor stands, and a click on it reports
that entity in the `primitives` namespace.

**The `.glb` itself must be same-origin.** `uri` is a path under an `assets` mount, and the
constructor refuses anything else.

**Prefer a self-contained `.glb`.** A file that fetches its textures from another host needs that
host in `trusted_origins`, or a VSCode panel never gets them: its webview runs under a content
security policy that the list widens. A browser page runs under none.

**Do not expect a model to point the right way without `axes`.** Cesium takes a model's +X as
forward, and most files disagree.

## 1. Mount the folder the file is in

```julia
using CesiumLink

server = start_server(; assets = "/data/glb")
```

The server serves the folder under the last element of its path, so `/data/glb/sat.glb` answers on
`assets/glb/sat.glb`. Pass a `Dict` to name the mount yourself, or to mount more than one folder:

```julia
start_server(; assets = Dict("models" => "/data/glb", "textures" => "/data/png"))
```

Mounts are fixed at `start_server`, so serving another folder means starting a new server. The set is
frozen because a VSCode panel is given the folders it may read when it is created, and cannot be
given more later.

## 2. Declare both modules

```julia
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:models))
```

Declare both, in either order. The `of` keyword of the `Models` constructor names a family in the
`primitives` payload, so the `models` module draws nothing alone.

## 3. Declare the family

The two payloads travel in envelopes of their own, in one window:

```julia
push_window(server, Dict(
                :primitives => primitives_payload(Nodes(:sat; position = pos, size = 8)),
                :models => models_payload(
                    Models(:sat_body; of = :sat, uri = "assets/glb/sat.glb",
                           range = (0, 2e6), minimum_pixel_size = 48)));
            start_frame = 1, count = 240, dt_seconds = 60, total_frames = 240)
```

`range` is `(near_m, far_m)`, the camera distance the family draws in. It has no default: you choose
the distance beyond which a model is a smudge.

## 4. Turn it

Three rotations turn a model, and each answers a different question:

| keyword | what it answers | varies with |
|---|---|---|
| `frame` | which way is up, and which way is along-track, where the entity is now | the anchor's position |
| `orientation` | where the entity points inside that frame | the entity, and the keyframe |
| `axes` | which way the file was modelled | nothing: one value per family |

They compose as `frame × orientation × axes`, so `axes` turns the model's own vertices first and
`frame` turns the result last.

Reach for `frame` first. A spacecraft that flies the way it points needs `frame = :velocity` and no
attitude in Julia. One that holds an attitude a simulation computed needs `frame = :ecef` and a
quaternion per entity. `:nadir` points +Z at the centre of the body, and `:enu` is east-north-up.

`orientation` takes `4 × N` for an attitude that stands through the window, and `4 × N × count` for
one that varies across it.

`axes` corrects the file, not the scene. Cesium takes a model's +X as forward and most files
disagree, so `axes` states how this `.glb` was built and says nothing about where the entity points.
It is one `(heading, pitch, roll)` for the whole family. Set it once, by eye, and leave it.

## What a model costs

A node family of any size is one draw command. A model is not batched:

| what is on screen | draw commands |
|---|---|
| one model, in range | 5 |
| one entity with an ellipsoid, a model and a label | 9 |
| the same family, outside `range` | 0 |

Forty modelled satellites at mission zoom cost forty times the first row. `range` is what keeps that
cost at zero for the rest of the session.

## A model at mission range is smaller than a pixel

A spacecraft a few metres across, seen from twelve thousand kilometres up, covers nothing. So `scale`
alone forces a choice between a model nobody can see and one the size of a country.

`minimum_pixel_size` removes the choice. The model keeps its true `scale`, and is drawn at least that
many pixels wide however far away it is. It reads as an icon at mission zoom, and becomes true-scale
as the camera flies in:

```julia
Models(:sat_body; of = :sat, uri = "assets/glb/sat.glb", range = (0, 2e6),
       scale = 1, minimum_pixel_size = 48)
```

## Two models on one satellite

A body and an antenna that turns independently are two `Models` families over one `Nodes` family.
Both stand on the same position, and each carries its own attitude:

```julia
models_payload(
    Models(:sat_body; of = :sat, uri = "assets/glb/bus.glb", range = (0, 2e6),
           frame = :nadir),
    Models(:sat_dish; of = :sat, uri = "assets/glb/dish.glb", range = (0, 5e5),
           frame = :nadir, orientation = q_dish))
```

Compose the rotation in Julia. There is no parent concept here: Cesium's `Entity.parent` carries
`show` and `availability` but composes no transform, so a dish declared as a child of the bus would
not turn with it. `q_dish` is the dish's attitude in the frame the family names, not its attitude
relative to the bus.

The two families may state different `range` values. A dish that reads as a smudge until the camera
is close costs nothing until then.

## A recording carries no assets

A [recording](record-replay.md) holds the frames a session sent, and no file any of them named. So a
replay draws the markers and no models, unless you tell the player where the folders went:

```
player.html?rec=session.jsonl&assets=../assets/
```

The player reads `assets/<mount>/<file>` under that base, so copy each mounted folder there under
the name it was mounted with.

## Next

- [The models vocabulary](../reference/models.md) — `Models`, `models_payload` and every keyword.
- [Draw points, lines and areas](primitives.md) — the node family a model family anchors to.
- [Record and replay a session](record-replay.md) — what a recording carries, and what it does not.
