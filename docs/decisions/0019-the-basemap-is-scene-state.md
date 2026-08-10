---
status: accepted
---

# The basemap is scene state

The globe wore one texture and nothing could change it: `lib/core/src/scene.ts` built the
bundled NaturalEarthII pyramid and no caller had a say. A session already declares its `ellipsoid`,
so a scene can put satellites around the Moon and still draw Earth's coastlines under them.

Letting the basemap be chosen raises the question every other piece of viewer state has already
answered: who owns it. ADR-0007 makes the server authoritative over the **scene**. ADR-0013 and
ADR-0017 carve two things out of that as **user state** — a float's rect, and the camera.

## Decision

**The basemap is scene state.** The server names it once, in the `modules` declaration beside
`ellipsoid`, and it is fixed for the session. Nothing travels upward and nothing changes it after
the declaration arrives.

The declaration holds three states, and they differ:

| `imagery` | The globe wears |
|---|---|
| absent | the bundled Earth texture, which is the behaviour every earlier session had |
| `false` | nothing: no base layer, one flat colour |
| an object | the source it names |

**A page may name a basemap in its own address, and a declaration beats it.** `index.html` and
`player.html` read `?imagery=`, `?tiling=`, `?maxlevel=`, `?credit=` and `?ellipsoid=`. Those parameters apply
only where no server declares a basemap, so they extend the reach of the decision rather than
contradict it: they are how a person looks at a pyramid they have just built, and how the
documentation publishes a live Moon globe that is a URL and nothing else.

## Why the camera came out the other way

ADR-0017 made the camera user state, and the two decisions read as inconsistent until you ask what
each thing is.

The camera is something a person moves. Two people watching one session from two angles see the
same scene, so nothing is filtered by where the camera stands, and a viewpoint the server sends is
an offer.

The basemap is a property of the body the scene stands on. It is chosen with the `ellipsoid`, and
the two must agree: a person who switches the basemap away from the declared one is looking at a
globe that disagrees with the coordinates drawn on it. That is not a second point of view on one
scene. It is a wrong picture.

## Alternatives declined

**User state, with a picker.** It would need switch chrome, a wire message, and a rule for what
happens when the chosen imagery stops matching the declared ellipsoid. The rule is the problem:
every answer to it is either "refuse the switch", which is the decision above with more machinery,
or "draw the disagreement", which is the failure the feature would exist to prevent.

**A stack of layers rather than one.** A module already drapes its own raster through
`scene.imageryLayers`, which is how `heatmap` works, and that stays a module's job. A declared stack
needs layer identity, ordering and blending on the wire, plus a rule for how a declared layer and a
module's layer interact. One base layer needs none of it.

**The basemap in the recording header.** The recording does not carry the ellipsoid either. Both
stay caller options, so a Moon replay is `start_server(; ellipsoid, imagery)` followed by
`replay(...)`, where a real server mounts the directory as usual. Putting either in the header needs
a `RECORDING_VERSION` bump and a rule for a path that does not resolve on the replaying machine.

ADR-0024 reverses this for the standalone player: the header carries the ellipsoid, and it carries
the basemap when the tiles travel with the file. The version bump turns out not to be needed, and
the rule for a path that does not resolve is to record no basemap at all. A `replay` through a Julia
server is unaffected — a server still fixes its globe at `start_server`.

## Consequences

`imagery = :none` is a real value, not the absence of one. It is the honest declaration for a body
with no basemap, and it is how you look at a data-only globe where coastlines would read as meaning.
It also gives the fallback of ADR-0020 a deliberate twin: a blank globe can be a choice rather than
a symptom.

The declaration carries the layout, so the browser sniffs nothing. A server that mounts a directory
reads `tilemapresource.xml` or the numeric level directories once, at `start_server`. A page reading
its own address has no directory to look inside, so it reads the layout off the URL: `{z}` in it
means XYZ, anything else means a TMS pyramid.

The three hosts learn the basemap two ways. `index.html` and `player.html` take a declaration or
their own query string; the VSCode host has no address bar and takes the declaration alone.

A credit is one optional string on the declaration, drawn by the Core as text. Whoever starts the
server owns whether it is legally correct.
