---
status: accepted
---

# A basemap set is declared, and the viewer picks within it

The bundled Earth texture is Cesium's NaturalEarthII pyramid: levels 0 to 2, 42 tiles, 608 KB. Level
2 is the whole Earth at 2048x1024 pixels. Past a continent it is blur, which is the state a reader
first meets when they zoom in on a ground track.

ADR-0019 fixed the basemap for the session and declined a picker by name. Its argument was the body:
a person who switches away from the declared basemap is looking at a globe that disagrees with the
coordinates drawn on it, and every rule for that is either a refusal or a wrong picture.

That argument does not reach a set of basemaps that are all for the same body. Swapping Earth for
sharper Earth disagrees with nothing.

## Decision

**The server declares a set of basemaps, all for the declared body, and the viewer picks within the
set.** ADR-0019's rule is kept rather than overturned: the server still owns which basemaps exist,
so the mismatch it refused is impossible by construction rather than forbidden by a rule somebody
has to enforce. A session that names one basemap gets one, and no picker.

`imagery` on the wire becomes a list. Entry 0 is what the globe wears at startup. The three states
of ADR-0019's table are unchanged in meaning; the third one widened from an object to an
object-or-list.

**A basemap may name a basemap backing, and a basemap backing is not a stack.** `backing` puts the bundled Earth
texture beneath a source, so that a source which stops answering leaves a globe rather than a hole.
It carries no alpha, no author-chosen order and no identity: it is a property of one basemap, not a
second basemap. The stack ADR-0019 declined needed layer identity, ordering and blending on the
wire, and none of the three appears here.

This closes the limit ADR-0020 stated. That record could not fall back from an XYZ template at a
dead host, because the only signal was a count of failed tiles and no threshold is right. A basemap backing
needs no threshold: Cesium walks a failed tile up to a ready ancestor, finds none, and draws the
layer below (`TileImagery.js`). Mid-session network loss heals itself, and coming back heals itself
too.

**A basemap backing is the bundled Earth texture and nothing else.** `backing = true` on a session whose
ellipsoid is not Earth throws at `start_server`. ADR-0020 named the failure this prevents — a Moon
scene quietly wearing Earth's face is a picture that lies — and here it is cheap to make impossible,
because Julia knows the ellipsoid before anything is declared.

**Nothing travels upward.** Which basemap is on screen is the viewer's own business, as the camera
is (ADR-0017). There is no event and no server-side field. A recording therefore carries the
declared set, not the live choice, and a replay opens on the same default with the same set to pick
from.

**The credit names the selected source and not the basemap backing.** ADR-0020 suppresses a credit after a
fallback because a credit describes the declared source. The same reasoning applies while a basemap backing
is drawn, but the reverse case does not: the bundled texture is public domain and needs no
attribution, so a globe wearing it under a failed source is never under-credited. The line is
rewritten on every switch.

**The picker is furniture, and it hides itself below two entries.** `basemap` defaults to on and
follows `cameraFollow`'s stated rule — the item hides itself while there is nothing to say, so no
author has to think about it. Naming one basemap is therefore the whole opt-out: it removes the
network, the picker and the button in one line.

**An absent `imagery` is the default set**, `blue_marble` backed by `offline_natural_earth`. This is
the one behaviour change a reader will notice on upgrade, and it is why the release is 0.2.0.

**An absent `imagery` on a body that is not Earth declares nothing.** The default set is Earth's,
so a session on another ellipsoid keeps the bundled texture it wears today. It does not gain the
Earth default set, and it does not throw on the backing guard, so a call that works today keeps
working. `is_earth` compares the semi-major axis within one per cent, which refuses the Moon and
accepts GRS 80.

## What ships as a known basemap

`KNOWN_EARTH_BASEMAPS` holds ready-made values so that an author writes a name rather than a URL, a
tiling scheme, a depth and an attribution line.

| Name | Source | Levels |
|---|---|---|
| `offline_natural_earth` | the pyramid inside the viewer | 0-2 |
| `blue_marble` | GIBS `BlueMarble_ShadedRelief_Bathymetry` | 0-8 |
| `blue_marble_relief` | GIBS `BlueMarble_ShadedRelief` | 0-8 |

