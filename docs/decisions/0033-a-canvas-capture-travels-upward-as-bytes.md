---
status: accepted
---

# A canvas capture travels upward as bytes, and Julia waits for it

Two rules stood until now. Nothing travels upward as bytes, because ADR-0007 makes the server
authoritative and bulk data going the other way inverts that. And a command has no reply, because
ADR-0010 answers an event with a command batch and correlates the two by sequence number alone.

A **canvas capture** breaks both. The picture exists only in the browser, and only Julia can write
a file where the caller wants it.

## Decision

**A capture travels as an encoded array in the frame's region.** A PNG is a byte string, so it
rides the `u8` tag the codec already carries (ADR-0016). Nothing about the format changes. The
region already reaches Julia: `handle_msg` unpacks an arriving frame the same way it packs a
leaving one, and `decode_arrays` reads a `u8` array out of it at any depth. So the Julia half of
this ADR is a rule, not code.

This does not invert ADR-0007. A capture is not scene state. The server does not filter by it, no
module reads it, and the next window says nothing about it. It is a picture of what the viewer
already drew from what the server already sent. The authority runs one way still.

`refuseArrays` stays as it is. It refuses a value that holds a typed `data` field, which is a
*decoded* array. An encoded array carries `$wire`, `shape` and `off`, so it passes untouched. A
module that puts a typed array in an event payload still gets the error it got before.

**Julia asks and waits.** `capture_canvas(server, path)` sends a `core/capture` command carrying a
request token, then blocks on a channel keyed by that token until a `core/capture` event arrives
with the picture. It throws when nothing arrives in time.

This is the first request and reply in the protocol, and it stays the only one. The rule that keeps
it from spreading: a round trip is allowed when the server asks for something that exists **only**
in the browser and that no window can state. A picture qualifies. Scene state never does.

**The server broadcasts, and the first picture wins.** A `Client` has no id, and giving it one would
add a public noun to the API for a case that is rare. Every connected viewer therefore renders and
answers, and the server keeps the first picture for that token and drops the rest.

A refusal never wins over a picture. A viewer that cannot draw answers sooner than a viewer that
can, because it returns before the resize, the render and the encode. So the server reads answers
until one carries a picture, until every viewer refused, or until the clock runs out.

When two viewers both draw, both answers are valid pictures and the server keeps whichever arrived
first. The camera belongs to the user (ADR-0017), so the two can show different views of the scene,
and nothing says which of them the caller receives. That is the cost of leaving a `Client` without
an id.

## Alternatives declined

**An HTTP POST from the browser.** The viewer posts the PNG to a route on the same server, and the
wire never changes. Declined: `serve_static` answers GET only, so it needs a route, a token scheme
against a stranger writing files, and it still leaves every host that reaches its page by another
route with no way to answer.

**Base64 in the event payload.** No encoder, no region, one JSON string. Declined: the codec exists
for exactly this, carries `u8` already, and decodes on arrival. Spending a third more bytes to
avoid fifteen lines reinvents what is there.

**Fire and forget, with a listener.** `request_capture!(server)` and the caller registers a
listener on `core/capture`. It stays inside ADR-0010 and needs no round trip. Declined: nobody
can then write a script that saves one picture per keyframe, and every caller rebuilds the same
waiting.
The point of the server-side save is the script.

**Naming a viewer.** Give a `Client` an id and let the caller pick. Declined for now: it is the
right answer when two viewers show different scenes, and it costs a public noun that nobody with
one browser open wants to learn. The first-answer rule can become a default later.

## Consequences

The upward half of the wire now has an encoder, so a later feature that must send bytes up writes
no new contract. The symmetry the protocol was specified with is now used, not only stated.

`capture_canvas` blocks the task that calls it. It must not run inside an event listener: a
listener holds the chain, and the chain must complete before the server sends the batch, so a
capture inside one deadlocks against its own answer.

A recording holds no capture. `record!` writes the frames the server broadcast, and a capture
arrives on an event, which no recording ever held.
