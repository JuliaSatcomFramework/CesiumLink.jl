---
status: accepted
---

# The protocol version and the module API version both start at 1

`PROTOCOL_VERSION` and `MODULE_API_VERSION` are both 1. `RECORDING_VERSION` is 2 and is not part of
this decision.

## Why

Both numbers are handshake integers. Their whole job is to close a socket, or skip a module, when the
two sides disagree about a contract. A number is only meaningful against something published to
compare it with, and nothing is published.

Earlier records in this set describe each number moving to 2. Those revisions are the history of the
contract, and the contract is what they describe; the integer that announces it starts where a first
release starts.

## Amended by ADR-0034: the premise expired

The reason above was "nothing is published". That is no longer true. The package is released, and
the editor extension is released on its own line — the two version numbers drift.

`PROTOCOL_VERSION` moves to 2 with ADR-0034. It has a job after all, and the job is narrow. The
extension does not carry a viewer: it reads `dist` out of the discovery file and loads the bundle
from that tree, so a server and a viewer normally ship as one package version and cannot disagree.
One path breaks that. The `cesiumLink.distDir` setting pins a hand-chosen viewer tree against a
manually entered server. That pair is what the handshake closes.

`MODULE_API_VERSION` stays 1. Nothing in ADR-0034 touches the module API.

`RECORDING_VERSION` stays 2, for the reason stated below. ADR-0034 widens the header field `imagery`
from an object to an object-or-list, and a reader tells the two shapes apart with no number at all.

A player released before ADR-0034 does not, and the number cannot warn it: it accepts the file,
reads the list where it expects an object, and draws the bundled Earth texture with one console
error. That is the fallback every unbuildable source takes (ADR-0020), so such a player shows a
globe and the scene on it, with the wrong face. A number that refused the file instead would show
nothing at all, which is worse, and it would refuse every older file as well.

**The contract that can really drift has no number.** The extension reads the discovery file, and
the two are versioned apart. Every key the extension reads is therefore additive-only, and a server
must keep filling the keys an older extension knows. `trustedOrigins` is the one that matters for
ADR-0034: the server writes every declared basemap origin into it, so an extension that reads only a
single `imagery` object still builds a policy that lets the tiles through.

## Consequences

Two documents state a version in their title: the wire protocol reference and the module API
reference. Both say 1.

`RECORDING_VERSION` stays 2, and the recording format is untouched. It is a file format rather than a
handshake, a recording on disk states its own number, and `replay` reads that number. Changing it
would break files, which is the opposite of what this record is for.

The version 1 recording path is deleted rather than renumbered: `is_wire_array` recognises an array by
its offset into the region and by nothing else, `decode_array` reads from the region alone, `replay`
accepts one version, and `frame_of` reads the blobs a line carries. No file in this repository is
written the older way.

`decode_arrays`, `decode_array` and `is_wire_array` stay. They are the general decoder, the
reference documents them, and an event arriving from the viewer goes through them.

Deleting the base64 branch exposed that the event path never carried a region: `build_event` decoded
against an empty one, so an upward array could only ever have arrived base64. `handle_msg` now splits
an inbound frame the way it splits an outbound one and hands the region down. Nothing the viewer
sends carries an array today, so this changes no behaviour — it makes the symmetry the protocol
claims true in both directions.
