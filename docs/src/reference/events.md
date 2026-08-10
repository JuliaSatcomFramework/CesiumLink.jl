```@meta
CurrentModule = CesiumLink
```

# Events and commands

Events travel up from the viewer and commands travel down to it. The listener registry connects the
two: a listener answers one `(module_id, topic)` pair, and the commands every listener contributes
to one event travel back as one batch.

The viewer forwards a pointer event only when a registered listener asks for it. The subscription
the server declares is derived from the registered set, so the two cannot disagree about what is
wanted.

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
