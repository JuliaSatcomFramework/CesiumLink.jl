---
status: accepted
---

# A name the author invents is a String

CesiumLink names things on both sides of one wire. Julia has `Symbol` and `String`; JSON
has only the string. So every name Julia sends leaves as a string, and every name that
comes back arrives as a string. Julia cannot tell that `"isl"` was written `:isl`.

Declaring a control as `Toggle(:isl, "ISL links", true)` and handing the listener
`ev.payload.id == "isl"` gives one value two spellings, one per direction, and leaves
the scene author to know which end they are holding. The same split reaches a module id,
which would be a `Symbol` where a scene constructs one and a `String` where an event
carries it back. A `String(ev.payload.id)` wrapper on a field that is already a `String`
is what that confusion looks like from the outside.

The read side cannot be fixed by converting harder. `as_named` turns an incoming payload
into named tuples generically, because a module's payload is that module's business
(ADR-0011). A generic decoder is handed `"isl"` with no table that says the author meant
a name. Only a hand-written decoder can restore a `Symbol`, and it can do so safely only
where the set of legal values is known.

## Decision

**The threshold is who owns the vocabulary.**

**CesiumLink's own vocabularies stay `Symbol`s.** The package holds the whole list,
refuses anything outside it, and restores the `Symbol` when the value comes back. These
are `region` (`:top_left` …), the pointer `type` (`:hover`, `:click`), the pointer
modifiers (`:alt`, `:ctrl`, `:shift`), the window `mode` (`:replace`, `:append`), a
node `marker`, an edge `style` — the stock half of each, see below — a model reference
`frame` and the imagery `tiling`. A
`Symbol` here reads as one choice out of a closed set, which is what it is, and the
round trip is total because the decoder can check the value against the list.

**A name the scene author invents is a `String`.** These are a control `id`, a float
`id`, a module id, an entity `kind`, an edge's `from` and `to`, and a model's `of`.
CesiumLink does not know the set, so no decoder can restore a `Symbol` for it, and the
declaring side must therefore say what the answering side hears.

**A vocabulary the package owns may still be part open.** ADR-0032 opens a node `marker`
and an edge `style` to a name the package does not own: an `assets/<mount>/<file>` path, a
`data:` URI, or the owner-namespaced name of something a browser module registered. The
threshold above decides each form on its own. The stock list stays a closed set of
`Symbol`s the package validates, and each of the three open forms is a `String`, because
the package does not own it and Julia can check only the **form** of the name. A
constructor keeps taking either spelling, so `marker = :star` and `style = :dashed` build
exactly as before.

**Both sides of a name now spell it the same way.** A listener compares
`ev.payload.id == "isl"` against the `Toggle("isl", …)` that declared it, and
`ev.entity.kind == "sat"` against the `Nodes("sat"; …)` that drew it.

**A constructor still takes either spelling.** Every one of these fields normalises with
`String(x)`, so `Toggle(:isl, …)` builds a control whose `id` is `"isl"`. The
normalisation is what makes one type reach the wire; refusing a `Symbol` at the door
would buy nothing.

**A `Select` option value normalises the same way.** A `Symbol` option becomes a
`String` at construction, so the value the listener reports is one of the options the
declaration holds. Without this, re-declaring a select with the value the user chose is
refused by its own validation.

**The rule governs what a field holds and what an event carries, not what a call site
types.** `vendored(:primitives)` and `register_module!` still take a `Symbol`;
`entry.id` holds a `String` and `ev.module_id` carries one. Only a value that is
compared against something the wire returned has to be written as a `String`.

A `Dict` key is out of scope for the same reason.
`push_window(server, Dict(:primitives => …))` and `Dict("primitives" => …)` reach the
same JSON, because a `Dict` key is a Julia-side key and JSON stringifies it. The same
holds for the `Symbol` keys `as_named` builds. The one exception is a key that
**addresses** a name: a `ui` track is keyed by the control id it feeds, so it is written
the way that control was declared.

## Alternatives declined

**All `Symbol`s, restored on the way in.** Consistent in the source and impossible on the
wire: `as_named` would have to know which strings in an opaque module payload are names,
which is exactly the knowledge ADR-0011 keeps out of the Core. It works only for the
closed sets, which is the decision above.

**All `String`s, including the closed sets.** One rule with no threshold to explain.
It costs the reading: `region = "top-left"` is free text where `:top_left` is a choice,
and `_` against `-` becomes a live spelling question rather than one the package answers
in `wire_region`. Julia writes a closed choice as a `Symbol` (`:auto`, `:none`), and
these sets never suffer the round trip that broke the names.

**Leaving the entity `kind` a `Symbol`.** It round-trips correctly today, because
`pointer_fields` restores it by hand. It is still a name the author invents, it sits in
one constructor beside a module id that is a `String` — `Entity(:primitives, :sat, 12)`
— and the hand restoration never validates. Keeping it would leave the rule with an
exception that nothing else needs.

**A `Name` wrapper type that prints as either.** One type, one comparison, and a
`convert` for the wire. It is a new concept in every signature and every docstring, to
solve a problem two conversions already solve.

## Consequences

The Julia API changes without breaking a call site: constructors take either spelling,
so `Nodes(:sat; …)` and `Toggle(:isl, …)` still build. What changes is what a **field**
holds and what an **event** carries. Code that compares `ev.entity.kind === :sat` must
now compare against `"sat"`, and code that reads `c.id` gets a `String`.

`server.float_rects` is keyed by `String`. `Symbol(:pin, idx)` in a scene becomes
`"pin$idx"`. The `String(…)` and `Symbol(…)` wrappers in the examples and the how-to
pages go away, and the paragraph in `on_event`'s docstring that listed which fields are
which shrinks to the rule.

Interning is lost for these fields. It bought nothing measurable: the per-event
comparisons in `dispatch_event` were already `String`s, and the rest are per-declaration
rather than per-frame.

The rule has to be applied to every new field. A field that names a closed set the
package validates takes a `Symbol`; anything the author gets to name takes a `String`.
