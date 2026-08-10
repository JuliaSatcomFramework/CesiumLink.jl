---
status: accepted
---

# The camera is user state the server may drive

Nothing in this codebase has ever addressed the camera. There is no `setView`, no initial
destination, no camera command and no camera event. What the viewer looks at is Cesium's
default view, the user's mouse, and Cesium's own `HomeButton`.

Two wants change that. A documentation page that plays a recording should be able to give
a tour rather than leave a globe sitting still. A listener should be able to answer a click
by flying to what was clicked. Both need the server to move a camera the user is also
holding, and ADR-0007 gives no guidance here: it makes the server authoritative over the
**scene**, and the camera is not part of the scene.

## Decision

**The camera is user state.** The test ADR-0013 applies to a float's rect applies here
unchanged: nothing is filtered by where the camera stands. Two people watching one session
from different angles see the same scene, where two people holding different control values
do not. So the camera belongs to whoever is looking through it, and a viewpoint the server
sends is an offer rather than an instruction.

**One bit, called camera authority.** The viewer holds the camera or the server does.

| Event | Effect on the hold |
|---|---|
| Startup | The server holds it |
| A viewpoint arrives | Applied only while the server holds it |
| A viewpoint carries `take` | The server takes the hold, then applies |
| Canvas input — drag or wheel | The viewer takes the hold; any flight in progress is cancelled |
| Furniture — home, scene mode, projection | No effect on the hold |
| Rejoin | The server takes the hold and flies to the track's current viewpoint |
| A stop clicked in the stop list | The server takes the hold and flies to that stop |

**Clicking a stop is the general case of Rejoin.** Rejoin is the click on the stop that
applies now, so a click on any other row asks for the same thing about a different stop.
It adds no state and no second rule: the row that a click makes current is the row Rejoin
would already have flown to. Without it, a click while the viewer holds the camera does
nothing at all, which reads as a broken button. Both fly in the fixed rejoin time rather
than the entry's own `duration`, because a duration paces a tour and navigating is not
touring.

**The server holds the camera at startup.** A viewpoint sent before anyone has touched
anything has to land, or a tour is dead before it begins. This is the same reasoning that
lets a declared rect seed a float that does not yet exist: Cesium's default view is a
placeholder nobody chose, so there is nothing to protect.

**The canvas is the camera's surface; furniture is chrome.** Dragging the globe means the
user is driving and takes the hold. Pressing a button asks the viewer to do something and
does not. So `home` moves the camera without detaching, and the track reclaims it at the
next viewpoint. A user who wants both drags first and then presses home, which composes;
a home that detached could not be decomposed the other way.

A key press is not camera input either. Cesium binds no key to the camera, so a key struck
over the globe belongs to whatever module bound it, and a module that reads keys would take
the camera from the server every time the user pressed one.

**Detachment is sticky.** Nothing re-attaches except Rejoin or a viewpoint carrying `take`.
A track's later entries never quietly reclaim a camera the user has taken.

**One topic, one declared set.** `core/camera` carries a whole **camera track**, replaced
wholesale, cleared by an empty list, and retained like the overlay list and the furniture
set. A single immediate viewpoint is a track of one entry. Retention then does something
useful without being designed for it: a browser that reconnects is flown back to what it
was last shown.

## Alternatives declined

**Scene state, authoritative like everything else.** One rule for the whole viewer, and
ADR-0007 would extend without an exception. It gives the wrong behaviour in the case the
feature exists for: a reader who turns the globe to look at something during a tour would
be dragged back at the next viewpoint, with no way to opt out short of the author never
sending one.

**Two bits — following and authority kept apart.** Four states instead of two, and three
verbs (`viewpoint`, `goto`, `attach`) instead of two. Only one of the four states is real
and unreachable under one bit: the server flew you somewhere and a running track must not
pull you off it. That needs a live session holding both a track and a camera-moving
listener at once. Today a track lives in the recording player, which has no server, and a
camera-moving listener lives in a live session, which has no track. The second bit is
purely additive when they meet.

**Discriminating a directive from an offer by the sequence number.** A batch answering an
event carries one and an unsolicited push does not, so "answers something the user did"
was available for free. It fails on a "play tour" button: the first viewpoint answers that
control event and is honoured, and every viewpoint after it is unsolicited and ignored,
because nothing ever attached. The feature would fail in the case it exists for and the
reason would be invisible in the payload.

**Home detaching.** Home and Rejoin are siblings — both put the camera at a known view,
one Cesium's and one the server's — so wanting Cesium's reads as wanting to leave. Declined
because it is the one detach a user cannot undo except by rejoining, and because drag-then-home
already expresses it.

**A separate topic for an immediate viewpoint.** It would stop click-to-focus overwriting a
running track. It costs a second retention key and a race between two declarations on
reconnect, to protect a combination that does not yet occur.

## Consequences

The furniture set gains `cameraFollow`, default on, hidden until the first viewpoint
arrives. It governs display only; authority is behaviour and runs whether or not the
indicator is on screen. A session that never sends a viewpoint never renders it, so no
author has to think about it.

Click-to-focus re-declares the track and therefore wipes a running tour. **When one live
session grows both a track and a camera-moving listener, split the authority bit in two and
split `core/camera` into two topics.** Until then this is documented behaviour.

A recording carries a tour with no change to the recording format, because a track is an
ordinary retained command. A whole tour is one line in the file.

Recording the operator's own camera is deliberately not built. It would need a `core/camera`
event travelling upward and a recorder that writes it, and it captures drags where authoring
in Julia produces a better tour for less work. Cutting it is what keeps a recording a plain
log of what the server broadcast.

Nothing in `docs/src/reference/wire/module-api.md` changes. A module gains no camera capability and
cannot move the camera; the Core owns it, as it owns the clock.
