# Why the server decides

Operating a control in the viewer changes nothing in the viewer. The widget reports that the user
operated it, and the server answers with a replacement window whose contents already reflect the
decision. Filtering, selection and derived visibility live in the Julia half, and the viewer renders
what it is given (ADR-0007).

This is the decision that most of the rest of the system follows from, so it is worth stating what
drove it.

## The argument that settled it

The obvious alternative is a viewer that filters locally. Ship a classification per entity, let the
user tick a box, and hide what does not match. It needs a tag encoding, a rule for composing two
filters, and a derived-visibility pass in the viewer.

It fails on one case. Restricting a constellation to the satellites over a region does not merely
hide the others: it makes cells genuinely **unserved**, because the traffic they carried had nowhere
else to go. No visibility mask expresses that. The number in the tooltip, the colour of the cell and
the total in the legend are all different from what they were. Every one of them is a value only the
simulation can produce.

Once the server has to recompute the answer for that case, a local filter for the easy cases is a
second implementation of a decision it cannot make correctly. So there is one implementation, and it
is in Julia.

A second argument reinforces it. Draw calls scale with what is **sent**, not with what is shown. A
hidden polyline still occupies its vertex buffer, its draw command and its vertex transform, and
only its fragments are skipped. Filtering server-side removes the work; filtering client-side moves
it.

## The widget always shows the declared value

A control carries the value the server declared, and the user's input does not change what the
widget displays. The declaration is what moves it. So a control the server refuses to act on snaps
back, which is correct rather than unfortunate. The panel is never ahead of the scene, and a user
who sees a toggle stay put has been told the truth about what the scene shows.

That rule has exactly one exception, and it is deliberate. Where the user has dragged an adjustable
float, a later declaration seeds a box when it is created and moves no box already on screen. A
rect is not scene state — nothing is filtered by where a box sits — so a viewer showing one position
while the server believes another misleads nobody. What the exception buys is that a declaration
already in flight when the pointer came up cannot snap the box back, and that race is a full round
trip wide (ADR-0013).

## The clock is not held for the answer

An early version of this decision froze the clock on a control event and resumed when the
replacement arrived, so that the viewer never rendered state it knew to be superseded. That is not
what the code does now. Playback runs on through the round trip, and the scene changes when the
replacement window installs and re-bases the clock on what it delivers. So the superseded state does
stay on screen for the length of the trip, which on a local host is a few milliseconds. The only
thing that stops the clock is a buffer that does not reach the current instant, and that hold lifts
as soon as a window covers it.

## The listener chain

The Julia side keeps a registry of listeners keyed by `(module, topic)`. A pointer event is just
`("core", "pointer")`, with no special case for it. An arriving event runs every listener registered
for that pair, in registration order, over one shared reply.

Three properties of the chain matter.

- **A listener may halt the chain.** What the listeners ahead of it contributed is still in the
  reply and is still sent. Halting withholds the listeners behind it, and never the answer.
- **A listener that throws is isolated.** It loses its own contribution, the warning carries the
  backtrace, and the listeners behind it still run. One broken extension must not take the rest
  down.
- **The chain couples cheap and expensive listeners.** The batch is assembled after the whole chain
  has run, so one slow listener delays every other contribution to that event. A hover listener must
  not re-derive. That is a contract rather than something the chain enforces.

## One event, one message

Everything the chain contributed travels as a single **command batch**, applied by the viewer in the
order the chain built it. One reply per listener was considered and rejected. A hover over an entity
that three listeners care about would become three messages, applied at three different instants,
and the tearing shows in the tooltip and in the overlay.

A batch that answers an event echoes that event's sequence number. The Core applies every batch,
whatever the number says. A stale reply is dropped by the **receiving module**, and never by the
Core. A late answer to a click is often still worth having, a late answer to a hover usually is not,
and only the module that holds one knows which it has.

One case is handled in Julia rather than left to a module. A listener chain that pushes a `replace`
window has its whole batch dropped, tooltip included. A replace may renumber entities, so the
indices the batch carries describe a scene that no longer exists, and the fresh state is already on
its way.

## Where the subscription comes from

The viewer forwards a pointer event upward only when the server has a listener for it, and the
subscription the server pushes is **computed** from the listeners currently registered
(ADR-0010).

Two alternatives lost. Forwarding everything makes a hover cost a round trip per pointer move in a
session with no hover listener, to be told that nothing happened. A subscription the author declares
beside the listeners is two statements of one fact, and its failure mode is silent. The event simply
never arrives, and nothing on either side suggests that the subscription was the reason.

Derivation also composes. Two independent extensions each register the listeners they need, and the
union of their interests is declared without either knowing about the other. A listener that leaves
some modifiers unmentioned is expanded into every modifier set consistent with what it did name,
because a subscription entry can only name a set exactly.

One flag on the subscription is worth naming. The globe raycast under the cursor is done only when
some registered listener asked for the coordinate. A session that never asks never pays for the
ray-globe intersection.

## Retained state, and what a reconnecting browser gets

The server holds three things and replays them to a client on `ready`: the module set, the latest
command per `(module, topic)`, and the standing window. So a browser that reloads comes back to the
same scene, with its overlay showing the values the scene was actually filtered with.

Retention holds **one** message per `(module, topic)`. That single sentence is why every declaration
states its whole set rather than a patch. A stream of partial patches would replay only its last
frame to a client that reconnects, and the client would come back to a fragment of an overlay. The
overlay list, the subscription, the furniture set and the float set are all whole statements for
this reason.

Event history is never replayed, and the distinction is clean: a declaration-shaped topic restores
itself, and an event-shaped topic like a tooltip is harmless to replay because the next pointer move
overwrites it.

The window has one wrinkle. **Only a replacing window is replayable.** An `append` extends a window
the joining client never received, and may omit anything that window established. So when the scene
is on an append, the server asks the scene for a replacement covering the same frames and broadcasts
that instead. The clients already watching are re-based on it and ask for what they are then
missing, which costs one round trip per join. Where nothing can answer, because no window producer
is registered, the retained append is sent as it stands. A client that receives nothing at all
raises no request of its own, and has no way back from silence.

## The three depths of an answer

A server can answer a control event at three depths, in ascending cost.

- **Re-extract.** The simulation result stands, and only which entities are emitted changes. Hiding
  the feeder links is this.
- **Re-derive.** The allocations stand, but the aggregation changes, so derived values genuinely
  differ. Counting only the satellites over Europe is this, and it is what makes cells unserved.
- **Re-simulate.** The run itself is redone.

The click path is defined to reach re-derive and stop. That bounds its latency to array work over
results the server already holds, which is what makes a control feel like a control rather than like
a job. It also has a cost worth knowing: the server must retain each buffered frame's simulation
output, so buffer depth is bounded by memory as well as by production rate.

Re-simulation is not forbidden. It is an explicitly slower path with an affordance of its own, so
that nobody reaches it by ticking a box.

The Julia API behind all of this is in the [events reference](../reference/events.md), and the
message shapes are in the [protocol](../reference/wire/protocol.md).
