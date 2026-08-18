# Choose what the globe is textured with

The globe wears the viewer's bundled Earth texture unless you say otherwise. `imagery` takes a URL,
a directory of tiles on disk, an [`Imagery`](@ref) for the rest, or `:none`. The server declares it
once, and it holds for the session.

## 1. Point at a basemap on the web

Give the URL template of a tile pyramid. `{z}`, `{x}` and `{y}` are the level, the column and the
row:

```julia
start_server(; imagery = "https://host/tiles/{z}/{x}/{y}.png")
```

Nothing is fetched here. The server declares the template as it stands, and the browser asks for the
tiles.

`tiling` is the projection the pyramid is cut in. Leave it alone for a basemap published on the web:
`{z}/{x}/{y}` means Web Mercator, the default. Set it for a pyramid cut the other way:

```julia
start_server(; imagery = Imagery(url; tiling = :geographic))
```

A basemap in the wrong projection still draws. It is stretched towards the poles and the coordinates
you send land on the wrong part of it, so check the shape of a coastline before you trust a pin.

## 2. Tile your own raster and point at it

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
tiles from its own origin and no CORS header is needed.

State nothing else. The server reads the directory once, at `start_server`:

- **The layout.** A `tilemapresource.xml` in the directory makes it TMS. A numeric level directory
  and no such file makes it XYZ. gdal2tiles writes TMS by default and XYZ under `--xyz`.
- **The depth.** For an XYZ directory, the largest numeric level name is the deepest level.
- **The tiling scheme and the depth**, for TMS. `tilemapresource.xml` carries both, and Cesium reads
  them out of it. So a `tiling = :geographic` given with a TMS directory warns and is dropped, and a
  `max_level` given with one is dropped without a word.

A directory that holds neither a `tilemapresource.xml` nor a numeric level directory throws, and the
message names both layouts.

## 3. Draw no basemap at all

```julia
start_server(; imagery = :none)
```

The globe is one flat colour and there is no base layer under it. Use it for a body you have no
basemap for, and for a data-only globe where coastlines would read as meaning.

## 4. Put satellites around the Moon

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

The globe's own credit is plain text, so the link belongs here: the Moon basemap is
[OpenPlanetary](https://www.openplanetary.org/), from LOLA/USGS data.

`?imagery=` reads the layout off the URL: a `{z}` in it means an XYZ template, and anything else
means a TMS pyramid. A server that declares a basemap wins, so these parameters build the globe only
where no declaration does.

## 5. Light the globe and put a sky behind it

Two more keywords change what the globe looks like. Neither touches the basemap:

```julia
start_server(; lighting = true, stars = true)
```

`lighting` lights the globe from the sun at the clock's time, so a terminator runs across it and the
night side goes dark. `stars` draws the star field, the sun and the moon around it, at that same
time. Both are off by default. The [Satellites](../examples/satellites.md) example turns both on.

Four conditions to know:

- **Leave `lighting` off for a scene whose colours carry its data.** A shaded globe dims a value by
  where it sits rather than by what it says.
- **The sun stands where the clock says.** Give your windows a real `start_time`, or the viewer picks
  a synthetic epoch and the terminator lands somewhere arbitrary — see [`push_window`](@ref).
- **A star field needs Earth.** The field is Cesium's own, and Cesium draws it on a WGS84 globe only.
  A session on another body gets black whatever `stars` says.
- **Lighting needs Earth as well.** Cesium computes the sun's direction from Earth's position and
  expresses it in Earth's rotating frame, whatever ellipsoid the session declares. On another body
  the terminator is Earth's, in both where it falls and how fast it sweeps. Leave `lighting` off
  there.

## Two things that bite

**A template with no `max_level` keeps asking past the end of the pyramid.** The server probes the
depth of a directory, and it cannot probe a remote host. So zoom in far enough and the browser
requests levels that are not there: one failed request per tile, and the globe stops sharpening
without saying why. Give `max_level` for any URL-backed basemap.

**The credit is yours.** The viewer draws the `credit` string over the bottom right of the globe, as
text and nothing else. It knows nothing about your tiles, where they came from, or what their
licence asks of you. Nothing is drawn if you state nothing.

## When a basemap does not build

A source that will not build gives the bundled Earth texture, one console message naming the URL,
and no credit line. So a globe wearing Earth's coastlines under a Moon scene is explained in the
browser console.

The fallback catches a source that fails to **build**. A TMS pyramid is fetched to be built, so a
dead one falls back. A `{z}/{x}/{y}` template builds without asking for anything, so a dead host
behind it gives blank tiles and one console error per tile.

## Next

- [The server](../reference/server.md) — `start_server`, `Imagery`, and every keyword.
- [Work in map coordinates](coordinates.md) — degrees in, ECEF metres out, on the declared shape.
- [Record and replay a session](record-replay.md) — a recording carries neither the shape nor the
  basemap, so a Moon replay states both again.
