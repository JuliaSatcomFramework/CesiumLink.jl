# Changelog

All notable changes to CesiumLink are in this file.

## [Unreleased]

## [0.2.0] - 2026-09-02

### Added

- `KNOWN_EARTH_BASEMAPS` names seven ready-made `Imagery` values of Earth:
  `offline_natural_earth`, `aster_colour_relief`, `aster_grey_relief`, `emodnet_baselayer`,
  `blue_marble`, `blue_marble_relief` and `city_lights`. Each one carries the attribution its source asks for.
  `Imagery` and `KNOWN_EARTH_BASEMAPS` are both exported.
- `imagery` takes a list, so a server declares a basemap **set** and the reader picks inside it. A
  picker button stands in the furniture group while the set holds two or more.
- `Imagery` takes `backing`. A basemap marked that way draws the viewer's bundled pyramid underneath
  itself, so a source that stops serving leaves a globe instead of a black ball.
- `declare_furniture` takes `basemap`. Set it to `false` to declare a set and show no picker over it.
- The viewer draws place names and country borders above whichever basemap is on screen, from
  two Natural Earth files inside the viewer, so neither reaches the network. `start_server` takes
  `named_places` and `country_borders`, both on by default and each its own flag. The names page
  with the camera height, so a continent never competes with the cities inside it. See ADR-0036.
- `declare_furniture` takes `annotations`, the cell beside the basemap picker with one checkbox
  per layer. A tick is the reader's own view and never travels back to the server.
- `Imagery` takes `border_color` and `border_width`, the style its country borders are drawn in,
  because the right colour depends on what lies under the line. Every known basemap carries the
  colour that reads on it. The viewer thins the width from 2,000 km out to half at 20,000 km.
- `Imagery` accepts `tiling = :gibs_geographic`, NASA's EPSG:4326 grid, which is not Cesium's own.

### Changed

- **Breaking behaviour.** An absent `imagery` on Earth no longer means the bundled texture alone. It
  declares the seven ready-made basemaps, ASTER Colour Relief first and backed by the bundled pyramid,
  so a default session offers all seven in the picker. Entry 1 is the only one the page builds a tile
  provider for, so the globe opens by asking `gibs.earthdata.nasa.gov` for tiles and reaches no
  other host until the reader picks one. One line takes the network out again:
  `start_server(; imagery = KNOWN_EARTH_BASEMAPS.offline_natural_earth)`. A session on another body
  is unchanged: it still wears the bundled texture and reaches no network.
- **Breaking behaviour.** A `credit` is HTML, where it used to be drawn as text. An attribution
  that must carry a link now can, and one that holds a `<` no longer shows it. The viewer sanitizes
  the string against a narrow allow-list before it draws it — a link and light emphasis, and no
  attribute that paints — and rewrites the line on every switch.
- `?imagery=`, `?tiling=`, `?maxlevel=` and `?credit=` in a page address reach the globe only where
  no declaration states a basemap. A server on Earth now always declares one, so those parameters
  are for a page with no server behind it, or for a session on another body.
- A recording carries the whole declared set, not one basemap. A recording made with a keyed URL
  therefore holds that key in plain text.
- The content policy of a VSCode panel opens for the tile directory of every basemap in the set,
  not for its host.
- Every known online basemap is geographic tiles that reach both poles. A Web Mercator source
  stops at 85 degrees and wears the backing as a pale disc at each pole; none of the seven does.
- The viewer builds against `@cesium/engine` `^26.2.0`. The exact `26.1.0` pin made npm install a
  second engine below `@cesium/widgets`, and the bundle carried both. See #38.

### Fixed

- The release artifact no longer carries the Cesium worker files that nothing loads. `lib/dist` is
  smaller than it was before the bump. See #38.

## [0.1.3] - 2026-08-27

### Added

- `capture_canvas(server, path; scale, timeout)` writes one PNG of the viewer's canvas to a file. The
  `canvasCapture` furniture item copies the same picture to the clipboard on a left click, and its
  popup names a file and a scale. The furniture, the overlay and the floats are HTML above the
  canvas, so no capture holds them. `scale` multiplies the drawing buffer, and a viewer that cannot
  draw the picture answers with the reason. See ADR-0033.
- `Areas` takes `mesh_deg`, the degrees of arc between the vertices the browser lays inside a draped
  footprint, for the whole family. It rides the geometry window beside `drape`, and changing it
  re-tessellates. Reach for it where a footprint's sag would show: on a globe carrying real terrain,
  or with `depthTestAgainstTerrain` on.

### Changed

- A draped footprint is meshed at 4° per cell instead of 0.5°. The finer mesh was derived from the
  threshold that decides *whether* a footprint drapes, which is a different question, and it cost 28
  times the triangles for accuracy no screen resolves — a continent-sized family came to 8.2 M
  triangles and made panning visibly slow. Pass `mesh_deg` to get the old mesh back.
- The package allows SlateExtensionsBase 0.10 beside 0.9.1.

### Fixed

- An `Areas` region 180 degrees or wider in longitude, or 180 degrees or taller in latitude, stopped
  the whole scene with "normalized result is not a number". A ring holding two vertices in the same
  place threw the same error, and Julia now rejects that ring when the family is built.
- The hover tooltip goes away when the pointer moves off the globe onto a floating object, the
  overlay panel or a widget. It used to stand behind the float until the cursor came back.

## [0.1.2] - 2026-08-24

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
