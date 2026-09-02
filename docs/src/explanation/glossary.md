# Glossary

Every term below has one meaning throughout this repository: the Julia source, the JavaScript
source, the wire contracts, the documentation site and the decision records. An `_Avoid_` line names
a word that means something else here, or nothing at all.

**Core**:
The payload-opaque runtime the browser holds: the transport (each host picks a
concrete one, and a browser page uses a WebSocket), message envelope, the clock and
the window buffer, composition services (module loading, entity-ID namespacing, pick
dispatch, overlay regions), a self-describing array codec, and static asset serving. It
models no entities, interpolates nothing, and never reads inside a module's payload.
_Avoid_: framework, engine, host (ambiguous).

**Module**:
One ES module, served same-origin, whose default export has a `setup(ctx)`. It is the
unit that draws the scene or adds to it. The server declares modules over the wire;
declaration order is draw order, and a module that is not declared does not load. Every
registration it makes returns a Disposable the Core drains on unload, and the
[module API](../reference/wire/module-api.md) is the normative contract.
_Avoid_: plugin (retired), extension (means a Julia weakdep extension here).

**Vendored module**:
A module shipped inside the core dist rather than from a package's module folder —
today `primitives`, `ui`, `heatmap` and `models`. A module is vendored when its
vocabulary is domain-free: it is told a shape, a value or a colour, never a
domain concept. It activates by being declared, like any other module.
_Avoid_: default plugin, builtin.

**Module folder**:
The directory that holds a module's entry file. `register_module!` serves it under
`/modules/<id>/`, so a file beside the entry — a worker, an image — is reachable
same-origin without a declaration. A **vendored module** has one too, inside the core dist.
_Avoid_: assets folder (that is an **assets mount**, which nothing loads a module from).

**Assets mount**:
A directory the session names, that the server serves under that name, so a payload
can point at a file in it. Each host resolves that same-origin path its own way, so a
module asks the Core to resolve it. The basemap's tile directory is one, under the
reserved name `imagery`.
_Avoid_: assets folder (that is a **module folder**), static root, asset directory.

**Glue package**:
The Julia package that authors a module's messages, turning a simulation's own
types into the payloads a module understands. A glue package that targets only
vendored modules ships no JS, no module folder and no build step.
_Avoid_: vocabulary (that is what a glue package calls), adapter.

**Name**:
Something the scene author gets to call whatever they want: a **control** id, a **float**
id, a module id, a **kind**, an edge's endpoint, a **model family**'s anchor. A name is a
`String` in Julia, because CesiumLink holds no list of the legal values; a `Symbol` means
the opposite, one choice out of a set CesiumLink itself holds and checks — a **region**, a
pointer type, a window mode, a marker, a line style, a model reference frame. Every
constructor takes either spelling and records a `String`: `Nodes(:sat; …)` builds a
family whose `kind` is `"sat"` and whose pick reports `"sat"`.
_Avoid_: key (that is a routing pair or a `Dict` key), label (that is the text a widget
shows), tag.

**Family**:
One named group of entities that a payload describes as a unit and the renderer draws
as a unit. Its name is its **kind**, and an entity inside it is addressed by index, so a
pick reports a **kind** and an index. A window states each family whole: `primitives`
draws three of them — nodes, edges and areas — and `models` draws one.
_Avoid_: layer, collection (that is the Cesium primitive a family draws through), group.

