# Changelog

All notable changes to CesiumLink are in this file.

## [Unreleased]

### Added

- The viewer reports the animation clock on two new Core topics. Listen to them with
  `on_event`. `core/clock` carries `ev.multiplier`, which is signed — the sign is the
  direction and the size is the speed — and `ev.playing`, which is the play/pause button.
  `core/keyframe` carries `ev.index`, the keyframe the clock just crossed into. Together they let a
  scene build frames before `core/need` asks for them, which the how-to page shows.
- A node `marker` and an edge `style` take four forms of name: a stock name, an
  `assets/<mount>/<file>` path, a `data:` URI, and the owner-namespaced name of something a browser
  module registered. The first token of the name says where the thing comes from. See ADR-0032.
- The `primitives` module exports `defineNodeSprite(name, factory)` and
  `defineEdgeMaterial(name, factory)`. A module of your own adds a marker glyph or a line material
  with them, instead of copying the whole vendored module. `examples/PulseEdges/` shows both halves
  of one registration.
- A marker takes an `assets/<mount>/<file>` path. The server serves the image as a file. Before, a
  marker image had to be a `data:` URI, which travelled again in every window that re-declared the
  family.
- Eight more stock marker glyphs for a `Nodes` family: `:diamond`, `:triangle_down`,
  `:triangle_right`, `:triangle_left`, `:pentagon`, `:hexagon`, `:cross` and `:x`, beside the
  `:disc`, `:square`, `:triangle` and `:star` that were there already.

### Changed

- `marker = "https://example.com/sat.png"` no longer throws when the family is built. The `/` makes
  the name an asset path, and the viewer reports it as the malformed asset path it is.
- Julia checks only the form of a `marker` or a `style` name, because it cannot know what a browser
  registered. A registered name that no module answers for writes one line to the browser console
  and draws the stock default. It does not throw.

## [0.1.1] - 2026-08-20

### Added

- `start_server` takes the keyword `listen`. It opens the HTTP port. It defaults to `true`
  everywhere but in a notebook cell.
- `CesiumLink.in_notebook()` tells you if the code runs in a notebook cell. The Slate extension
  installs the check when it loads.

### Changed

- A server started in a KaimonSlate cell opens no port. The cell sends its frames on the socket the
  notebook page already holds. Set `listen = true` to get a port in a cell.
- A server with no port prints `(not listening)`. A stopped server still prints `(stopped)`.
  `viewer_url` and `bound_port` name which of the two they refuse.

## [0.1.0] - 2026-08-19

- First release.
