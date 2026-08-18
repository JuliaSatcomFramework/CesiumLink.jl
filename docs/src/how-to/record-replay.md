# Record a session and play it back

You want the scene without the thing that produced it: a demo on a laptop with no simulator, or a
bug report someone else can open. Record the frames the server broadcast, then replay them into
another server.

## Record

[`record!`](@ref) opens the sink. Every frame the server broadcasts from then on is written to it.

```julia
server = start_server()
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:ui))

record!(server, "session.jsonl")
# … drive the scene: push windows, answer events, declare the overlay …
stop_recording!(server)
```

Three things to know:

- Whatever the server already retains is written first, at offset zero. A recording started
  mid-session opens with the scene as it stands.
- The recording's header names the modules registered at that moment, and the scene they were
  declared into. The server sends that declaration per connection, so it is never broadcast.
- [`record!`](@ref) again replaces the sink. [`stop_server`](@ref) calls
  [`stop_recording!`](@ref) for you.

The file is flushed per frame. You can read it while the session still runs, and it survives a
killed process.

## What the file holds

JSON Lines. The first line is the header, printed here over several lines:

```json
{ "recording": 2,
  "modules": [
    { "id": "primitives", "path": "…/primitives.js", "apiVersion": 1 }
  ],
  "ellipsoid": { "a": 1737400, "b": 1737400 },
  "lighting": true,
  "stars": true }
```

`ellipsoid`, `imagery`, `furniture`, `lighting` and `stars` are the scene the session
declared. Each is written only when the session declared it, so a header holds none by
default. The player builds its globe and its furniture from them before the first paint.

`furniture` is in the file twice: here, and as the retained `core/furniture` command under the
header. The retained command stays the one source of the set.

The header carries `imagery` only when the tiles travel with the file. Two values do:

- an absolute URL, which is reachable from any machine;
- `false`, a globe with no base layer, which names no tiles.

A basemap this server mounts is a relative URL under `assets/imagery/…`. It answers nothing
once the server stops, so [`record!`](@ref) drops it from the header and warns. Copy the tiles
beside the recording, then name them with `?imagery=`, which takes a URL relative to the player
page:

```
player.html?rec=session.jsonl&assets=../assets/&imagery=../assets/imagery/moon/
```

`?assets=` cannot name a basemap. It resolves the `assets/<mount>/<file>` URIs a payload
carries, and the dropped basemap leaves the header with no `imagery` field to resolve. The two
parameters also take different folders: `?assets=` takes the folder the mounts sit in, and
`?imagery=` takes the mount folder itself.

Every line after it is one broadcast frame:

```json
{"t":1.071,"msg":{"method":"window","params":{…}},"blobs":"AACAPwAAQEA…"}
```

`t` is seconds into the recording. `msg` is the frame's header, verbatim as an inline
object. `blobs` is the frame's region as base64.

`msg` is an object, so `jq` reads a line directly. Guard on `.msg` to skip the header line:

```sh
jq -r 'select(.msg) | "\(.t)  \(.msg.method)"' session.jsonl
jq 'select(.msg.method == "window") | .msg.params | {startFrame, count, mode, window}' session.jsonl
```

Array bytes are the one thing `jq` cannot read. A payload names an offset into `blobs`, and
`tools/decode-frame.jl` decodes it. See
[Look at what the wire carried](inspect-the-wire.md).

## Replay

[`replay`](@ref) sends the recorded frames through a live server, paced as they were
recorded. It blocks for as long as the session lasted, so run it in a task to keep driving
the server while it plays.

```julia
server = start_server()
@async replay(server, "session.jsonl")
```

Then open the viewer. `speed` scales the pacing: `2.0` plays twice as fast, and a very large
value plays as fast as the frames can be sent.

```julia
replay(server, "session.jsonl"; speed = 1000)
```

The server broadcasts and retains each frame exactly as the live call did, so a viewer that connects
part-way through is caught up to where the replay reached.

Two conditions to obey:

