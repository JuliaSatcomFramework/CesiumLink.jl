# Domain Docs

How an agent should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `docs/src/explanation/glossary.md` + `docs/decisions/`. (The split between
`src/`, `lib/` and `extension/` is a build-artifact boundary, not separate bounded contexts — it is
all one viewer domain.)

## Before exploring, read these

- **`docs/src/explanation/glossary.md`** — the domain glossary, and a published page.
- **`docs/decisions/`** — read the records that touch the area you are about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. They grow lazily, when a term or a decision actually gets resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/src/explanation/glossary.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it, and add the term).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0011 (the vocabulary stays in CesiumLink) — but worth reopening because…_
