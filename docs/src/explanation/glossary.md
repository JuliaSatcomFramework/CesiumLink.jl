# Glossary

Every term below has one meaning throughout this repository: the Julia source, the JavaScript
source, the wire contracts, the documentation site and the decision records. An `_Avoid_` line names
a word that means something else here, or nothing at all.

This page is the authority on what a word means here. The other explanation pages define the same
terms in prose, at length; this one states each in a sentence and names what to avoid, so that one
thing keeps one name across two languages.

The domain: a Cesium-based 3D globe that draws time-dynamic scenes streamed from a Julia server over
one WebSocket. The browser holds a small payload-opaque Core. Everything that decides what the scene
contains lives in Julia and reaches the Core as composable modules' payloads.

**Core**:
The payload-opaque runtime the browser holds: WebSocket transport, message
envelope, the clock and the window buffer, composition services (module loading,
entity-ID namespacing, pick dispatch, overlay regions), a self-describing array
codec, and static asset serving. It models no entities, interpolates nothing, and
never reads inside a module's payload.
_Avoid_: framework, engine, host (ambiguous).

**Module**:
One ES module, served same-origin, whose default export has a `setup(ctx)`. It is
the unit that renders or contributes to the scene. Modules are declared over the
wire by the server; declaration order is draw order, and a module that
is not declared does not load. Every registration it makes returns a Disposable
the Core drains on unload. The [module API](../reference/wire/module-api.md) is
the normative contract.
_Avoid_: plugin (retired), extension (means a Julia weakdep extension here).

**Vendored module**:
A module shipped inside the core dist rather than from a package's module folder —
today `primitives`, `ui`, `heatmap` and `models`. A module is vendored when its
vocabulary is domain-free: it is told a shape, a value or a colour, and never a
domain concept. It has no privileged loading path: it activates by being declared,
exactly like anyone else's.
_Avoid_: default plugin, builtin.

**Module folder**:
The directory that holds a module's entry file. `register_module!` serves it under
`/modules/<id>/`, so a file beside the entry — a worker, an image — is reachable
same-origin without anybody declaring it. A **vendored module** has one too, inside
the core dist.
_Avoid_: assets folder (that is an **assets mount**, which nothing loads a module from).

**Assets mount**:
A directory the session names, that the server serves under that name, so a payload
can point at a file in it. A payload names the file by its same-origin path, and each
host resolves that path its own way — the VSCode panel gives every mount a URI of its
own — so a module asks the Core to resolve it rather than building the URL itself. The
basemap's tile directory is one of these, under the reserved name `imagery`.
_Avoid_: assets folder (that is a **module folder**), static root, asset directory.

**Glue package**:
The Julia package that authors a module's messages — turning a simulation's own
types into the payloads a module understands. A package that draws its own
constellation through the vendored `primitives` module is one. A glue package that
targets only vendored modules ships no JS, no module folder and no build step.
_Avoid_: vocabulary (that is what a glue package calls), adapter.

**Name**:
Something the scene author gets to call whatever they want: a **control** id, a **float**
id, a module id, a **kind**, an edge's endpoint, a **model family**'s anchor. A name is a
`String` in Julia, because JSON has no symbol and CesiumLink holds no list of the legal
values, so nothing can turn the string that comes back into anything else. A `Symbol`
means the opposite: one choice out of a set CesiumLink itself holds and checks — a
**region**, a pointer type, a window mode, a marker, a line style, a model reference
frame. Every constructor takes either spelling and records a `String`, so `Nodes(:sat;
…)` builds a family whose `kind` is `"sat"` and whose pick reports `"sat"`. Compare an
event against the spelling the declaration used.
_Avoid_: key (that is a routing pair or a `Dict` key), label (that is the text a widget
shows), tag.

**Family**:
One named group of entities that a payload describes as a unit and the renderer draws
as a unit. Its name is its **kind**, and an entity inside it is addressed by index, so
a **kind** and an index are what a pick reports and what one family names as its
**anchor**. A window states each family whole. `primitives` draws three — nodes, edges
and areas — and `models` draws one.
_Avoid_: layer, collection (that is the Cesium primitive a family draws through), group.

