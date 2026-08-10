---
status: accepted
---

# A riding camera holds a reference frame

A viewer watches a satellite from the satellite, and sees its coverage sweep the ground below it. The
camera holds station on a moving thing instead of a point on the globe.

Two ways in ask for it. A user clicks a satellite, and a server listener answers by putting the
camera on it. Or a declared **camera track** has a stop that rides a satellite instead of standing at
a point.

The obvious shape is a third state. The camera already has one bit — the viewer holds it, or the
server does (ADR-0017) — and "the camera is riding something" reads like a third value of that bit.
It is not. A viewer can ride a satellite while the server drives, and a viewer can ride a satellite
while holding the camera. Both are useful, and a single bit with three values can say only one of
them at a time.

## Decision

**Riding is a reference frame, and the frame is independent of who holds the camera.**

ADR-0017's bit says whether an arriving viewpoint applies. The frame says what the camera moves
relative to. Nothing joins the bit, and the bit keeps one meaning.

**A drag detaches, and does not dismount.** Canvas input takes the hold, so the tour stops advancing
and later viewpoints are ignored. The frame stays. A person who grabs the view to look sideways off a
spacecraft is still on the spacecraft, and the alternative throws that person back to the globe for
looking around.

The frame clears on three things, and a drag is not one of them: an explicit release, the `home`
button, and a stop that flies somewhere else. A flight must clear the frame before it starts, or
Cesium computes the flight inside the moving frame.

**The Core never reads the target string.** `kind` and `idx` are the `primitives` vocabulary, and a
`core/camera` payload carrying them would teach the Core one module's schema — which ADR-0006
refuses. A viewpoint carries `follow: "sat[7]"`. A module offers a resolver through `ctx.anchors`,
and the Core asks whoever answers for a position getter. The Core holds a string and a callback.

This is the seam ADR-0023 already uses for picking: the module publishes, the peer borrows, the Core
stays opaque. It is that seam used a second time, not a new idea. A module that draws entities gains
one registration and answers for names it knows; a name nothing answers for leaves the camera where
it stands.

## The camera rides first, and closes on the seat afterwards

`Camera.flyTo` is aimed once, and a low satellite crosses about nine degrees of longitude a second.
A four second flight to where the satellite stood at departure lands most of a continent away, and
the camera then snaps onto the thing it was sent to. Predicting the arrival better only makes the
error smaller.

So the frame goes on before anything else. From the instant a stop applies the camera is riding, and
heading, pitch and range then ease to the seat the stop asked for **inside** that frame. Every step
is relative to the thing being ridden, and there is nothing left to land beside. A duration can be
authored freely at any anchor speed.

This is why nothing predicts where an anchor will be. The resolver answers where the thing is now,
once per rendered frame, and that is the whole seam.

## Getting off stands the camera over the ground

Converting to world coordinates and keeping the pose is the smallest possible release, and it leaves
a reader hanging two thousand kilometres up, tilted, aimed at a thing already leaving.

A deliberate release flies to the nadir view above the anchor — north up, straight down, at the
height the camera had when it got on. It is the one attitude that needs no explaining after a ride.
Only the deliberate release flies: `home` is already flying when the release is noticed and a second
flight would fight it, an anchor that stops answering leaves no ground to stand over, and a stop that
flies elsewhere has its own destination.

## Alternatives declined

**A third authority state.** One enum, no new concept, and every existing reader of the bit keeps
working. It also cannot say "the user holds the camera and is riding a satellite", which is the state
a drag produces and the state this decision exists to keep.

**A `follow` command topic on `primitives`.** The module owns the entities, so it could own the
riding too. That is two mechanisms for one behaviour: a tour would ride through the camera track and
a click would ride through a second topic, and the two would drift. With `follow` on a viewpoint, a
listener answering a click sends a one-entry track with no schedule — the same message a tour uses.

**A registry of anchors in the Core.** The Core could hold `kind`/`idx` and ask a module to resolve
the pair. It teaches the Core one module's schema for no gain over an opaque string, and ADR-0006
already refused the general form of it.

## Consequences

A ride is broadcast and never retained. The server retains one command per topic, so retaining a
ride would drop the camera track that a later client is replayed — the track this mechanism exists
to leave alone. A ride is about one viewer's camera, and replaying one seats a stranger on something
somebody else clicked. A ride that every viewer is meant to take is a stop in the declared track.

The target string is the module's own spelling, so a module that owns entities decides how they are
named. `primitives` spells one `kind[idx]` and **counts the index from 1**, because the author who
writes the string is the author who read `ev.entity.idx` off a pointer event. Every other accessor in
that module counts from 0. The two bases meet at the resolver and nowhere else.

A recording carries a ridden tour, because a camera track is a retained command and the module that
answers for the target is in the recording too. A ride declared from a listener is not in a
recording, because nothing retained it.
