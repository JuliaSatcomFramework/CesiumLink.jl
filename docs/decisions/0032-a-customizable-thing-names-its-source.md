---
status: accepted
---

# A customizable thing names its source

A vendored module draws stock things from a list it owns. A third-party package that wants one more
glyph or one more line material cannot add to that list, so it copies the whole vendored module to
change one thing.

Two seams already had part of an answer, and each had spelt it for itself. A node `marker` took a
stock name or a `data:` URI. A model `of` took an `assets/<mount>/<file>` path. An edge `style` took
a stock name and nothing else. Three prefixes, three seams, no shared rule.

## Decision

**One string names a customizable thing, and its first token says where the thing comes from.**

| Form | Means |
|---|---|
| `data:…` | the bytes travel in the payload |
| `assets/<mount>/<file>` | the server serves the file, and the host rebases the URL |
| `owner.name` — holds a `.` | a peer module registered it in the browser |
| anything else | a stock name the vendored module owns |

**The four forms cannot collide, and no seam depends on the order they are tested in.** A `data:`
URI is read first, because a URI scheme admits any character after it and no test of shape separates
one from the rest. The other three differ in shape: an asset path always holds a `/`, a module name
holds a `.` and never a `/`, and **a stock name never holds either**. That last one is a rule the
stock tables are asserted against where they are declared, not a hope.

A `/` name that is not a well-formed `assets/<mount>/<file>` path still reads as an asset, and the
caller reports it as the malformed asset path it is rather than as a name nobody registered.

`sourceOf` in `lib/core/src/source.ts` is the whole discriminator: four lines of string work, no
Cesium, no state. It lives in the Core because the Core already owns the `assets/` prefix, and a
second package must not re-spell it.

**An unknown name warns once and falls back to the stock default.** It never throws. A scene is
already on the wire by the time a browser reads one of these names, and a throw there takes down
more than the one line it could not draw.

## No shared resolver

**The rule is shared. The resolution is not.** A sprite ends as a canvas or an image URL; a line
material ends as a Cesium `Material`. No one function makes both, so a shared `resolve()` returns
`unknown` and every caller casts it back. The `switch` at each seam is about eight lines; two seams
is sixteen, and a shared resolver plus its casts is larger than that.

What the two seams do share is the half that is identical: `registry(what)` in
`lib/primitives/src/registry.ts` holds the `Map`, refuses a name that is not owner-namespaced,
refuses a second registration of one name, and empties on teardown. It follows `defineWidget` and
`clearWidgets` in the `ui` module, which already worked this way.

## A registry is the last resort

The four forms are a ladder, and a registration is the top rung. Reach for the rung below it first:

1. **A stock name.** It costs nothing and every viewer already draws it.
2. **An assets mount**, for a file. The server serves it once instead of putting it in every window
   that re-declares the family.
3. **A `data:` URI**, for something small. The bytes ride the payload and no mount is needed.
4. **A registration**, and only when the thing needs code in the browser — a shader, a canvas drawn
   per frame, anything that cannot be a file.

The node marker is the proof. Every scene in this repository has drawn its markers from a stock name
or a `data:` URI, and none has needed a registration yet.

## Consequences

**A vendored module's vocabulary is now part open.** The stock list stays closed and the package
still owns it; the set beside it is whatever the browser has been told about. See ADR-0029 for what
that does to the `Symbol`/`String` threshold.

**Julia validates the form of a name, not its value.** Julia cannot know what a peer module
registered in a browser, so `to_source` admits any well-formed name and checks the stock list only
for a name that is none of the other three forms. A typo in a registered name therefore reaches the
browser and is reported there.

**A registration is scoped to the module that registered it.** The registry empties when
`primitives` unloads, because the factories close over a context that no longer exists.

**A new customizable field takes the same rule.** An area material, a label style and a raw Cesium
`fabric` entry are all out of scope today; each of them is this rule again, and none of them is a
new one.

## Alternatives declined

**One resolver for every seam.** It is the shape the rule suggests and the wrong shape for the
answer, for the reason above: nothing useful comes back out of it.

**A registry with no naming rule — every name looked up, stock names first.** It works, and it makes
the order of the tests load-bearing: a module registering `disc` would shadow a stock glyph or be
silently ignored, depending on which lookup ran first. The dot is what makes the question not arise.

**A prefix scheme of its own, such as `module:orbits/pulse`.** One more spelling for a reader to
learn, to say what a dot already says. The dot also matches how the rest of the wire spells an
owned name — a module id is already a bare token, and `orbits.pulse` reads as that module's `pulse`.

**Letting a scene ship a shader as data.** A `data:` URI of GLSL, resolved into a material by the
vendored module. It puts a compiler contract on the wire, ties the scene to one renderer's shading
language, and gives a server author a way to run arbitrary code in the browser through a field that
looks like a colour. A registration is code in the browser too, but it arrives as a declared module,
which is the route the viewer already gates on an API version.
