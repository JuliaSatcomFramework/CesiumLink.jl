```@meta
CurrentModule = CesiumLink
```

# Recording

A **recording** is every wire frame a server broadcast, written to a file in order, each stamped
with how long into the session it was sent. A header names the modules that session declared and
the scene it declared them into.

The file is JSON Lines. A line holds the frame's header as an inline object and its region as base64
beside it, so `jq` reads one directly.

Replaying a recording drives a real viewer through the session with whatever produced the data
absent. A recording holds everything the session sent, the answers its listeners gave included. A
replay does not *run* those listeners, so a control the recorded overlay declares reaches nobody
unless a listener is registered against the replaying server.

## Recording a session

```@docs
record!
stop_recording!
```

## Replaying one

```@docs
replay
```
