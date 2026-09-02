# Choose what the globe is textured with

The globe wears a **basemap**. The server declares a **basemap set** (one basemap, or several), and
the reader picks inside the set. `imagery` says what the set holds, once, at `start_server`.

From 0.2.0 a session on Earth that says nothing declares all seven basemaps this package knows, ASTER
Colour Relief first and the offline pyramid last. An entry costs nothing until the reader picks it:
the page builds a tile provider for the first entry alone, so the globe still opens by asking one
host, `gibs.earthdata.nasa.gov`, for tiles. Place names and country borders draw over that globe,
from two files inside the viewer. This is the one change a reader meets on upgrade, and the release
is 0.2.0 because of it. A session on another body still wears the bundled texture and declares
nothing.

## Take the network out of it

Name one basemap that ships inside the viewer:

```julia
start_server(; imagery = KNOWN_EARTH_BASEMAPS.offline_natural_earth)
```

That one line removes the network, the picker, and its button. The pyramid is in the viewer bundle, so
the page fetches no tile from anywhere. A set of one has nothing to pick, so the picker hides itself.

The place names and the country borders stay on the globe. Their two files ship inside the viewer
too, so they reach no network either. [Names and borders over the
globe](#names-and-borders-over-the-globe) turns them off.

## The basemaps this package knows

[`KNOWN_EARTH_BASEMAPS`](@ref) holds ready-made [`Imagery`](@ref) values. Each one carries the
attribution its source asks for, so a session that declares one also credits it.

| Key | What the globe wears | Deepest level | Credit drawn | Border |
|:--|:--|:--|:--|:--|
| `offline_natural_earth` | the pyramid inside the viewer, which reaches no network | 2 | none, the texture is public domain | dark grey |
| `aster_colour_relief` | ASTER shaded relief from NASA GIBS, in colour | 11 | `NASA EOSDIS GIBS` | dark grey |
| `aster_grey_relief` | ASTER shaded relief from NASA GIBS, in grey | 11 | `NASA EOSDIS GIBS` | black |
| `emodnet_baselayer` | EMODnet Bathymetry, with sea-floor relief | 15 | `EMODnet Bathymetry (CC BY 4.0)` | dark grey |
| `blue_marble` | Blue Marble from NASA GIBS, with sea-floor colour | 7 | `NASA EOSDIS GIBS` | white |
| `blue_marble_relief` | Blue Marble from NASA GIBS, land relief only | 7 | `NASA EOSDIS GIBS` | white |
| `city_lights` | night-time city lights from NASA GIBS, VIIRS 2012 | 7 | `NASA EOSDIS GIBS` | white |

The two ASTER reliefs draw the land only. Their ocean is one flat blue and carries no sea-floor
colour. `emodnet_baselayer` draws the sea floor, and it is the one entry served from a host other
than NASA GIBS.

The six online entries are cut on a geographic grid, so each of them draws to both poles. Each
names a basemap backing as well, and the backing shows only while its host is unreachable.

Every one of them is of Earth. None belongs in a session on another body.

Name the ones you want, in the order you want them:

```julia
# the default order, stated by hand
start_server(; imagery = [KNOWN_EARTH_BASEMAPS.aster_colour_relief,
                          KNOWN_EARTH_BASEMAPS.aster_grey_relief,
                          KNOWN_EARTH_BASEMAPS.blue_marble,
                          KNOWN_EARTH_BASEMAPS.blue_marble_relief,
                          KNOWN_EARTH_BASEMAPS.city_lights,
                          KNOWN_EARTH_BASEMAPS.emodnet_baselayer,
                          KNOWN_EARTH_BASEMAPS.offline_natural_earth])

# the same seven, in catalogue order
start_server(; imagery = collect(KNOWN_EARTH_BASEMAPS))
```

Pick by field, as above. Do not filter the catalogue by its name strings. A source renamed in a
later release matches nothing, and the filter hands you back a basemap you meant to drop.

### All six, live

The scene below is a recording of a session that declares all six. No Julia process is running.
Open the basemap picker at the top right and pick each entry in turn.

```@raw html
<!-- The five online basemaps come from NASA GIBS and from EMODnet, which nothing here controls.
     A globe that stays flat and blurry after a pick means one of those hosts is unreachable: the
     basemap backing is drawing the bundled pyramid in place of the tiles that did not arrive. -->
<iframe src="../viewer/player.html?rec=../recordings/orbit.jsonl&modules=modules"
        title="A recorded session declaring all six known Earth basemaps"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

The picker lists the set in the order the server declared it, and the globe wears entry 1 at
startup. The credit line at the bottom right names the basemap you picked, and the viewer rewrites
it on every switch. Natural Earth is the bundled pyramid, so it draws no credit and asks for no
tile.

The picker sorts the six under three headings. A heading names what the reader sees, and never who
serves the tiles. Relief holds the maps somebody drew, and Imagery holds the photographs:

| Heading | What sits under it |
|:--|:--|
| Offline | `offline_natural_earth`, the pyramid inside the viewer |
| Relief | `aster_colour_relief`, `aster_grey_relief` and `emodnet_baselayer` |
| Imagery | `blue_marble` and `blue_marble_relief` |

EMODnet sits under Relief with the two ASTER maps although another host serves it. A basemap you
name yourself carries no catalogue key, so the picker draws it with the Natural Earth icon and puts
it under Imagery.

The recording carries the set and not the pick. Reload the page and the globe wears entry 1 again.

## What a set is, and what a backing is

**Entry 1 is what the globe wears at startup.** The rest are what the reader can switch to. The
picker is furniture: it is on by default, and it hides itself while the set holds fewer than two
basemaps. [Choose the on-screen furniture](furniture.md) turns it off by hand.

**A basemap can name a basemap backing.** `backing = true` draws the bundled pyramid under that
basemap. A source that returns no tiles leaves a globe instead of a hole, and the globe repairs
itself when the source answers again. All six known online basemaps ask for one.

A basemap backing belongs to one basemap, and the set never holds it as an entry. The reader cannot
pick it, it carries no transparency, and it always sits below. The backing is always the bundled
pyramid, which is of Earth, so `start_server` throws when a session on another body asks for one.

The credit line names the basemap the reader picked. The viewer rewrites it on every switch, and it
never names the backing. The bundled texture is public domain and asks for nothing.

Nothing travels back up the wire. Which basemap is on screen is the viewer's own business, as the
camera is. A recording therefore carries the declared set, and a replay opens on the same first entry
with the same set to pick from. See ADR-0034 for the whole decision and what it declines.

## Names and borders over the globe

The viewer draws two more layers above whatever basemap the reader picked: the place names and the
country borders. Both are on by default, and `start_server` takes a flag for each:

```julia
# the names alone, with no line asserting a boundary
start_server(; country_borders = false)

# the bare globe
start_server(; named_places = false, country_borders = false)
```

The names are the continents, the oceans and seas, the countries, and their larger cities. The
country borders are the boundary lines between countries. The flags stay separate because a border
is a political claim. A reader who wants the names without one turns the borders off and keeps the
names.

No layer belongs to a basemap. The picker takes off the imagery layers of the entry on the globe.
Neither of these is an imagery layer, so a switch leaves both where they are. Every file ships
inside the viewer, so neither reaches the network, opens an origin, or adds to the credit line.

The reader switches each layer from the `annotations` cell, which stands beside the basemap picker
and holds one checkbox each. A tick is that reader's own view of the globe and never travels back to
the server. The next browser therefore opens on what `start_server` declared. [Choose the on-screen
furniture](furniture.md) takes the cell down for a session that wants no switch, and the declared
flags still decide what draws.

The names thin out as you fly in. Each name states the band of camera heights that draws it. A
continent therefore gives way to the countries in it, and a country to its cities. The viewer keeps
only the names the camera can see, ranks them, and drops any whose text box lands on one already
kept. See ADR-0036 for the whole decision, what it measured, and what it declines.

### The colour a country border wears

Each basemap says what colour and width the country borders wear while it is on the globe. The right
colour depends on what lies under the line: white reads over a photograph and disappears over a pale
relief map. `border_color` is a CSS colour string and `border_width` is a number of pixels:

```julia
start_server(; imagery = [Imagery(dark_url; name = "Night", border_color = "#ffffff8c"),
                          Imagery(pale_url; name = "Relief", border_color = "#3a3a3ab3",
                                  border_width = 1.5)])
```

Say neither and the borders are white at just over half strength, two pixels wide. The browser
parses the colour, so the server checks only that the string is not empty. A string the browser
cannot read draws the default and writes one line to the console.

The width is the width the reader sees zoomed in. The viewer thins the line towards the whole-globe
view, where the whole world's borders are in view at once: full width at 2,000 km and below, half of
it at 20,000 km and above, and between the two it falls with the log of the camera height.

The viewer restyles the lines it already has when the reader picks another basemap. It fetches
nothing, so the borders never leave the globe for the length of a switch.

## Point at a basemap on the web

Give the URL template of a tile pyramid. `{z}`, `{x}` and `{y}` are the level, the column and the
row:

```julia
start_server(; imagery = "https://host/tiles/{z}/{x}/{y}.png")
```

Nothing is fetched here. The server declares the template as it stands, and the browser asks for the
tiles.

`tiling` is the grid the pyramid is cut on. Leave it alone for a basemap published on the web:
`{z}/{x}/{y}` means Web Mercator, the default. Set it for a pyramid cut another way:

```julia
start_server(; imagery = Imagery(url; tiling = :geographic))
```

It takes one of three values:

- `:mercator`, the default. Web Mercator, which stops at 85.0511 degrees and draws no pole.
- `:geographic`. 256 pixel tiles, a level 0 of two columns by one row, and a doubling per level.
- `:gibs_geographic`. The EPSG:4326 grid NASA GIBS publishes: 512 pixel tiles, a level 0 of two
  columns by one row, then 3 by 2, 5 by 3, 10 by 5, and a doubling per level below that. Use it for
  a layer served from `gibs.earthdata.nasa.gov/wmts/epsg4326/`.

A basemap in the wrong projection still draws. It is stretched towards the poles and the coordinates
you send land on the wrong part of it, so check the shape of a coastline before you trust a pin.

## Tile your own raster and point at it

Cut the raster into a pyramid with `gdal2tiles.py`:

```bash
gdal2tiles.py --zoom=0-7 moon.tif moon_tiles/        # a TMS pyramid
gdal2tiles.py --zoom=0-7 --xyz moon.tif moon_tiles/  # an XYZ pyramid
```

Then name the directory:

```julia
start_server(; imagery = "/data/moon_tiles")
```

The server mounts it under `assets/imagery/` and declares that relative URL, so the page fetches the
tiles from its own origin and needs no CORS header. One server serves one such mount, so a set
holds at most one directory.

State nothing else. The server reads the directory once, at `start_server`:

- **The layout.** A `tilemapresource.xml` in the directory makes it TMS. A numeric level directory
  and no such file makes it XYZ. gdal2tiles writes TMS by default and XYZ under `--xyz`.
- **The depth.** For an XYZ directory, the largest numeric level name is the deepest level.
- **The tiling scheme and the depth**, for TMS. `tilemapresource.xml` carries both, and Cesium reads
  them out of it. So a `tiling = :geographic` given with a TMS directory warns and is dropped, and a
  `max_level` given with one is dropped without a word.

A directory that holds neither a `tilemapresource.xml` nor a numeric level directory throws, and the
message names both layouts.

## Draw no basemap at all

```julia
start_server(; imagery = :none)
```

The globe is one flat colour and there is no base layer under it. Use it for a body you have no
basemap for, and for a data-only globe where coastlines would read as meaning.

## Put satellites around the Moon

Declare the shape and the surface together:

```julia
using CesiumLink

moon = "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-moon-basemap-v0-1/all/{z}/{x}/{y}.png"

server = start_server(; ellipsoid = Ellipsoids.MOON,
                      imagery = Imagery(moon; max_level = 8,
                                        credit = "OpenPlanetary Moon basemap · LOLA/USGS"))
```

[`Ellipsoids`](@ref CesiumLink.Ellipsoids) names `WGS84`, `MOON` and `MARS`. Any other body is two
positive radii: `ellipsoid = (a = 2439700.0, b = 2439700.0)` draws Mercury.

Everything you push after this is drawn on that shape. [Work in map
coordinates](coordinates.md) covers what `ecef` does with the declared ellipsoid.

### The same globe, live

The scene below is that Moon basemap over `Ellipsoids.MOON`, with no Julia process behind it. The
page carries the basemap, the shape and the credit in its own address: `?imagery=`, `?ellipsoid=`
and `?credit=`. Drag to turn it and scroll to zoom in. Deeper tiles arrive as you go.

```@raw html
<!-- The Moon tiles come from OpenPlanetary's CDN, which nothing here controls. A grey globe on this
     page means that host is unreachable, not that the viewer is broken. -->
<iframe src="../viewer/index.html?imagery=https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-moon-basemap-v0-1/all/%7Bz%7D/%7Bx%7D/%7By%7D.png&maxlevel=8&credit=OpenPlanetary%20Moon%20basemap%20%C2%B7%20LOLA%2FUSGS&ellipsoid=1737400,1737400"
        title="An interactive Moon globe, textured with the OpenPlanetary Moon basemap"
        loading="lazy"
        style="width:100%;aspect-ratio:16/10;border:1px solid var(--vp-c-divider);border-radius:8px">
</iframe>
```

`?imagery=` names one basemap and never a set. A URL can hold a comma, so a list in that parameter
would be guesswork. A declaration from the server takes priority, so these parameters build the
globe only where no declaration does. A server on Earth always declares a set, so they reach the
globe on a page with no server behind it — the frame above is one — or against a session on another
body, which declares no basemap unless you name one. The page says in its console which parameter a
declaration overruled. `?imagery=` also reads the layout off the URL: a `{z}` in it means an XYZ
template, and anything else means a TMS pyramid.

## Sources you may add yourself

This package knows seven basemaps. Any other tile source you can legally use is one `Imagery` away.
Read that source's terms yourself: the viewer draws the credit you give it, and it knows nothing else
about your tiles.

### A key goes in the URL

A source with an API key needs no feature of this package. Put the key in the query string of
the template:

```julia
key = ENV["STADIA_API_KEY"]

start_server(; imagery = Imagery("https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png?api_key=$key";
                                 name = "Alidade Smooth", max_level = 20, backing = true,
                                 credit = "&copy; Stadia Maps, OpenMapTiles and OpenStreetMap contributors"))
```

The server declares that URL untouched. It reads one source off it,
`https://tiles.stadiamaps.com/tiles/alidade_smooth/`, and adds that alone to `trusted_origins`. The
source stops at the last `/` before the first placeholder, so the content policy of a VSCode panel
opens for that one tile directory and never for the query string.

!!! warning "A recording carries the key"
    A recording carries the declared set, and the set carries the whole URL. So a recording made with
    a private key holds that key in plain text, in its first line. Do not share such a recording. Use
    a keyless basemap for anything you publish, or strip the header first.

### A keyed provider is what works inside the VSCode panel

Reach for a keyed street map (Stadia, MapTiler, or Carto) when a scene in a VSCode tab needs one.
Keyless street maps refuse the panel, for the reason the next section gives.

**Do not restrict the key to a list of allowed domains.** The page inside the panel sends no
`Referer` header at all. A domain restriction therefore has nothing to match, and the provider
refuses every tile. Restrict the key some other way, or keep it to a machine you trust.

Test the provider in the panel before you rely on it. A provider can check the `Origin` header
instead. Stadia's tile API answers `401` to a request whose `Origin` is `vscode-webview://`, which is
the only origin the desktop panel has.

### `tile.openstreetmap.org` cannot work in the VSCode desktop panel

The OpenStreetMap standard map works in the browser host, on vscode.dev and in Codespaces. It cannot
work in the VSCode desktop panel.

Their tile usage policy asks a web page for a `Referer` header, and any other caller for a
`User-Agent` that identifies the application. A page in the panel can set neither. Chromium lets only
`http` and `https` origins produce a `Referer`, and the panel's origin is `vscode-webview://`. A page
cannot set a `User-Agent` at all.

The refusal is the trap. It arrives as a valid HTTP 200 PNG that reads "Access denied". Nothing
fails, so the basemap backing never triggers, and the reader looks at a globe tiled with those
words.

Read [the tile usage policy](https://operations.osmfoundation.org/policies/tiles/) before you declare
this source. It is a service run on donations, and it is not for heavy use.

```julia
start_server(; imagery = Imagery("https://tile.openstreetmap.org/{z}/{x}/{y}.png";
                                 name = "OpenStreetMap", max_level = 19, backing = true,
                                 credit = """&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors"""))
```

### Esri needs your own token

You can reach Esri's world imagery, but you must get your own token. Cesium ships a default ArcGIS
token whose own source marks it as for evaluation only, so do not build on it. Sign up with Esri
and declare the URL their terms give you.

### Sentinel-2 cloudless is documented, not shipped

EOX serves a cloudless Sentinel-2 mosaic of the Earth, and it looks very good. Every year still
served is CC BY-NC-SA. "Not commercially" is a restriction on your use, and no string the viewer
draws can enforce it. So this package ships no name for it. A name would put a licence breach one
keystroke from somebody who never opens a licence file.

Declare it yourself if your own use fits that licence, and credit it as EOX asks.

## The credit is yours, and it is HTML

The viewer draws the `credit` string over the bottom right of the globe. It knows nothing about your
tiles, where they came from, or what their licence asks of you. The viewer draws nothing if you
state nothing.

The string is HTML, so an attribution that must carry a link can:

```julia
credit = """&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors"""
```

The viewer sanitizes the string before it draws it, so a script tag in it never runs. The credit
names the basemap on screen. It appears while that basemap is the one the reader picked, and the
viewer rewrites the line on every switch.

## One thing that bites

**A template with no `max_level` keeps asking past the end of the pyramid.** The server probes the
depth of a directory. It cannot probe a remote host. So zoom in far enough and the browser
requests levels that are not there. That is one failed request per tile, and the globe gets no
sharper, with no message. Give `max_level` for any basemap named by a URL.

## When a basemap does not build

A source that will not build gives the bundled Earth texture, one console message naming the URL,
and no credit line. So a globe wearing Earth's coastlines under a Moon scene is explained in the
browser console.

The fallback catches a source that fails to **build**. A TMS pyramid is fetched to be built, so a
dead one falls back. A `{z}/{x}/{y}` template builds without asking for anything, so a dead host
behind it gives blank tiles and one console error per tile.

A basemap backing covers the second case, which the fallback cannot. The tiles fail one at a time,
so Cesium finds no ready tile above them and draws the pyramid underneath instead.

## Next

- [The server](../reference/server.md): `start_server`, `Imagery`, `KNOWN_EARTH_BASEMAPS`, and every
  keyword.
- [Choose the on-screen furniture](furniture.md): the picker is one item of the set.
- [Work in map coordinates](coordinates.md): degrees in, ECEF metres out, on the declared shape.
- [Record and replay a session](record-replay.md): what a recording carries of the basemap set, and
  what it drops.
