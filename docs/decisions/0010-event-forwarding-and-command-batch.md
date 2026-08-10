---
status: accepted
---

# Events are forwarded by subscription; the server answers with one command batch

The viewer forwards an event upward only when the server has a listener for it.
The server keeps a registry of listeners keyed by `(module, topic)` — a pointer
event is just `("core", "pointer")`, with no special case — and **derives** the
subscription it pushes from what is registered. The subscription is therefore
never declared by hand and cannot drift from the listeners it describes.

An arriving event runs every listener registered for it, in registration order.
Each may contribute commands addressed at whichever module should receive them,
and the contributions are assembled into **one** reply. A listener may halt the
chain; what was already collected still ships. A listener that throws is caught
and logged, and the remaining listeners still run.

Downward, a module receives commands by topic, one handler per topic. A second
registration for the same topic is refused and warned about, so a module cannot
silently shadow its own routing.

## Considered options

- **Derived subscription, listener chain, batched reply** (chosen).
- **Forward everything.** Rejected: a hover event fires at pointer rate, and a
  session with no hover listener would pay a round trip per pointer move to be
  told nothing happened.
- **A subscription the author declares alongside the listeners.** Rejected: two
  statements of one fact, and the failure mode is silent — the event simply never
  arrives, with nothing to indicate the subscription was the reason.
- **One reply per listener.** Rejected: a hover over an entity that three
  listeners care about becomes three messages the viewer applies at three
  different instants, which is visible as tearing in the tooltip and the overlay.

## Consequences

Tooltip content is contributed through this mechanism like anything else, which
is what makes Julia the only author of it. The viewer-side immediate tier is gone,
and with it the two formatters that could disagree about which keyframe they were
describing.

**A tooltip is now a round trip.** Server-local that is a few milliseconds; over a
forwarded link it is visible. The fix, if it ever bites, is a module-local
immediate tier — which reintroduces exactly the duplication removed here, so it
needs a measurement first.

**The chain couples cheap and expensive listeners.** The batch is assembled after
the whole chain has run, so one slow listener delays every other contribution to
that event. A hover listener must not re-derive. That is a contract, not something
the chain enforces.

Which replies are stale is the **receiving module's** judgement, not the Core's. A
late click reply can still be worth applying; a late hover reply is not, and only
the module holding it knows which it has.
