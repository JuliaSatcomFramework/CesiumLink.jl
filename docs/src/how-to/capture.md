# Take a picture of the globe

You want a still of the scene: a figure for a paper, a slide, a bug report. A **canvas capture** is
one PNG of the viewer's canvas. Julia asks for one and writes the file, and a furniture button
copies one to the clipboard.

## What a capture holds

The canvas, and nothing else. The **furniture**, the overlay **controls** and the **floats** are
HTML boxes above the canvas, so they are never in a capture.

This is a property of where they sit, not a setting. The timeline was never drawn on the canvas, so
there is nothing to take off it. A capture shows the globe with every entity the modules drew on it.

## Ask from Julia

```julia
capture_canvas(server, "fig.png"; scale = 2)
```

The call blocks. It writes the file and returns the path.

!!! warning
    Do not call this from an event listener. The server sends a listener chain's command batch only
    after the chain completes, so a capture inside a listener waits for an answer it holds up
    itself.

Every connected viewer answers, because the server broadcasts and a client has no id. A picture
wins over a refusal, whoever answered first.

When two viewers both draw, both answers are valid pictures and the server keeps whichever arrived
first. The camera belongs to the user, so the two can show different views, and nothing says which
of them you get. Aim this at a session with one browser open.

The call throws in four cases: no viewer receives the request, none answers inside `timeout`
seconds, every viewer refuses, or one viewer refuses and another never answers. A refusal carries
the viewer's own reason.

The fourth case waits the whole `timeout` out, then reports the refusal. A picture beats a refusal,
so the call waits for the silent viewer as long as it may still draw one.

## Ask for more pixels

`scale` multiplies the drawing buffer. A capture at scale 2 of a 1400x800 canvas is 2800x1600
pixels.

More pixels is not more view. The framing is exactly what you see: scale sharpens the same picture,
it does not widen it. To take in more of the globe, move the camera or make the window bigger.

The viewer refuses a scale its GPU cannot draw, and the reason names the size the call asked
for. Nothing comes back blank.

## Put the button on screen

The `canvas_capture` furniture item is off by default, so a scene asks for it:

```julia
declare_furniture(server; canvas_capture = true)
```

- A left click copies a capture to the clipboard at scale 1.
- A right click opens a popup that holds a filename, a scale, a `Copy` button and a `Download`
  button.
- A long press does what a right click does, for a touch screen.

The viewer keeps none of it. There is no stored setting, and the popup starts from its defaults
every time.

## When the clipboard does not work

The browser gives the clipboard only to a secure context. So `localhost` and HTTPS reach it, and
plain HTTP to another machine does not. A left click opens the popup instead when the clipboard is
out of reach, and the popup shows the `Copy` button disabled with the reason.

The clipboard also needs a real click. Julia therefore cannot copy to the clipboard, and
`capture_canvas` writes a file instead.

## What a capture is not

A capture is a request, and not scene state. The server retains none of it and a **recording**
holds none of it: a recording drives a viewer with no server behind it, which has nothing to answer
to.

See [`capture_canvas`](@ref) and [`declare_furniture`](@ref).
