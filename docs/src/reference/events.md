```@meta
CurrentModule = CesiumLink
```

# Events and commands

Events travel up from the viewer and commands travel down to it. The listener registry connects the
two. A listener answers one `(module_id, topic)` pair, and the commands every listener contributes
to one event travel back as one batch.

The viewer forwards a pointer event only when a registered listener asks for it. The server derives
the subscription it declares from the registered set, so the two cannot disagree.

The Core raises four topics of its own. `core/pointer` is the cursor and `core/need` is the ask for
the next window. `core/clock` says which way playback runs and how fast, and `core/keyframe` says
which keyframe the clock just crossed into. The last two are what a scene builds frames ahead of
`core/need` from: see [Build the frames before they are asked for](../how-to/lazy-delivery.md).

## Listeners

```@docs
on_event
on_pointer
off_event
CesiumLink.EventListener
CesiumLink.pointer_subscription
```

## Commands and replies

```@docs
Command
Reply
command!
tooltip!
send_command
send_reply
```

## Dispatch

```@docs
CesiumLink.build_event
CesiumLink.dispatch_event
CesiumLink.answer_event
```

## The command frame

```@docs
CesiumLink.commands_message
```
