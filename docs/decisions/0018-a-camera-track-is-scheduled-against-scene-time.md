---
status: accepted
---

# A camera track is scheduled against scene time

Every command in this system applies when it arrives. That is correct for a command that
answers an event, and harmless for a declaration, because a declaration states what is true
from now on.

A camera track is neither. It states where to look **at a given moment of the scene**, and
the moment the browser is showing is not the moment a frame arrives. The recording player
makes this concrete: `RecordingTransport` schedules every recorded line on a wall-clock
timer, while the scene animates against the Core's clock, which the viewer can pause,
scrub and re-speed. Window frames do not care, because the buffer absorbs an early arrival.
A camera command applied on arrival does care. Under wall-clock scheduling, pausing a tour
leaves the camera flying around a frozen scene, and scrubbing back rewinds the scene and
not the camera.

## Decision

**A track entry carries `at`, or `after`, or neither.**

| Field | Schedule | For |
|---|---|---|
| `at` | The scene clock. Applied when the clock crosses that keyframe | A time-dynamic tour |
| `after` | The wall clock, in seconds from when the track was declared | A scene with no keyframe axis |
| neither | On arrival | Answering something the user just did; seeding the opening view |

The Core applies the latest entry whose moment has passed and that is not already applied.
Scrubbing backwards therefore returns the camera to the viewpoint that keyframe was
authored with, and Rejoin has a well-defined target at every instant: the entry that
applies now.

**`at` is an absolute keyframe index.** This is how the whole system already addresses
time — `ctx.placement(index)`, `onKeyframe(index)`, the leading keyframe axis a base rank
describes, and the glossary's own statement that keyframe indices are absolute within the
declared range. An index is also an integer a reader can follow in a recording with `jq`.

**`after` exists because a one-keyframe scene has no axis to schedule against.** A timeless
scene is one keyframe, so a keyframe-keyed track could hold one entry, and a tour over a
heatmap or a choropleth would be unbuildable. Wall time is not a fallback there. It is the
only meaningful clock, and it is safe for the same reason: a timeless scene declares the
time furniture off, and any one-keyframe scene leaves `shouldAnimate` false, so there is no
scene time and no control that could desynchronise from it.

**`after` counts from the declaration, not from the previous entry.** The recorder already
settled this for the same reason: paced against the start, a slow step does not push
everything after it later still.

**Both fields on one entry is an authoring error.** Warn and take `at`. Warn also on an
`at` beyond the declared range, which is what an author gets for keying a track by keyframe
on a timeless scene.

**A re-grid drops the track, with a warning.** Keyframe 120 means `epoch + 120 × dtSeconds`,
so only a change of epoch or of `dtSeconds` moves it. A `replace` does not: it may re-index
entities, and entity indices have nothing to do with keyframe indices. A growing
`totalFrames` does not either — a longer mission leaves keyframe 120 where it was. A server
that re-grids must re-declare the track, and must declare it **after** the window that
establishes the new grid, or the Core drops the one it just received. That is the same
ordering discipline the overlay already needs.

## Alternatives declined

**Wall clock everywhere.** Nothing to build. It is wrong in the primary use case: the
documentation page tells the reader to pause, change speed and scrub, and each of those
desynchronises the tour from the scene.

**A mission instant as the key.** More natural to author, and it survives a re-grid. It is
undefined for exactly the simplest scenes: a timeless scene names no instant, and a scene
with no `startTime` runs on a synthetic epoch.

**Auto-degrading to wall pacing when the range holds one keyframe.** One field instead of
two. It is implicit where an author needs a diagnostic: an `at` on a timeless scene would
go silent rather than say what is wrong.

**Padding a static scene with identical keyframes to manufacture an axis.** It multiplies a
raster payload by the number of viewpoints, for nothing.

**A self-paced sequence — entry `k` starts when entry `k-1`'s flight ends.** No new field
until dwell time is wanted, which is immediately, so it costs a field anyway. Cumulative
pacing also drifts.

## Deferred: following an entity

A third `destination` form, `{module, kind, idx}`, matching a float's entity anchor, would
let the camera ride a moving satellite. The mechanism is already normative:
`positionOf(kind, idx)` returns a live interpolated position, `primitives` implements it,
and `ui` calls it every frame for anchored floats.

It is deferred, and not because of the code. Under a tracked target a drag **orbits the
target**, which is something a follower plainly wants to keep doing while still following.
So the meaning of "the user touched the camera" stops being one thing, and the authority
model of ADR-0017 has to be reopened. A model settled twice is a model settled badly.

**How it will be built, when it is built: an anchor entity.** The viewer runs a
`CesiumWidget`, which carries `entities`, a `DataSourceDisplay` and `trackedEntity`, and that
display already updates every frame — `scene.ts` turns `allowDataSourcesToSuspendAnimation`
off precisely because it was rewriting `clock.canAnimate` on every tick. So an entity costs
no new subsystem and no new per-frame pump. Add one entity with `show: false` whose
`position` is a `CallbackProperty` reading `positionOf(kind, idx)`, declared changing so
`EntityView` re-reads it every frame, and hand it to `trackedEntity`. An entity that draws
nothing produces no primitive, so `scene.pick` cannot return it and no hover or tooltip has
to know it exists. The entity must be removed when the target changes or the module that
answers `positionOf` unloads, or the callback outlives what it reads.

This does not move the decision, and that is the point of writing it down. `EntityView`
drives the camera with `camera.lookAtTransform`, so the drag semantics above are Cesium's
behaviour rather than an artefact of a hand-rolled `preRender` loop, and no implementation
avoids them. What the anchor entity changes is the size of the eventual ticket: no camera
math of our own and no render-loop hook, leaving the authority question as the whole of the
work.

What will eventually justify it: an entity-following viewpoint is a function of **tick**
time, where a track is a function of keyframe time. A track can approximate following at
keyframe resolution — Julia computes a viewpoint per keyframe from the positions it already
sent, and `duration` bridges the steps — but only native following is smooth. Following also
records as one command where the approximation records as one entry per keyframe.

## Consequences

The Core holds a keyframe-indexed track and applies it on the crossings it already
dispatches. It gains no knowledge of what a scene contains.

A recorded tour is scrub-proof, which is what makes a documentation page a showcase rather
than a scene that sits there.

The player's `speed` parameter scales the delivery of recorded frames, so it scales a
keyframe-paced track, because the scene clock scales with it. It does not scale a
wall-paced track, which plays over its authored duration whatever `speed` says. This is
stated rather than fixed; a second speed control would cost more than the surprise.
