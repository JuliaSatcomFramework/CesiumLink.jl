# Changelog

All notable changes to CesiumLink are in this file.

## [Unreleased]

### Added

- Eight more stock marker glyphs for a `Nodes` family: `:diamond`, `:triangle_down`,
  `:triangle_right`, `:triangle_left`, `:pentagon`, `:hexagon`, `:cross` and `:x`, beside the
  `:disc`, `:square`, `:triangle` and `:star` that were there already.

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
