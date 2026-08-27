---
status: accepted
---

# A failed basemap falls back to Earth

A declared basemap can fail to build. The host is dead, the URL answers 403, the directory holds no
`tilemapresource.xml` where the layout said there is one. The server never fetches a URL — there is
no network call at `start_server` — so the browser is where such a source is first found out.

The viewer has to draw something.

## Decision

**A basemap that will not build gives the bundled Earth texture, and one loud console message.** The
message names the URL, states that the globe below wears the bundled texture, and states that this is
not what the scene declared.

The scene is the point and the texture is decoration. A globe wearing the wrong face still shows the
satellites, the ruler, the overlay and the clock, which is what the reader came for.

**The credit is suppressed after a fallback.** A credit describes the declared source. The globe now
wears the bundled one, which that credit does not cover, so leaving it up would attribute Earth's
coastlines to whoever made the Moon tiles.

ADR-0034 keeps this rule for the construction fallback and does not extend it to a basemap backing. Under a
backing the credit names the basemap the reader picked, and the basemap backing is never credited. The
bundled texture is public domain and asks for no attribution, so a globe that shows it under a dead
source is never under-credited. Naming it as well would need the viewer to know which layer the
reader is looking at, and the only signal for that is the tile count this record refuses.

## The limit: this catches construction only

`TileMapServiceImageryProvider.fromUrl` fetches `tilemapresource.xml` and rejects, so a TMS source is
covered. `UrlTemplateImageryProvider` constructs synchronously and never throws, so an XYZ template
pointing at a dead host gives blank tiles and one console error per tile — no fallback, and no Earth.

This is a stated limit, not an oversight. Falling back on a tile-failure count is a heuristic with no
obvious number in it: a pyramid legitimately answers 404 for a tile outside its coverage, and a
threshold that is wrong either way turns a working scene into a fallback or hides a broken one.

ADR-0034 closes this limit, and it needs no threshold. A basemap may name a **basemap backing**: the bundled
Earth texture, drawn as a second layer beneath it. Cesium walks a failed tile up to a ready
ancestor. When it finds none, that layer draws nothing for that tile and the layer below shows
through (`TileImagery.js`). So a dead XYZ host gives Earth instead of a hole, a network that drops
mid-session repairs itself, and a network that comes back repairs itself too. No tile is counted.

The refusal above still stands for what it refused. Nothing decides that a source has *failed*.
Both layers stay in the scene, and the picture is whatever the tiles that arrive make it.

## Alternatives declined

**A blank globe.** It is honest, and it looks broken to anyone who does not open the console. The
console is where the diagnosis is; the screen is where the scene is. Putting the failure only on
screen loses the scene and says nothing about why.

**Refuse the session.** It costs the whole scene — the data, the overlay, the clock — over the
decoration. Nothing about a missing texture makes the payload wrong.

**Fall back silently.** This is the risk the decision accepts, so the message is the price of it: a
Moon scene quietly wearing Earth's face is a picture that lies, and the console message is the only
thing standing between a reader and believing it. That is what makes the wording worth care rather
than a bare `catch`.

## Consequences

A globe with no base layer is now reachable two ways, and they mean opposite things: `imagery =
:none` is a choice (ADR-0019), and blank tiles under an XYZ template are a symptom. The console
tells them apart, and nothing on screen does.

`imagery: false` never falls back. There is nothing to construct, so there is nothing to fail.
