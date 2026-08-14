---
status: accepted
---

# A client holds a send queue, and an overflow is told

`broadcast_all!` used to send to every client while holding `clients_lock`:

```julia
lock(server.clients_lock) do
    record && record_frame!(server, msg)
    for ws in collect(server.clients)
        try; HTTP.WebSockets.send(ws, bytes); catch; delete!(server.clients, ws); end
    end
end
```

A client that stops reading does not throw. It fills its TCP window, the send blocks, and the lock
stands for as long as that takes. `mount_for` (`src/static.jl`) takes the same lock to read the
module set, so every `/modules/<id>/<rest>` request queues behind the slowest subscriber: open a
second viewer on a running scene while the first one is stalled, and the second page's module fetches
wait on the first page's socket. An open recording is on the same lock, so a slow disk lands there
too.

The lock is not simply wrong. `collect(server.clients)` already copies the set, so the lock is not
there for the iteration — it serialises the writes. A send is not atomic across tasks, so two tasks
broadcasting at once can interleave their frames on one connection. Removing the lock without
replacing that guarantee produces a viewer that decodes half a window.

A second client kind decides the shape of the replacement. A host that draws the scene inside a
notebook cell reaches its page over that notebook's own socket rather than through
`HTTP.WebSockets.send`, so the question "how is this client written to" needs one answer per kind,
in one place.

## Decision

**Each client holds a bounded queue and one drain task.** `Client` (`src/server.jl`) is the
connection, a `Channel` of packed frames, and a count of what the queue refused.

**The drain task is the write serialisation.** It is the only task that writes to that connection,
so frames leave in the order they were queued. This is the guarantee the lock gave, and it now costs
no lock.

**`broadcast_all!` copies the client set under `clients_lock`, releases it, and enqueues.** Nothing
is sent under the lock, and the enqueue never blocks.

**The drain step is `send_frame(conn, bytes)`, one method per client kind.** It is the one place
that knows how a client of a kind is written to. A host that reaches its page by another route adds
a method and needs nothing else: the queue, the drain task and the policy below are the same for
every kind. This ADR ships the `HTTP.WebSocket` method only.

**A full queue drops the frame, counts it, and tells the client.** The next frame that fits is
preceded by a `core/dropped` command carrying the count. A slow client therefore costs its own queue
and nothing else.

**A slow client is never removed.** The connection recovers on its own once the page drains. A
client is dropped only when its send throws, which is what a closed connection does — the same rule
as before.

**A client that hears `core/dropped` asks for `core/replay`, and is answered with
`retained_messages(server)`.** That is the same set of frames a client connecting mid-session is
replayed. The server holds the last message per `(module, topic)` plus the window, so whatever a
drop lost is recoverable in full, and one path answers both callers.

**The queue holds 64 frames.** The count is small because one frame carries a whole window's arrays
and can therefore be megabytes: a deeper queue would hold a client's memory rather than its backlog.
The queue absorbs a burst; a client behind for longer than a burst is behind, and the drop says so.

**The recording moves to its own lock.** A recording is a sink and not a client. `record_frame!`
takes `record_lock`, so a slow disk holds up nothing but the next frame to be recorded.

## Alternatives declined

**Snapshot the module table.** A `Dict` of id to directory, replaced wholesale under the lock and
read without it. Six lines, and it takes `mount_for` off the lock — but the head-of-line block stays
for everything else the lock guards, and it says nothing about a second client kind.

**A send lock per client.** The broadcast takes the client set under `clients_lock`, releases it,
then sends under each client's own lock. It fixes the cause and it is less work than a queue. It
still blocks the broadcasting task on the slowest client, and a Slate client never blocks, so its
lock would be inert — the seam a second kind needs would sit in the middle of `broadcast_all!`
instead of in one function.

**Remove a client whose queue overflows.** A live page that the session stops drawing to, with
nothing to say why. A page that fell behind for one burst is the usual reason a queue overflows, and
it is drawing again a moment later.

**Retain nothing and re-push on a drop.** The server already retains the last message per pair, for
the client that connects mid-session. A second recovery path would be a second thing to keep
correct.

## Consequences

**A frame can now be dropped, which a session can observe.** Nothing was dropped before: a broadcast
either arrived or the client was removed. `broadcast_all!` and everything above it (`send_command`,
`send_reply`, `push_window`) return the number of clients the frame was **queued for**, which is one
lower per client that overflowed.

**Every client owes a replay request.** A viewer that ignores `core/dropped` keeps drawing the scene
it last received, with no sign that it is stale. The Core answers it.

**Two tasks broadcasting at one instant may be recorded in the other order** from the one the clients
are queued in, because the record and the enqueue are no longer under one lock. Neither task states
an order between them anyway; frames from one task keep theirs.

**`clients_lock` now guards state alone.** No send and no disk write happens under it, so the
question the split in `server.jl` raised — whether `mount_for` should take it for the module set —
answers itself: the take is a few instructions against a `Vector`.