The default *set* is every basemap the catalogue holds, and the picker offers all of it. An entry
costs nothing until the reader picks it: `buildBaseLayers` (`lib/core/src/scene.ts`) builds a tile
provider for entry 0 and for no other entry, so a reader who never opens the picker never causes a
later entry to fetch a tile or open a connection.

The catalogue is keyed rather than a list to filter. A filter selects by name string, so a source
renamed in a later release silently matches nothing and the author gets back a basemap they meant to
drop. Picking by field cannot fail that way, and `collect` still gives the whole set in one word.

**Shipping a name ships its attribution.** A catalogue entry carries the credit string its source
asks for, which is what puts a name in the catalogue rather than in a documentation page. The name
makes compliance the lazy path, where a documented URL makes every author retype an attribution and
some will not.

**A licence that restricts the use, rather than asking for a credit, stays out.** Sentinel-2
cloudless is the case: every year still served is CC BY-NC-SA, and no string the viewer renders can
enforce "not commercially". Shipping that name would put a licence breach one keystroke from
somebody who never opens a licence file, and their employer would pay for it. It is documented
instead.

## Alternatives declined

**A picker over anything, not over a declared set.** This is ADR-0019's original refusal and it
still stands. The set is what keeps the basemap and the ellipsoid in agreement.

**A probe instead of a basemap backing.** Fetch one tile at startup, select the online basemap if it
answers. It needs a probe URL, a timeout and a rule for what counts as an answer — a heuristic of
the kind ADR-0020 refused — and it still leaves a bare globe when the network drops mid-session,
which is the case the feature exists to serve.

**Deeper tiles as a lazy artifact.** A Natural Earth pyramid to level 5 is about 25 MB, and Blue
Marble to level 7 about 600 MB. Both were measured and both were declined: the artifact is bytes we
host and version forever, and it stops at the level its source raster stops at. GIBS answers level 8
from NASA's own infrastructure with no key, and the basemap backing makes the offline case work anyway.

**The OpenStreetMap standard map.** OpenStreetMap's tile CDN answers a request that carries no
`Referer` with an "Access denied" picture. A VSCode webview can never send a `Referer`, because
Chromium only allows `http` and `https` origins to produce one and the webview's origin is
`vscode-webview://`. The blocked answer is a valid HTTP 200 PNG, so the basemap backing never
triggers and the reader simply sees "Access denied" tiles. CesiumLink cannot satisfy that policy
from a page, because the policy asks for an identifying `User-Agent` and only a server can send
one. It joins Sentinel-2 cloudless: documented, not shipped.

**An online Natural Earth.** There is none worth having. The source raster is 21600x10800, so
Natural Earth II stops at level 5 whoever serves it, and the only keyless hosts are personal
servers. `blue_marble_relief` covers the same calm flat look and reaches level 8.

## Consequences

`PROTOCOL_VERSION` moves to 2. A viewer that reads `imagery` as an object would take a list as a
source with no URL and draw a wrong globe with no message, which is the failure ADR-0020 exists to
prevent. The handshake turns that into a closed socket. The pair can only occur through
`cesiumLink.distDir`, which pins a hand-chosen viewer tree against a live server.

`RECORDING_VERSION` stays 2. A recording is a file format and not a handshake, and an array is not
an object, so a reader tells the two shapes apart with no number at all. Bumping it would refuse
every recording already on disk.

**The player does not take the online default.** A header with no `imagery` now only ever comes from
a session that did not use the default set, because a default set travels: both of its entries have
tiles a replaying page can reach. Painting an online basemap onto exactly those files would show a
sharper globe than was recorded, which is what ADR-0024 is against.

**The content policy widens by tile directory, not by host.** `trusted_origins` reads the directory
each entry's URL points at (`csp_source`), and not the host under it. The default set opens five
tile directories, four on `gibs.earthdata.nasa.gov` and one on `tiles.emodnet-bathymetry.eu`, and
from there `img-src` and `connect-src`; the pyramid inside the viewer names no directory at all.
Naming a set narrows the policy to whatever that set holds.

