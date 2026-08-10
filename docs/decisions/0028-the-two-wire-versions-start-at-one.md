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