- **Register the recording's modules, or leave their recorded paths in place.** For a module the
  recording names and the server does not hold, the server uses the recorded path, so that file must
  still be there. Hand a recording that travelled to a server with those modules already registered.
- **Do not push windows of your own onto a server that is replaying one.** The server takes
  on the window identity the recording stamped, so the replay owns the scene.

## The limit: a replay runs no listeners

A recording holds everything the session sent, the answers its listeners gave included. A
replay re-sends those answers. It does not *run* the listeners.

So the recorded overlay appears, and its toggles and dropdowns are live widgets. Operating one
reaches nobody, and a hover over an entity produces no tooltip. The scene plays on unchanged.

One thing does play back: the **camera track**. A track is an ordinary retained command, so a replay
flies the tour the recorded session declared, and pausing and scrubbing carry the camera with them.
See [Give a recording a tour](camera-tour.md).

To make the rest of the session answer, register listeners against the replaying server:

```julia
server = start_server()
on_pointer(server; type = :hover) do ev, reply
    ev.entity === nothing && return nothing
    tooltip!(reply) do io
        print(io, "<b>", ev.entity.kind, " #", ev.entity.idx, "</b>")
    end
end
@async replay(server, "session.jsonl")
```

A listener that answers a control event usually pushes a window, and a replay owns the scene.
So a control that re-pushes works only after the replay finishes. A listener that
contributes a tooltip or a float works while the replay runs.

## Play a recording in a web page, with no Julia at all

The viewer ships a second page, `player.html`, that reads a recording instead of connecting
to a server. Everything the Core owns works: the camera, the clock, playback, scrubbing, the
ruler and the furniture. Nothing that needs a server answers, exactly as above.

The scene below is a recording, played in this page. No Julia process is running.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/orbit.jsonl&modules=modules"
        title="A recorded CesiumLink session, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

The camera moves on its own: the recorded session declared a **camera track**, which replays
like every other retained command. The camera-follow item at the bottom left reads
**Camera: following the scene** while the tour has it.

Drag to turn the globe and the tour stops: input on the globe takes the camera and keeps it,
so the item changes to **Camera: yours** and offers a **Rejoin** button. **Rejoin** gives the
camera back at the viewpoint that applies **now**, which is where the tour reached rather
than where you left it.

Use the clock at the bottom left to pause and to change speed, and drag the ruler to scrub.
A scrub leaves the clock paused, so press play again to carry on. This tour is keyed by
keyframe, so the camera holds while the scene holds and goes back with it when you scrub.
The legend and the caption came from the recorded overlay.

Point the page at your own file with query parameters. These four say where files are:

| Parameter | Meaning |
|---|---|
| `rec` | URL of the recording. Required. Resolved against the player page. |
| `modules` | Where the built modules are served from. Defaults to `modules`. |
| `assets` | Where the directories the session served were copied to. A mount is `<assets>/<name>/`. |
| `speed` | Scales the recorded pacing. `Infinity` delivers every frame at once. |

The recording states its own scene, so you need none of the rest. The player still reads them, and
they beat the header, which is how you name a basemap that did not travel with the file:

| Parameter | Meaning |
|---|---|
| `imagery` | Tile URL template, or a TMS pyramid directory. |
| `tiling` | `geographic` or `mercator`, for an XYZ template. |
| `maxlevel` | Deepest level of an XYZ pyramid. |
| `credit` | Attribution text, drawn as text and never as markup. |
| `ellipsoid` | Radii in metres, semi-major first: `1737400,1737400` is the Moon. |

The player reads **version 2 recordings only**, which is every recording this package writes. It
refuses a header that states any other number.

Two things decide whether the page shows the scene at once or builds it up:

- [`record!`](@ref) writes the retained scene at offset zero, so a recording opened after the
  scene is pushed starts with the scene already standing.
- A recording of a session that streamed windows over time plays at the pace it was
  recorded. A scrub back still works: the player answers a request for keyframes out of
  the recorded windows.

## Next

- [Recording](../reference/recorder.md) for the whole surface.
- [Look at what the wire carried](inspect-the-wire.md) to decode a recorded frame.
