# CesiumLink

A Cesium-based 3D globe viewer that draws time-dynamic scenes streamed from a Julia server over one
WebSocket. The Julia package is the repository root, the viewer sources are in `lib/`, and the VSCode
extension is in `extension/`.

Read `docs/src/explanation/glossary.md` for the vocabulary and `docs/decisions/` for the
architecture decisions. The glossary is a page of the documentation site; the records are not.

## Layout

| Path | What is in it |
|---|---|
| `src/`, `test/` | the Julia package |
| `lib/` | the npm root: the Core, the three hosts, the four vendored modules, `build.mjs` |
| `extension/` | the VSCode extension |
| `examples/` | the example packages and scripts, which the documentation build runs |
| `tools/` | the regression harness, the fixture generators and the check scripts |
| `docs/` | the documentation site, plus `decisions/` beside it |

`lib/dist` is built, never committed. Run `npm run build` in `lib/` before the Julia tests: the suite
calls `viewer_dist()`.

## Agent notes

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/`, which is gitignored. See
`docs/agents/issue-tracker.md`.

### Regression harness

Before and after any renderer change, `npm run harness:check` in `lib/`. It counts draw commands per
frame in headless Chrome; frames per second from it mean nothing. See `tools/README.md`.

### Domain docs

Single-context: `docs/src/explanation/glossary.md` + `docs/decisions/`. See `docs/agents/domain.md`.
