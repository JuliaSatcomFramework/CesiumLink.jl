# Examples

Each example is a whole runnable program. The tutorials teach the system a lesson at a time and the
how-to guides answer one problem each, so both show you fragments. An example shows you everything a
working scene needs, and nothing it does not.

**Examples is not one of the four [Diátaxis](https://diataxis.fr) sections.** It answers no need of
its own. It shows the four sections' material standing together, which is the one thing none of them
does.

The four examples form a ladder. The rung is not how many files an example has — it is which part
of the API its author reaches for.

| Rung | What the author writes | Example |
|---|---|---|
| 1 | a script that calls [`push_window`](@ref) | [Solar elevation](solar-elevation.md) |
| 2 | a script that holds a scene and answers for it | [Satellite trails](satellites.md) |
| 3 | a package with a scene type and a [`serve_scene!`](@ref) method | [Constellation](constellation.md) |
| 4 | the same, plus a viewer module and its JavaScript | [Satellites over a region](region-count.md) |

The code of each one is on its page, in full. It also sits in the package, under `examples/`, so a
clone carries it and you can run it where you read it.

Every example runs during the documentation build. The scene on each page is a recording of that
run, played in the browser with no Julia behind it — see
[Record and replay a session](../how-to/record-replay.md).
