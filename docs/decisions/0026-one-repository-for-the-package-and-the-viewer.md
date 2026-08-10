---
status: accepted
---

# One repository holds the Julia package, the viewer and the extension

The Julia package is the repository root. The viewer sources are in `lib/`, and the VSCode extension
is in `extension/`. All three ship from one repository, on one branch, under one version.

## Why

The wire contract spans both languages. A field added to a payload is a change to `src/` and a change
to `lib/core/`, and the two must agree or the viewer draws nothing and reports nothing. In one
repository that is one commit, one review and one test run. In two it is a version handshake, and a
handshake is a thing that can be wrong.

The Julia package cannot serve a scene without the built viewer, so the two move together in every
case. The extension consumes the same built viewer and speaks the same protocol version, so it moves
with them too.

## Considered options

- **One repository** (chosen). The committed JavaScript sources weigh about 400 KB. Nothing generated
  is committed: `lib/dist` is 25 MB and ships as a release artifact (ADR-0027), and `node_modules` is
  never in the tree.
- **A repository for the viewer and a repository for the package** (rejected). Every protocol change
  then needs a version handshake across two repositories, two releases and two reviews. What it buys
  is a few hundred kilobytes in a clone.
- **The extension in a repository of its own** (rejected). It is built from the same bundle by the
  same `build.mjs` entry, and its tests run under the same `npm test`. Splitting it would duplicate
  the build to separate two directories.

## Consequences

The npm root is `lib/`, not the repository root. A `package.json` at the root makes every JavaScript
tool treat the Julia package root as a node package, and puts `node_modules/` beside `Project.toml`.

`extension/` is a sibling of the npm root rather than a workspace member of it. A workspace member is
hoisted into the root `node_modules` and the root lock file, so every contributor to the Julia package
would install `@vscode/vsce`. The extension declares no dependencies, so `npx @vscode/vsce package`
works over the folder as it stands. Two scripts in `lib/package.json` reach out to `../extension/`,
and they are the only ones that climb out of the npm root.

`test/runtests.jl` names the test directory rather than calling `@run_package_tests`. That macro walks
every `.jl` file under the package root, and the package root is now the repository root.
