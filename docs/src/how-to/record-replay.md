# Record a session and play it back

You want the scene without the thing that produced it: a demo on a laptop with no simulator,
a bug report someone else can open, a fixture a test drives a real browser through. Record
the frames the server broadcast, then replay them into another server.

## Record

[`record!`](@ref) opens the sink. Every frame the server broadcasts from that moment is
written to it.

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
- The modules registered at that moment are named in the recording's header, along with the
  scene they were declared into. The declaration is sent per connection, so it is never
  itself broadcast.
- [`record!`](@ref) again replaces the sink. [`stop_server`](@ref) calls
  [`stop_recording!`](@ref) for you.

The file is flushed per frame. It is readable while the session is still running, and it
survives the process being killed.

## What the file holds

JSON Lines. The first line is the header:

```json
{"recording":2,"modules":[{"id":"primitives","path":"…/primitives.js","apiVersion":1}],
 "ellipsoid":{"a":1737400,"b":1737400},"lighting":true,"stars":true}
```

`ellipsoid`, `imagery`, `furniture`, `lighting` and `stars` are the scene the session
declared. Each one is written only when the session declared it, so a header holds none of
them by default. The player builds its globe and its furniture from them, before the first
paint.

The `furniture` is in the file twice: here, and as the retained `core/furniture` command
written under the header. That is the duplication the live declaration carries, and the
retained command stays the one source of the set.

A basemap joins them only when its tiles travel with the file — an absolute URL, or `false`
for a globe with no base layer. A directory this server mounts is declared as
`assets/imagery/…`, which answers nothing once the server stops, so [`record!`](@ref) drops
it and says so. Give the player `?imagery=` for wherever you copy those tiles to.

What the header never carries is where files are. The module URLs and the mounted
directories belong to a server that has stopped, and only the replaying page knows where they
went: a recording carries the scene it recorded, and not the machine that served it.

Every line after it is one broadcast frame:

```json
{"t":1.071,"msg":{"method":"window","params":{…}},"blobs":"AACAPwAAQEA…"}
```

`t` is seconds into the recording. `msg` is the frame's header, spliced in verbatim as an
inline object. `blobs` is the frame's region as base64.

Because `msg` is an object and not a string, `jq` reads a line directly. Guard on `.msg`, so
the header line does not answer:

```sh
jq -r 'select(.msg) | "\(.t)  \(.msg.method)"' session.jsonl
jq 'select(.msg.method == "window") | .msg.params | {startFrame, count, mode, window}' session.jsonl
```

Array bytes are the one thing `jq` cannot read. A payload names an offset into `blobs`, and
`tools/decode-frame.jl` is what decodes it. See
[Look at what the wire carried](inspect-the-wire.md).

## Replay

[`replay`](@ref) sends the recorded frames through a live server, paced as they were
recorded. It blocks for as long as the session lasted, so run it in a task if you want to
keep driving the server while it plays.

```julia
server = start_server()
@async replay(server, "session.jsonl")
```

Then open the viewer. `speed` scales the pacing: `2.0` plays twice as fast, and a very large
value plays as fast as the frames can be sent.

```julia
replay(server, "session.jsonl"; speed = 1000)
```

Each frame is broadcast and retained exactly as the live call would have retained it, so a
viewer that connects part-way through is caught up to where the replay has reached.

Two conditions to obey:

- **Register the recording's modules, or leave their recorded paths in place.** Any module
  the recording names and the server does not have is registered from the path recorded for
  it. That file has to still be there. Hand a recording that has travelled to a server with
  those modules already registered.
- **Do not push windows of your own onto a server that is replaying one.** The server takes
  on the window identity the recording stamped, so the replay owns the scene.

## The limit: a replay runs no listeners

A recording holds everything the session sent, the answers its listeners gave included. A
replay re-sends those answers. It does not *run* the listeners.

So the recorded overlay appears, and its toggles and dropdowns are live widgets. Operating
one reaches nobody. Hovering an entity the recorded scene draws produces no tooltip. The
scene plays on unchanged, which looks exactly like a scene that ignores its own controls.

One thing does play back: the **camera track**. A track is an ordinary retained command, so a replay
flies the tour the recorded session declared, and pausing and scrubbing carry the camera with them.
It is the one part of a recorded session that works with no listener behind it. See
[Give a recording a tour](camera-tour.md).

If you want the rest of the session to answer, register listeners against the replaying server
yourself:

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

A listener answering a control event usually pushes a window, and a replay owns the scene.
So a control that re-pushes works only once the replay has finished. A listener that
contributes a tooltip or a float works while the replay runs.

## Play a recording in a web page, with no Julia at all

The viewer ships a second page, `player.html`, that reads a recording instead of connecting
to a server. Everything the Core owns works: the camera, the clock, playback, scrubbing, the
ruler and the furniture. Nothing that needs a server answers, exactly as above.

The scene below is the recording under this page. No Julia process is running.

```@raw html
<iframe src="../viewer/player.html?rec=../recordings/orbit.jsonl&modules=modules"
        title="A recorded CesiumLink session, played in the browser"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

The camera moves on its own: the recorded session declared a **camera track**, and a track
replays like every other retained command. At the bottom left, above the ruler, the
camera-follow item names who is moving the camera. It says **Camera: following the scene**
while the tour has it.

Drag to turn the globe, and the tour stops. Input on the globe takes the camera and keeps it,
so the item changes to **Camera: yours** and offers a **Rejoin** button. Press **Rejoin** to
give the camera back. It flies to the viewpoint that applies **now**, which is where the tour
has reached and not where you left it.

Use the clock at the bottom left to pause and to change speed, and drag the ruler to scrub.
A scrub leaves the clock paused where you dropped it, so press play again to carry on.
This tour is keyed by keyframe, so the camera holds while the scene holds, and it goes back
with the scene when you scrub. The legend and the caption came from the recorded overlay.

Point the page at your own file with query parameters. These four say where files are, which
no recording can know:

| Parameter | Meaning |
|---|---|
| `rec` | URL of the recording. Required. Resolved against the player page. |
| `modules` | Where the built modules are served from. Defaults to `modules`. |
| `assets` | Where the directories the session served were copied to. A mount is `<assets>/<name>/`. |
| `speed` | Scales the recorded pacing. `Infinity` delivers every frame at once. |

The recording states its own scene, so you need none of the rest. They are still read, and
they beat the header — which is how you name a basemap that did not travel with the file:

| Parameter | Meaning |
|---|---|
| `imagery` | Tile URL template, or a TMS pyramid directory. |
| `tiling` | `geographic` or `mercator`, for an XYZ template. |
| `maxlevel` | Deepest level of an XYZ pyramid. |
| `credit` | Attribution text, drawn as text and never as markup. |
| `ellipsoid` | Radii in metres, semi-major first: `1737400,1737400` is the Moon. |

The player reads **version 2 recordings only**, which is every recording this package writes. It
refuses a header stating any other number rather than drawing a partial scene.

Two things decide whether the page shows the scene at once or builds it up:

- [`record!`](@ref) writes whatever the server is retaining at offset zero. A recording
  opened after the scene is pushed therefore starts with the scene already standing.
- A recording of a session that streamed windows over time plays at the pace it was
  recorded. Scrubbing back still works: the player answers a request for keyframes out of
  the recorded windows.

## Next

- [Recording](../reference/recorder.md) for the whole surface.
- [Look at what the wire carried](inspect-the-wire.md) to decode a recorded frame.
