# Why the server decides

Operating a control in the viewer changes nothing in the viewer. The widget reports that the user
operated it, and the server answers with a replacement window whose contents already reflect the
decision. Filtering, selection and derived visibility live in the Julia half, and the viewer renders
what it is given (ADR-0007).

## The argument that settled it

The obvious alternative is a viewer that filters locally: ship a classification per entity, let the
user tick a box, and hide what does not match. It needs a tag encoding, a rule for composing two
filters, and a derived-visibility pass in the viewer.

It fails on one case. Restricting a constellation to the satellites over a region makes cells
genuinely **unserved**, because the traffic they carried had nowhere else to go. No visibility mask
expresses that: the tooltip number, the cell colour and the legend total all change, and only the
simulation produces those values. Once the server recomputes that answer, a local filter for the
easy cases is a second implementation of a decision it cannot make correctly.

Draw calls also scale with what is **sent**, not with what is shown. A hidden polyline still
occupies its vertex buffer, its draw command and its vertex transform, and only its fragments are
skipped. Filtering server-side removes the work; filtering client-side moves it.

## The widget always shows the declared value

A control carries the value the server declared, and the user's input does not change what the
widget shows: the declaration moves it. So a control the server refuses to act on snaps back, and a
toggle that stays put tells the user the truth about what the scene shows.

The rule has one exception. Where the user dragged an adjustable float, a later declaration seeds a
box when it is created and moves no box already on screen. A rect is not scene state, because
nothing is filtered by where a box sits, so a viewer showing one position while the server believes
another misleads nobody. The exception stops a declaration already in flight from snapping the box
back, and that race is a full round trip wide (ADR-0013).

## The clock is not held for the answer

Playback runs on through the round trip, and the scene changes when the replacement window installs
and re-bases the clock on what it delivers. The superseded state stays on screen for the length of
the trip, a few milliseconds on a local host. An earlier design froze the clock on a control event
and resumed on arrival. Only a buffer that does not reach the current instant stops the clock now,
and that hold lifts as soon as a window covers it.

## The listener chain

The Julia side keeps a registry of listeners keyed by `(module, topic)`. A pointer event is
`("core", "pointer")`, with no special case for it. An arriving event runs every listener registered
for that pair, in registration order, over one shared reply.

- **A listener may halt the chain.** What the listeners ahead of it contributed is still sent, so
  halting withholds the listeners behind it and never the answer.
- **A listener that throws is isolated.** It loses its own contribution, the warning carries the
  backtrace, and the listeners behind it still run.
- **The chain couples cheap and expensive listeners.** The batch is assembled after the whole chain
  runs, so one slow listener delays every other contribution to that event. A hover listener must
  not re-derive. The chain does not enforce that.

## One event, one message

Everything the chain contributed travels as a single **command batch**, and the viewer applies it in
the order the chain built it. One reply per listener was rejected: a hover over an entity that three
listeners care about would become three messages applied at three instants, and the tearing shows in
the tooltip and in the overlay.

A batch that answers an event echoes that event's sequence number, and the Core applies every batch
whatever the number says. The **receiving module** drops a stale reply, because a late answer to a
click is often still worth having, a late answer to a hover usually is not, and only the module
knows which it has.

One case is handled in Julia. A listener chain that pushes a `replace` window has its whole batch
dropped, tooltip included: a replace may renumber entities, so the indices the batch carries
describe a scene that no longer exists, and the fresh state is already on its way.

## Where the subscription comes from

The viewer forwards a pointer event upward only when the server has a listener for it, and the
subscription the server pushes is **computed** from the listeners currently registered (ADR-0010).

Two alternatives lost. Forwarding everything makes a hover cost a round trip per pointer move in a
session with no hover listener, to be told that nothing happened. A subscription the author declares
beside the listeners is two statements of one fact, and its failure mode is silent: the event never
arrives, and nothing on either side names the subscription as the reason.

Derivation also composes. Two independent extensions each register the listeners they need, and the
union of their interests is declared without either knowing about the other. A listener that leaves
some modifiers unmentioned is expanded into every modifier set consistent with what it did name,
because a subscription entry can only name a set exactly.

The globe raycast under the cursor is done only when some registered listener asked for the
coordinate, so a session that never asks never pays for it.

## Retained state, and what a reconnecting browser gets

The server holds three things and replays them to a client on `ready`: the module set, the latest
command per `(module, topic)`, and the standing window. So a browser that reloads comes back to the
same scene, with its overlay showing the values the scene was actually filtered with.

Retention holds **one** message per `(module, topic)`, which is why every declaration states its
whole set rather than a patch. A stream of partial patches would replay only its last frame, and the
client would come back to a fragment of an overlay. The overlay list, the subscription, the
furniture set and the float set are all whole statements for this reason. Event history is never
replayed: a declaration-shaped topic restores itself, and an event-shaped topic like a tooltip is
overwritten by the next pointer move.

The window has one wrinkle. **Only a replacing window is replayable.** An `append` extends a window
the joining client never received, and may omit anything that window established. So on an append
the server asks the scene for a replacement covering the same frames and broadcasts that instead;
the clients already watching are re-based on it and ask for what they are then missing, at one round
trip per join. Where no window producer is registered, the retained append is sent as it stands. A
client that receives nothing at all raises no request of its own, and has no way back from silence.

## The three depths of an answer

A server can answer a control event at three depths, in ascending cost.

- **Re-extract.** The simulation result stands, and only which entities are emitted changes. Hiding
  the feeder links is this.
- **Re-derive.** The allocations stand, but the aggregation changes, so derived values genuinely
  differ. Counting only the satellites over Europe is this, and it is what makes cells unserved.
- **Re-simulate.** The run itself is redone.

The click path is defined to reach re-derive and stop, which bounds its latency to array work over
results the server already holds. It costs memory: the server must retain each buffered frame's
simulation output, so buffer depth is bounded by memory as well as by production rate. Re-simulation
is slower again, and it needs a control of its own, so nobody starts a run by ticking a box.

The Julia API is in the [events reference](../reference/events.md), and the message shapes are in
the [protocol](../reference/wire/protocol.md).
