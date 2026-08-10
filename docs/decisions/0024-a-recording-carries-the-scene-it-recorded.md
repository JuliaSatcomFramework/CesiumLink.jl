---
status: accepted
---

# A recording carries the scene it recorded

A session declaration (`modules_message`, `src/messages.jl`) carries seven things:
`modules`, `ellipsoid`, `imagery`, `assets`, `lighting`, `stars` and `furniture`. It is sent once
per connection and so is never broadcast, which means the recorder never sees it. A recording's
header names the modules and nothing else.

Everything else was left to the replaying page's address bar. ADR-0019 declined putting the basemap
in the header, and `lib/core/src/query.ts` grew `?imagery=`, `?tiling=`, `?maxlevel=`,
`?credit=` and `?ellipsoid=` to stand in for it.

That split does not survive contact with a growing declaration:

- `lighting` and `stars` were added to the declaration and reached neither the header nor the query
  string. A recording of `examples/Satellites` replays as a flat-lit globe on a black sky, and
  nothing says so.
- `furniture` reaches a replay only by accident — it is *also* a retained `core/furniture` command,
  so `record!` writes it at offset zero. It arrives behind the widget, so the page flashes the
  default set on its way to the recorded one.
- Of the seven `player.html?` embeds in the documentation, all seven pass `?rec=` and `?modules=`
  and nothing else. The scene parameters were built and never used.

The cost of the address-bar approach is paid once per new declaration field, in a place nobody is
looking, and the last two fields did not pay it. A silent omission is the failure mode.

## Decision

**A recording carries the scene fields that still mean something once the recorded server is gone,
and its header is where they live.** `ellipsoid`, `furniture`, `lighting` and `stars` are written by
`record!` and rebuilt into the declaration by `declarationOf`.

The `furniture` is in the file twice, in the header and as the retained command under it. That is
the duplication the live declaration already carries, for the reason it carries it: the viewer
builds the declared set before it paints, and the command that follows says the same thing, which
the viewer applies as a no-op. The retained command stays the one source of the set — the header
field is read from it.

**What the recording does not carry is where files now are.** `modules`, `assets` and the recording
itself are same-origin paths into a server that has stopped. The replaying page is the only thing
that knows where those directories were copied to, so `?rec=`, `?modules=` and `?assets=` stay query
parameters. The header already draws this line for modules — the id and `apiVersion` are recorded
because they are the session, the URL is rebuilt from `?modules=` because it is the deployment — and
this extends that line to everything else rather than inventing one.

**A basemap travels only when its tiles do.** `imagery` is recorded when it is an absolute URL, and
when it is `false`. A directory the server mounted is declared as `assets/imagery/…`, which resolves
against the replaying page and answers 404: an XYZ template that fails draws a bare globe and one
console error per tile, with no fallback (`lib/core/src/scene.ts`). Recording that path would
replace today's bundled Earth with a worse picture, so `record!` drops it and warns.

**On the player, a query parameter beats the header.** This is the opposite of the live rule in
ADR-0019, and for the reason that rule exists: there, a server owns the session and is present to
own it. Here the header is a file describing a session that has ended, and the reader typing into
the address bar is repairing it — usually pointing `?imagery=` at wherever the mounted tiles were
copied. `index.html` is unchanged: a live declaration still beats the address bar.

**A `replay` through a Julia server ignores the recorded scene.** A server fixes its `ellipsoid`,
`imagery`, `lighting` and `stars` at `start_server`, because the viewer builds its globe from the
declaration and changing one mid-session leaves the scene on the shape it declared at startup. Replaying a Moon session
stays `start_server(; ellipsoid, imagery)` followed by `replay(...)`.

## Why this is not a format break

The fields are optional and additive. A reader that does not look for them behaves exactly as it did,
so `RECORDING_VERSION` stays 2 and the version gate is untouched. No recording is committed to the
repository: the documentation's recordings are generated at build time.

ADR-0019 declined this move on two grounds. The `RECORDING_VERSION` bump turns out not to be needed.
"A rule for a path that does not resolve on the replaying machine" was the real objection, and it is
answered above — it applies to one field of five, and the answer is to not record that one.

## Alternatives declined

**A query parameter per declaration field.** `?lighting=`, `?stars=`, and one more with each field
added. It puts the burden on every reader who embeds a player, to restate what the recording already
knew, and its failure mode is the one that produced this ADR: the parameter that never gets written.

**Record the whole declaration verbatim.** Simpler to write and wrong for three of the fields. The
module URLs, the `assets` map and a mounted `imagery` URL are all same-origin paths into the recorded
server. Replaying them points a page at directories that are not there.

**Have `record!` copy the mounted tile directory beside the recording.** A recording is one file that
travels; making it sometimes a file and sometimes a tree costs a layout, a copy of a basemap that can
run to gigabytes, and a staging step in every consumer. `?imagery=` already names relocated tiles in
one parameter.

## Consequences

`lighting` and `stars` work in a replay, and the furniture is right on the first paint. The
documentation's example pages get whatever the recorded session declared without restating it in an
`<iframe src>`.

The player builds its widget from `transport.declaration` alone, rather than from the declaration for
the modules and the query string for the globe. The two sources are merged once, in `declarationOf`.

A basemap that was a mounted directory still replays as the bundled Earth texture. It now says so at
record time instead of at nobody.