**Anchor**:
The entity a module draws something onto, owned by another module. The owner
publishes what an anchored primitive needs as read-only exports — where the entity
is, and the **pick stamp** that says who it is — and the drawer reads them every
frame. A primitive that borrows its anchor's stamp is reported as the anchor, so a
click on a sensor cone answers the satellite. A **float** anchors the same way, and
nothing is written back: one owner per entity.
_Avoid_: parent (Cesium's `Entity.parent` carries no transform), attach, owner.

**Model family**:
A **family** drawn as one glTF model per entity, **anchored** to a node family it
names, and held in the `models` module. It is not batched, so it states the camera
range it draws in and costs nothing outside that range. It carries no positions and
no colour: where it stands belongs to its anchor, and what it looks like belongs to
the file.
_Avoid_: entity (that is one item of any family), mesh, asset.

**Payload vocabulary**:
The constructors and types a module's payloads are built from — `Nodes`, `Edges`
and `Areas` for `primitives`; `Models` for `models`; the controls, floats and the
tooltip for `ui`. A vendored module's vocabulary lives in CesiumLink so every glue
package can reach it, one namespace per vendored module (`CesiumLink.Primitives`,
`CesiumLink.UI`). A module that ships from another package carries its vocabulary
there, beside the module.
_Avoid_: glue (that is the caller), schema, DSL.

**Heatmap module**:
The canonical example of a module worth writing: it drapes a full-globe scalar
field as a raster or shader-driven material, which the vendored `primitives` module
excludes. The module registers no pointer handler: a hover reports the cursor's globe
coordinate upward, and a Julia listener reads the value back out of the grid it sent.
So the module exercises coordinate-sample picking rather than entity-ownership picking.

**Basemap**:
What the globe itself is textured with. The server declares one or more, and the reader
picks which one is on screen. A module's draped raster is a different thing: an overlay
the module puts up and takes down, as the heatmap module does.
_Avoid_: base layer (Cesium's own term for the same thing), texture, skin.

**Basemap set**:
Every basemap one session can wear, declared by the server as an ordered list. Entry 0
is on the globe at startup. Each entry names one body, and every entry names the same
body. A reader who picks another one never sees a globe that disagrees with the
coordinates drawn on it. A set of one draws no picker.
_Avoid_: layer stack, basemap list.

**Basemap backing**:
A second basemap drawn under a declared one, so that a source which returns no tiles
leaves a globe instead of a hole. The backing belongs to one basemap, and the **basemap
set** never holds it as an entry. It carries no transparency, the reader cannot pick it,
and it always sits below. The backing is always the offline pyramid inside the viewer, so
a session on another
body cannot ask for one. Its credit never appears, because the credit line names the
basemap the reader picked.
_Avoid_: backing on its own (the codebase uses the word elsewhere for other things),
fallback layer (the **fallback** is what a basemap that does not build gives you, which
is a different mechanism), underlay, stack.

**Annotation layer**:
Place names and country borders drawn above the **basemap**. It belongs to the session
and not to a basemap, so it survives a pick. The picker takes off the imagery layers it
counted, and an annotation layer is not one of those. The server states each part at
`start_server`, and the reader switches each part from the **furniture**. Both data
files ship inside the viewer, so the layer reaches no network and draws no credit.
_Avoid_: overlay (that is the HTML above the canvas, which carries the credit, the
**furniture** and the **floats**), label layer.

**Named places**:
The oceans, seas, continents, countries, and cities the **annotation layer** writes.
Each one states the band of camera heights that draws it, so a continent stops
competing with the cities inside it. The viewer keeps only what the camera can see,
ranks that, and drops a name whose text box lands on one already kept.
_Avoid_: names (that is a **Name**, which is what the scene author calls a thing),
labels (that is the text a widget shows), place names.

**Country borders**:
The boundary lines between countries the **annotation layer** draws. They arrive as
polylines on the ellipsoid and never as polygon outlines, because Cesium draws no
entity outline on terrain, and never as ground polylines, because those are built
in a worker that can fail for good. The server states them apart from the **named places**, because a
border is a political claim and a reader may want the names without one.
_Avoid_: boundaries (that is the footprint outline an `Areas` value draws, which
belongs to the `primitives` **payload vocabulary**).

**Border style**:
The colour and the width a **basemap** asks the **country borders** to be drawn in.
Each basemap carries its own, because the right colour depends on what lies under
the line, and the viewer restyles the lines on every pick. A basemap that states
neither draws the viewer's default. The width is the width the reader sees zoomed
in, and the viewer thins the line towards the whole-globe view.
_Avoid_: stroke, line style.

**Context object**:
The single options-bag argument the Core passes into a module's `setup`
(`{Cesium, viewer, scene, clock, onWindow, onFrame, pickId, onCommand, notify,
overlay, modules, ...}`). Modules receive every capability this way and never
`import` Cesium themselves, because two copies of Cesium cannot share a scene. The
whole surface is in the [module API](../reference/wire/module-api.md).
_Avoid_: handle, API object.

**Envelope**:
The routing wrapper on a module-addressed message: `{module, topic, payload}`. The
Core routes on it without reading the payload.

**Topic**:
The per-module channel name inside the envelope. One handler per topic; the Core
refuses a second registration for the same topic, so a module cannot silently shadow
its own routing.

**Command**:
One module-addressed instruction from the server — an envelope the Core delivers to
that module's topic handler. A command is how the server answers an event. It never
mutates the scene directly, because the scene is what the next window says it is.
_Avoid_: message (too broad), request (there is no reply).

**Command batch**:
The single reply an event produces, holding every command the listener chain
contributed. One event yields one message however many listeners spoke, so the viewer
applies all of them at one instant. A batch echoes the **sequence number** of the event
it answers, and the Core applies the batch whatever that number says: **dropping a stale
reply is the receiving module's policy, never the Core's**.

**Listener chain**:
The server-side registry of handlers keyed by `(module, topic)`, and the run of
them over one arriving event. Listeners run in registration order and each may
contribute commands; one may halt the chain, and one that throws is isolated so
the rest still contribute. The server assembles the batch after the chain completes, so
a slow listener delays every other contribution to that event. A hover listener must
not re-derive.

**Subscription**:
What the viewer is told to forward upward, **derived** from the listeners currently
registered rather than declared beside them. An event nobody waits for never
leaves the browser, and the subscription cannot drift from the listeners it
describes.

**Control**:
An interactive item in the declared overlay — a toggle, a select, or a widget kind a
module registered. Operating one reports the user's input and changes nothing
locally; the server answers with a replacement window. A widget always shows the
*declared* value, so a control the server refused to apply snaps back.

**Furniture**:
An item the Core puts on screen itself — the timeline ruler, the animation clock,
the keyframe readout, the scene-mode picker, the fullscreen, home and projection
buttons, the navigation help, the inspector, the **canvas capture** button, and
the camera-follow indicator that says who holds **camera authority**. It exists
in a session that declares no modules at all, and the server states which pieces
are on screen as one declared set. A **Control** differs: it names its own region
per item, carries a declared value, reports the user's input, and needs a module
to exist. Furniture divides into the **band**, fixed to the bottom edge because
Cesium builds its ruler as a bottom bar, and the **group**, which travels whole
into one region the declaration names. _Avoid_: chrome (that is the `ui` panel's
border), widget (that is the `ui` module's), decoration.

**Float**:
A box of server-authored content at a point on screen rather than in an overlay
region, with an identity of its own, an anchor, and a lifetime the server
controls. The server declares the whole set, like the overlay list: to remove one,
declare the set without it. Its anchor is a screen point, a point on the globe,
or an entity some module owns and can be asked the position of; the last two are
re-projected every frame, so the box rides what it names. A float declared
**adjustable** may also be moved and resized by the user.
_Avoid_: pin (that is the route pin), popup, panel.

**Rect override**:
Where the user has put an adjustable float, and how big they made it. It belongs to
the person who dragged it: the server records it per float and re-states it in every
later declaration of that set, so a reconnecting browser comes back to the boxes
where they were left. A dragged float becomes screen-anchored and stops following
whatever it named. A declaration seeds a box when it creates it and cannot move one
already on screen; the override lasts until a declaration drops that float.
_Avoid_: geometry (means a Cesium geometry here), layout, position.

**Viewpoint**:
Where the camera stands and which way it looks: a destination, an orientation, and how
long to take getting there. The destination is a point on the globe or a rectangle to
frame; the orientation is heading, pitch and roll in degrees. A viewpoint says nothing
about *when*, which is the **camera track**'s business.
_Avoid_: pose (jargon), view (collides with **Window**), position.

**Camera track**:
The whole ordered set of viewpoints the server declared, each saying when it applies:
at an absolute keyframe, at a wall-clock offset from the declaration, or on arrival.
The server declares it as a whole set, like the overlay list and the float set:
re-declaring replaces it, and an empty list clears it. The viewer applies a keyframed
entry on the clock crossing, so pausing holds the camera and scrubbing returns it. Only
a change of epoch or keyframe step invalidates a track; a re-indexing **control re-push**
does not.
_Avoid_: tour (that is a usage of a track, not a thing the system models), path,
animation.

**Camera authority**:
Who is moving the camera: the viewer or the server. The server holds it at startup, so a
declared **viewpoint** seeds the opening view. The user's first input **on the canvas**
takes the hold, and viewpoints are then ignored until the user rejoins or one arrives
that explicitly takes it back. Furniture never takes the hold, so pressing home moves the
camera and leaves the server driving.
_Avoid_: following (that is the state's name in what the user reads, not the concept),
camera control, ownership.

**Follow frame**:
What the camera moves relative to: the globe, or a moving thing it holds station on. A
**viewpoint** names the thing to ride with a string the Core never reads; a module
offers a resolver and answers for the names it spells. The frame is independent of
**camera authority**: a drag detaches and does not dismount, so the user steers around
the thing and carries on riding it. Only an explicit release, the home button, and a
viewpoint that flies somewhere else clear the frame.
_Avoid_: follow mode (there is no mode), tracking, lock-on, attachment.

**Stop list**:
The **camera track** on screen: one row per viewpoint, in declared order, with the row
that applies now marked. A row reads the viewpoint's label, or the schedule that applies
it when there is no label, and a row paced by wall seconds also reads the time left. The
list is inside the camera-follow indicator, which opens on a click and is closed when the
page opens. Every row is a click target: a click puts the tour at that stop and takes the
camera back exactly as Rejoin does.
_Avoid_: itinerary, playlist, timeline (collides with the ruler).

**Disposable**:
The teardown handle every Core registration returns — a control, a pointer handler,
a time callback, a topic handler. The Core collects and drains a module's
Disposables on unload, so a module cannot leak into shared services.

**Wire**:
The transport encoding between the Julia server and the Core, versioned separately
from the module API. The [wire protocol](../reference/wire/protocol.md) is its normative
reference.
_Avoid_: protocol (overloaded), format.

**Frame**:
What one WebSocket message carries: a `u32` length, the JSON header, a pad to the
next multiple of 8, and the region. The header is the whole message; the region is
the array bytes behind it. The [wire protocol](../reference/wire/protocol.md) states the layout.
_Avoid_: packet, envelope.

**Region**:
The block of raw array bytes behind a frame's header. Every encoded array in the
header names an offset into it, always a multiple of 8, and the browser reads each
array as a view rather than a copy. A message with no arrays has an empty region.
_Avoid_: blob, buffer (a typed array's own `.buffer` is a different thing).

**Encoded array**:
A self-describing triple — marker, shape, offset — that carries a Julia array as a
typed array and back. The codec finds it wherever it appears in a payload, at any
nesting depth, so neither side agrees in advance on where arrays live. It is the
one thing the Core understands inside an otherwise opaque payload.

**Base rank**:
The rank of the form a module expects one encoded array to arrive in — 1 for a value
per entity, 3 for an `[H, W, 4]` raster. An array at or below it holds one value for
the whole window; an array one rank above it carries a leading keyframe axis, so
keyframe `k` reads the contiguous block at `k × block`. The Core owns that rule and
implements it once, as `blockAt`. The [module API](../reference/wire/module-api.md),
§ Payloads, is its normative statement.
_Avoid_: dimension, order, arity.

**Keyframe**:
One time-stamped scene state in a buffered sequence the Core plays back locally
against its clock. Indices are **absolute within the declared range**; a module maps
them to its own arrays through its window's start frame.
_Avoid_: frame (ambiguous with render frame).

**Window**:
A contiguous run of keyframes pushed together, carrying its own **index space**:
index `i` addresses the same object in every frame of that window. Interpolation
never compares across windows, so a window is the unit within which entity identity
must hold. One window message carries every module's payload and installs them
together, which keeps two modules from disagreeing about what index `i` addresses.
A static scene is a window of one frame.
_Avoid_: batch, chunk, snapshot.

**Streaming advance**:
A window pushed to top up the buffer as playback approaches its end. Nothing the
user asked for changes, so it **must preserve** the previous window's index space;
otherwise entities teleport at a seam nobody requested. Contrast: control re-push.

**Control re-push**:
A window pushed in response to a control event, replacing the buffer. The user
asked for a visible change, so it **may re-index** freely. An advance that leaves a
gap in the buffer clears and refills it too: there is nothing to interpolate across
the gap, so it cannot extend what is held.

**Declared range**:
The full mission timeline the server states up front (epoch, keyframe step, total
count). It is finite and known even when the frames are delivered lazily. The clock,
ruler and scrubbing work against the declared range; interpolation works against the
**delivered buffer**.

**Delivered buffer**:
The subset of the **declared range**'s keyframes the viewer currently holds.
Interpolation works against it. Scrubbing to an instant outside it is a window
request, not an error.
_Avoid_: cache, loaded frames.

**Static scene**:
A scene of one keyframe. It is a shape rather than a claim about meaning, so a
static scene whose one frame shows a real instant still wants its clock. Contrast:
**timeless scene**, which is the claim.

**Timeless scene**:
A scene whose one keyframe is not tied to an instant — a statistic drawn on the
globe rather than a state at a time. Every timeless scene is a **static scene**, and
only the author knows the fact: the frame count never implies it. The server acts on
it by declaring no time **furniture**, and it travels no other way, because the wire
carries the furniture set and not the reason for it.
_Avoid_: hidden timeline (names the effect on one host, not the fact).

**Re-extract / re-derive / re-simulate**:
The three depths at which a server can answer a control event, in ascending cost.
*Re-extract* — the simulation result stands, only which entities are emitted
changes ("hide feeder links"). *Re-derive* — allocations stand but aggregation
changes, so derived values genuinely differ ("only count satellites over Europe").
*Re-simulate* — the run itself is redone. The click path is defined to reach re-derive
and stop. Re-simulation is slower again and needs a control of its own.

**Coordinate-sample**:
The picking modality where a module reports a value sampled at the cursor's globe
coordinate rather than from a picked entity (the heatmap's tooltip). The coordinate
is resolved only when the subscription asked for it. Contrast: entity-ownership
picking.

**Retained state**:
What the server holds and replays to a client on `ready` — the module set, the
latest command per `(module, topic)` (the overlay list and the subscription among
them), and the standing window. A reconnecting browser comes back to the same
scene, and to the values its scene was filtered with; event history is never
replayed. Only a replacing window is replayable: an append extends a window the
joining client never received, so a scene on an append is asked to rebuild instead.
It is also what a client gets after frames were dropped for it — see **send queue**.

**Send queue**:
The bounded queue of frames the server holds for one client, drained by the task that
serialises that client's writes. A client that stops reading fills its own queue and
holds up nothing else, neither another client nor a request for a module file. A full
queue drops the frame, counts it, and tells that client with a `core/dropped` command;
the client answers by asking for the retained state again with a `core/replay` event
(ADR-0030).
_Avoid_: buffer, which is the viewer's delivered buffer.

**Recording**:
The wire frames a server broadcast, written to a file in order, each stamped with how
long into the session it was sent, under a header naming the modules that session
declared. Replaying one drives a real viewer through the session, paced as it was
recorded, with whatever produced the data absent. A replay does not run the
listeners, so a control the recorded overlay declares reaches nobody unless a
listener is registered against the replaying server. The browser plays one on its
own as well: the Core depends only on the `Transport` interface, so a transport that
reads the file drives a real viewer with no server, and that puts a live scene in a
documentation page.

**Canvas capture**:
One PNG of the viewer's canvas as it stands. The **furniture**, the overlay and the
**floats** are HTML above the canvas, so a capture never holds them. A capture shows
the globe and everything the modules drew on it. A `scale` multiplies the drawing
buffer, so a capture at scale 2 holds four times the pixels of the same framing.
Julia asks for one and saves the file, and the `canvasCapture` furniture item copies
one to the clipboard or downloads it. The clipboard needs a real click, so only the
button reaches it.
_Avoid_: screenshot (the timeline and the buttons are never in one), snapshot
(**Window** refuses that word), image.

**Example**:
A whole runnable program that shows what the system is for, and the page that
presents it. One word covers both: the code under `examples/` and
the page it fills.
_Avoid_: demo (that is the recording generator), showcase, sample.
