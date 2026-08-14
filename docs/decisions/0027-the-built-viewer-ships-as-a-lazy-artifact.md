---
status: accepted
---

# The built viewer reaches Julia as one lazy artifact

`viewer_dist()` prefers `lib/dist` when that directory exists, and falls back to a lazy Julia
artifact. The artifact is one entry, `viewer`, pointing at a GitHub release asset that holds the
whole built tree.

## Why

The shared Cesium chunk is 4.6 MB and all three hosts stand on it. It cannot be committed: a git
object is in every clone forever, and the tree is rebuilt on every source change. The package serves
no viewer without it.

A release asset is not a git object, so it never enters a clone. A lazy artifact downloads on first
use rather than on `Pkg.add`, so a user who installs the package to read its documentation pays
nothing.

`lib/dist` comes first, so a developer who runs `npm run build` serves the tree they just built and
never touches the artifact.

## Considered options

- **A lazy artifact, with `lib/dist` preferred** (chosen).
- **Commit the built tree** (rejected). 25 MB per state of the tree, in every clone, forever.
- **Two artifacts, one for the Cesium subtree** (rejected). It buys nothing and forces a second mount
  root in `static.jl`.
- **`export-ignore` in `.gitattributes` to keep `lib/` out of what a user downloads** (rejected, and a
  trap). Pkg verifies a package tree against its `git-tree-sha1`. A tree that `git archive` strips
  does not match that hash.

## Consequences

`LazyArtifacts` goes in `[deps]` and `[compat]`, and `CesiumLink.jl` says `using LazyArtifacts`. A
lazy artifact reached through `@artifact_str` without that import raises an error at first use.

The release build carries no source maps. The maps of the three host entries are 21 MB, which is more
than the rest of the tree together, and they are paid on every download. `node build.mjs --sourcemap`
gets them back for a debugging session.

`build.mjs` copies the two Cesium `LICENSE.md` files into `dist/cesium/`. The artifact redistributes
7.5 MB of Apache-2.0 assets, and section 4 of that license asks for the license text to travel with
them.

`viewer_dist()` prints a message before the download. It is the default value of a keyword on both
`start_server` and `vendored`, so without one the first `start_server()` stops for several megabytes
with no output.

**`viewer_dist()` resolves earlier than the page asks for the bundle.** The discovery file a server
writes publishes it, and the VSCode extension reads that entry to find the tree it grants the webview.
So an installed package resolves the artifact when it writes the discovery file.
