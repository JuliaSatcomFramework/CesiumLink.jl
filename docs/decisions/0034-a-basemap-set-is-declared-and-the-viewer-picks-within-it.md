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
so a session on another ellipsoid keeps the bundled texture it wears today. It does not gain four
Earth basemaps, and it does not throw on the backing guard, so a call that works today keeps
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
| `osm` | `tile.openstreetmap.org` | 0-19 |

All four are in the default picker; the first entry of the default *set* is `blue_marble`.

The catalogue is keyed rather than a list to filter. A filter selects by name string, so a source
renamed in a later release silently matches nothing and the author gets back a basemap they meant to
drop. Picking by field cannot fail that way, and `collect` still gives the whole set in one word.

**Shipping a name ships its attribution.** This is the reason `osm` is in the catalogue rather than
in a documentation page. The licence risk that OpenStreetMap actually carries is a missing credit,
not the request; a name that carries the correct credit string makes compliance the lazy path, where
a documented URL makes every author retype an attribution and some will not.

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

**The default content policy widens by two origins.** A session that does not name its own set
declares four basemaps, so `gibs.earthdata.nasa.gov` and `tile.openstreetmap.org` reach
`trusted_origins` and from there `img-src` and `connect-src`. Naming a set narrows it again to
whatever that set holds.

**`?imagery=` still names one basemap.** ADR-0019 says what the query string is for — looking at a
pyramid you have just built, and publishing a globe that is a URL and nothing else — and neither
wants a set. A URL may legally hold a comma, so a list in that parameter would be guesswork.
