# Explanation

These pages state why CesiumLink is shaped the way it is: the split between the browser and the
Julia process, what a window guarantees about entity identity, what a module is, and what arrays
cost on the wire. They carry opinion, and they name the designs that lost.

Nothing here is a set of instructions. To build a first scene, read the
[tutorials](../tutorials/index.md). To solve a problem in hand, read the
[how-to guides](../how-to/index.md). The [reference](../reference/index.md) states what each
function, each type and each wire field does.

## The pages

- [The shape of the system](architecture.md) — the payload-opaque Core, the Julia process that
  decides everything, and the line between them.
- [Windows, keyframes and identity](windows.md) — the declared range against the delivered buffer,
  what an index means inside one window, and the two push kinds.
- [Why the server decides](server-authoritative.md) — a control reports input and changes nothing,
  the listener chain answers with one command batch, and a reconnecting browser gets its scene back.
- [Modules, vocabularies and glue](modules.md) — the JavaScript that renders, the Julia types the
  payloads are built from, and the package that authors the messages.
- [Arrays on the wire](arrays.md) — why arrays travel as bytes behind a JSON header, and why the
  protocol has no requests.
- [Glossary](glossary.md) — every term this documentation uses, one sentence each, with the words
  to avoid.

## Decision records

Each decision that shaped the system has a record of its own, stating the decision, the options that
lost, and the consequences. Later records supersede earlier ones, and several carry a Revision that
changes part of the original text. Both halves stay in the file.

The records are notes for the people who work on the repository, and not pages of this site. They
live under `docs/decisions/`, one numbered file each. A page above cites one by number, as
`ADR-0016`.