**`?imagery=` still names one basemap.** ADR-0019 says what the query string is for — looking at a
pyramid you have just built, and publishing a globe that is a URL and nothing else — and neither
wants a set. A URL may legally hold a comma, so a list in that parameter would be guesswork.

## Amendment: a fourth basemap, and it is the default

The catalogue holds four. `blue_marble_labeled` is NASA Blue Marble with OpenStreetMap place labels
drawn over it, from `github.com/freetiler/nasa-bluemarble-labeled` over jsDelivr, and it reaches
level 8 as the two GIBS entries do.

| Name | Source | Levels |
|---|---|---|
| `blue_marble_labeled` | `freetiler/nasa-bluemarble-labeled` over jsDelivr | 0-8 |

**The default set is `blue_marble_labeled` backed by `offline_natural_earth`.** The set is still two
entries, and `blue_marble` stays in the catalogue as a name an author can pick. A reader who opens a
default session reads place names on the globe, which a satellite mosaic alone does not give them.

Every statement above that names `blue_marble` as the default now names `blue_marble_labeled`. Two
consequences move with it:

- A default session reaches `cdn.jsdelivr.net`, not `gibs.earthdata.nasa.gov`. That one origin is
  what `trusted_origins` carries, and from there `img-src` and `connect-src`.
- The credit line reads `FreeTiler.com | NASA | OSM Contributors`, which is the attribution the
  source asks for. The imagery is under NASA's open-data policy and the labels are under ODbL.

**The URL pins a commit, not the branch.** jsDelivr serves the branch head otherwise, so the tiles
could change under a reader with no release behind the change. The pinned URL also answers
`immutable, max-age=31536000`, where the branch URL answers `max-age=604800`.

**The tileset is not vendored.** It is 421 MB, and ADR-0027 keeps the viewer artifact to bytes worth
hosting forever.

## Amendment: six basemaps, and ASTER Colour Relief is the default

`blue_marble_labeled` leaves the catalogue and never reaches a release. Its place names are painted
into the JPEG, so no other basemap can borrow them and no reader can turn them off. A separate
annotation layer draws names that every basemap can wear, and it has its own record.

The catalogue holds six. Three are new.

| Name | Source | Levels | Credit |
|---|---|---|---|
| `aster_colour_relief` | GIBS `ASTER_GDEM_Color_Shaded_Relief` | 0-12 | `NASA EOSDIS GIBS` |
| `aster_grey_relief` | GIBS `ASTER_GDEM_Greyscale_Shaded_Relief` | 0-12 | `NASA EOSDIS GIBS` |
| `emodnet_baselayer` | EMODnet Bathymetry `2020/baselayer` | 0-15 | `EMODnet Bathymetry (CC BY 4.0)` |

**The default set is all six**, in this order: `aster_colour_relief`, `aster_grey_relief`,
`blue_marble`, `blue_marble_relief`, `emodnet_baselayer`, `offline_natural_earth`. Every statement
above that names `blue_marble` as the default now names `aster_colour_relief`, and so does every
statement in the amendment before this one.

**ASTER Colour Relief leads because entry 0 is the one entry a session opens a host for.** It is
the sharpest map in the catalogue and it stands alone on `gibs.earthdata.nasa.gov`, so a reader who
opens the page and picks nothing reaches that host and no other. EMODnet Baselayer is the better
map — it is global, it draws the sea floor, and it reaches level 15 — and
`tiles.emodnet-bathymetry.eu` serves it, so it sits fifth and one pick away. The offline pyramid
sits last: the calm map that opens no host at all, there for the reader to fall back on.

**ASTER Colour Relief draws one flat blue for the ocean.** It is a relief map of the land and it
carries no sea-floor colour. That is the known cost of the pick, and `blue_marble` and
`emodnet_baselayer` both stay in the catalogue for a reader who wants the water.

**The GIBS path order is `{z}/{y}/{x}` and EMODnet's is `{z}/{x}/{y}`.** A WMTS REST path names
TileMatrix, TileRow, TileCol, which is level, row, column. A template reaches the browser as it
stands, so a swapped pair draws a scrambled globe rather than an error.