**Anchor**:
The entity a module draws something onto, owned by another module. The owner
publishes what an anchored primitive needs as read-only exports — where the entity
is, and the **pick stamp** that says who it is — and the drawer reads them every
frame, because a window may prune the family under it. A primitive that borrows its
anchor's stamp is reported as the anchor, so a click on a sensor cone answers the
satellite and no listener learns the cone exists. A **float** anchors the
same way. Nothing is written back: one owner per entity.
_Avoid_: parent (Cesium's `Entity.parent` carries no transform), attach, owner.

**Model family**:
A **family** drawn as one glTF model per entity, **anchored** to a node family it
names. It is not batched, so it states the camera range it draws in and costs nothing
outside that range. It carries no positions and no colour: where it stands belongs to
its anchor, and what it looks like belongs to the file. It lives in the `models`
module, because `primitives` draws no custom materials.
_Avoid_: entity (that is one item of any family), mesh, asset.

**Payload vocabulary**:
The constructors and types a vendored module's payloads are built from — `Nodes`,
`Edges` and `Areas` for `primitives`; `Models` for `models`; the controls, floats and
the tooltip for `ui`.
It is what a glue package *calls*, not what a glue package *is*. The vocabulary lives
in CesiumLink so every glue package can reach it, one namespace per vendored module
(`CesiumLink.Primitives`, `CesiumLink.UI`).
_Avoid_: glue (that is the caller), schema, DSL.

**Heatmap module**:
The canonical example of a module worth writing: it drapes a full-globe scalar
field as a raster or shader-driven material — appearance the vendored `primitives`
module deliberately excludes. The module itself registers no pointer handler: a
hover reports the cursor's globe coordinate upward, and a Julia listener reads the
value back out of the grid it sent. So the module exercises coordinate-sample
picking rather than entity-ownership picking, and the sampling happens in Julia.

**Basemap**:
The imagery the globe itself is textured with: one layer, declared once per session
by the server, fixed for that session. It is not a module's draped
raster — that is an overlay a module owns, puts up and takes down, and the heatmap
module is the example of one.
_Avoid_: base layer (Cesium's own term, for a thing a picker switches, which this is
not), texture, skin.

**Context object**:
The single options-bag argument the Core passes into a module's `setup`
(`{Cesium, viewer, scene, clock, onWindow, onFrame, pickId, onCommand, notify,
overlay, modules, ...}`). Modules receive every capability this way and never
`import` Cesium themselves — two copies of Cesium cannot share a scene. The whole
surface is in the [module API](../reference/wire/module-api.md).
_Avoid_: handle, API object.

**Envelope**:
The routing wrapper on a module-addressed message: `{module, topic, payload}`. The
Core routes on it without reading the payload.

**Topic**:
The per-module channel name inside the envelope. One handler per topic; a second
registration for the same topic is refused, so a module cannot silently shadow its
own routing.

**Command**:
One module-addressed instruction from the server — an envelope the Core delivers to
that module's topic handler. A command is how the server answers an event: it never
mutates the scene directly, because the scene is what the next window says it is.
_Avoid_: message (too broad), request (there is no reply).

**Command batch**:
The single reply an event produces, holding every command the listener chain
contributed. One event yields one message no matter how many listeners spoke, so
the viewer applies all of them at one instant rather than tearing across several.
A batch answering an event echoes that event's **sequence number**, and the Core
applies the batch whatever that number says. Whether a late answer is still worth
having depends on what it says — a late answer to a click usually is, a late one
to a hover usually is not — so **dropping a stale reply is the receiving module's
policy, never the Core's**. A module that cares compares the number against the
last event it saw.

**Listener chain**:
The server-side registry of handlers keyed by `(module, topic)`, and the run of
them over one arriving event. Listeners run in registration order and each may
contribute commands; one may halt the chain, and one that throws is isolated so
the rest still contribute. The batch is assembled after the chain completes, so a
slow listener delays every other contribution to that event — a hover listener must
not re-derive.

**Subscription**:
What the viewer is told to forward upward, **derived** from the listeners currently
registered rather than declared beside them. An event nobody is waiting for never
leaves the browser, and the subscription cannot drift from the listeners it
describes.

**Control**:
An interactive item in the declared overlay — a toggle, a select, or a widget kind a
module registered. Operating one reports the user's input and changes nothing
locally; the server answers with a replacement window whose contents already
reflect the decision. A widget always shows the *declared* value, so a
control the server refused to apply snaps back.

**Furniture**:
An item the Core puts on screen itself — the timeline ruler, the animation clock,
the keyframe readout, the scene-mode picker, the fullscreen, home and projection
buttons, the navigation help, the inspector, and the camera-follow indicator that
says who holds **camera authority** and offers the way back. It exists in a session that
declares no modules at all, and the server states which pieces are on screen as
one declared set. That is the whole difference from a **Control**: a control
names its own region per item, carries a declared value, reports the user's
input, and needs a module to exist. Furniture divides into the **band**, fixed to
the bottom edge because Cesium builds its ruler as a bottom bar, and the
**group**, which travels whole into one region the declaration names. Some
furniture is a `@cesium/widgets` widget and some is written here; the wire says
nothing about which, and no reader needs to know.
_Avoid_: chrome (that is the `ui` panel's border), widget (that is the `ui`
module's), decoration.

**Float**:
A box of server-authored content at a point on screen rather than in an overlay
region, with an identity of its own, an anchor, and a lifetime the server
controls. Declared as a whole set, like the overlay list: removing one is
declaring the set without it. Its anchor is a screen point, a point on the globe,
or an entity some module owns and can be asked the position of — the last two are
re-projected every frame, so the box rides what it names. A float declared
**adjustable** may additionally be moved and resized by the user, which is the
one thing on screen the user authors rather than the scene.
_Avoid_: pin (that is the route pin), popup, panel.

**Rect override**:
Where the user has put an adjustable float, and how big they made it. It is not
scene state — nothing is filtered by where a box sits — so it belongs to the
person who dragged it: the server records it per float and re-states it in every
later declaration of that set, and a browser reconnecting comes back to the boxes
where they were left. A dragged float becomes screen-anchored and stops following
whatever it named. The override is what the user last did, so a declaration seeds
a box when it is created and cannot move one already on screen; it lasts until a
declaration drops that float.
_Avoid_: geometry (means a Cesium geometry here), layout, position.

**Viewpoint**:
Where the camera stands and which way it looks — a destination, an orientation, and how
long to take getting there. The destination is a point on the globe or a rectangle to
frame; the orientation is heading, pitch and roll in degrees. A viewpoint says nothing
about *when*, which is the **camera track**'s business.
_Avoid_: pose (jargon), view (collides with **Window**), position.

**Camera track**:
The whole ordered set of viewpoints a server has declared, each saying when it applies:
at an absolute keyframe, at a wall-clock offset from the declaration, or on arrival.
Declared as a whole set like the overlay list and the float set — re-declaring replaces
it, an empty list clears it — so a tour of fifty viewpoints is one retained command and
one line of a **recording**. A keyframed entry is applied on the clock crossing, so
pausing holds the camera and scrubbing returns it to the viewpoint that keyframe was
authored with. Only a change of epoch or keyframe step invalidates a track; a
re-indexing **control re-push** does not.
_Avoid_: tour (that is a usage of a track, not a thing the system models), path,
animation.

**Camera authority**:
Who is moving the camera: the viewer or the server. The server holds it at startup, so a
declared **viewpoint** seeds the opening view; the user's first input **on the canvas**
takes the hold, and from then on viewpoints are ignored until they rejoin or one arrives
that explicitly takes it back. Furniture never takes the hold — the canvas is the
camera's surface and a button is not — so pressing home moves the camera and leaves the
server driving. This is the same reasoning that makes a **Rect override** the user's:
nothing is filtered by where the camera stands, so a viewer looking elsewhere than the
server believes misleads nobody.
_Avoid_: following (that is the state's name in what the user reads, not the concept),
camera control, ownership.

**Follow frame**:
What the camera moves relative to: the globe, or a moving thing it holds station on. A
**viewpoint** names the thing to ride with a string the Core never reads — a module
offers a resolver and answers for the names it spells, the way a module publishes a pick
stamp. The frame is independent of **camera authority**: a drag detaches and does not
dismount, so the user steers around the thing and carries on riding it. Only an explicit
release, the home button, and a viewpoint that flies somewhere else clear the frame. The
camera rides from the instant a stop applies and eases onto its seat inside the frame,
so nothing predicts where a satellite will be.
_Avoid_: follow mode (there is no mode), tracking, lock-on, attachment.

**Stop list**:
The **camera track** on screen: one row per viewpoint, in declared order, with the row
that applies now marked. A row reads the viewpoint's label, and one with no label falls
back to the schedule that applies it. A row paced by wall seconds also reads the time
left before it applies. The list is inside the camera-follow indicator, which opens on a
click and is closed when the page opens, so the list appears with the indicator and goes
with it when a declaration turns that off. Every row is a click target: a click puts the
tour at that stop, and it takes the camera back exactly as Rejoin does.
_Avoid_: itinerary, playlist, timeline (collides with the ruler).

**Disposable**:
The teardown handle every Core registration returns — a control, a pointer handler,
a time callback, a topic handler. The Core collects and drains a module's
Disposables on unload, so a module physically cannot leak into shared services.

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
implements it once, as `blockAt`; what the values mean stays with the
module. The [module API](../reference/wire/module-api.md), § Payloads, is its normative
statement.
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
must hold — not the scene, and not the session. One window message carries every
module's payload and installs them together, which is what keeps two modules from
disagreeing about what index `i` addresses. A static scene is a window of one frame.
_Avoid_: batch, chunk, snapshot.

**Streaming advance**:
A window pushed to top up the buffer as playback approaches its end. Nothing the
user asked for changes, so it **must preserve** the previous window's index space;
otherwise entities teleport at a seam nobody requested. Contrast: control re-push.

**Control re-push**:
A window pushed in response to a control event, replacing the buffer. The user
asked for a visible change, so it **may re-index** freely. The buffer's two
operations — append and clear-and-refill — are exactly these two push kinds, so
the identity rule is structural rather than a convention to remember. An
advance that leaves a gap in the buffer clears and refills it too: there is
nothing to interpolate across the gap, so it cannot extend what is held.

**Declared range**:
The full mission timeline the server states up front (epoch, keyframe step, total
count). Finite and known even when the frames are delivered lazily. Distinct from
the **delivered buffer**: the subset of frames the viewer currently holds. The
clock, ruler and scrubbing work against the declared range; interpolation works
against the buffer. Scrubbing to an instant outside the buffer is a window request.

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
globe rather than a state at a time. Every timeless scene is a **static scene**,
but not the reverse: a static scene is the one-frame *shape*, whether or not its
instant means anything, and one that shows a real instant still wants its clock.
So it is a fact about the data that only the author knows, never something the
frame count implies. The server acts on it by declaring no time **furniture** —
there is nothing to play, scrub or name a date for. It travels no other way: the
wire carries the furniture set, not the reason for it.
_Avoid_: hidden timeline (names the effect on one host, not the fact).

**Re-extract / re-derive / re-simulate**:
The three depths at which a server can answer a control event, in ascending cost.
*Re-extract* — the simulation result stands, only which entities are emitted
changes ("hide feeder links"). *Re-derive* — allocations stand but aggregation
changes, so derived values genuinely differ ("only count satellites over Europe",
which makes cells unserved). *Re-simulate* — the run itself is redone. The click
path is defined to reach re-derive and stop; re-simulation, if ever needed, is an
explicit slower path with its own affordance.

**Coordinate-sample**:
The picking modality where a module reports a value sampled at the cursor's globe
coordinate rather than from a picked entity (the heatmap's tooltip). The coordinate
is resolved only when the subscription asked for it. Contrast: entity-ownership
picking.

**Retained state**:
What the server holds and replays to a client on `ready` — the module set, the
latest command per `(module, topic)` (the overlay list and the subscription among
them), and the standing window — so a reconnecting browser comes back to the same
scene, and to the values its scene was actually filtered with. Distinct from event
history, which is never replayed. Only a replacing window is replayable: an append
extends one the joining client never received, so a scene on an append is asked to
rebuild instead.

**Recording**:
The wire frames a server broadcast, written to a file in order, each stamped with how
long into the session it was sent, under a header naming the modules that session
declared. A line holds the frame's header as an inline object and its region as
base64 beside it, so `jq` reads one directly. Replaying one drives a real viewer through the session with whatever
produced the data absent, paced as it was recorded. It holds everything the session
sent, the answers its listeners gave included — but replaying it does not *run* those
listeners, so a control the recorded overlay declares reaches nobody unless one is
registered against the replaying server. The browser plays one on its own as well: the
Core depends only on the `Transport` interface, so a transport that reads the file drives a
real viewer with no server at all. That is what puts a live scene in a documentation page,
and it inherits the same limit.

**Example**:
A whole runnable program that shows what the system is for, and the page that
presents it. One word covers both: the code under `examples/` and
the page it fills.
_Avoid_: demo (that is the recording generator), showcase, sample.
