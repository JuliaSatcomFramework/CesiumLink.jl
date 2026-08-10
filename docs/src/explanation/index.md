# Explanation

These pages state why CesiumLink is shaped the way it is. They cover the split between the browser
and the Julia process, what a window guarantees about entity identity, and what arrays cost on the
wire. They also state what a module is, and what it is not. They carry opinion, and they name the
designs that were considered and rejected.

Nothing here is a set of instructions. A reader who wants to build a first scene is served by the
[tutorials](../tutorials/index.md), and a reader with a problem in hand by the
[how-to guides](../how-to/index.md). The [reference](../reference/index.md) states what each
function, each type and each wire field does. These pages state why those things are as they are, so
that a reader can predict the behaviour of the system in a case no page covers.

## The pages

- [The shape of the system](architecture.md) — the payload-opaque Core in the browser, the Julia
  process that decides everything, and the line between them.
- [Windows, keyframes and identity](windows.md) — the declared range against the delivered buffer,
  what an index means inside one window, and why the two push kinds carry different promises.
- [Why the server decides](server-authoritative.md) — a control reports input and changes nothing,
  the listener chain answers with one command batch, and a reconnecting browser gets its scene back.
- [Modules, vocabularies and glue](modules.md) — the three things that are easy to confuse: the
  JavaScript that renders, the Julia types the payloads are built from, and the package that authors
  the messages.
- [Arrays on the wire](arrays.md) — why arrays travel as bytes behind a JSON header, what the frame
  layout buys, and why the protocol has no requests.
- [Glossary](glossary.md) — every term this documentation uses, one sentence each, with the words
  to avoid for each one.

## Decision records

Each decision that shaped the system has a record of its own. A record states the decision, the
options that lost, and the consequences that followed. Later records supersede earlier ones, and
several carry a Revision that changes part of the original text. Both halves stay in the file, so
the history of a decision is readable in one place.

The records are notes for the people who work on the repository, not pages of this site. They live
in the repository under `docs/decisions/`, one numbered file each. A page above may cite one by
number, as `ADR-0016`; read those in the repository.
