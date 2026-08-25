# A canvas capture is one PNG of what a viewer drew, and it is the one request and reply in the
# protocol (ADR-0033). The picture exists only in the browser, and no window can state it, so the
# server asks for it and waits. Nothing else here waits for a viewer.
#
# The PNG comes back as an encoded `u8` array in the frame's region, which the codec already carries
# in both directions. `handle_msg` unpacks the region and `decode_arrays` reads the array out of it,
# so no part of the wire format changes for this.
#
# A `Client` has no id and the server broadcasts, so every connected viewer answers one request. The
# first answer wins and the server drops the rest. Two viewers on different camera angles give an
# undefined choice between them, which is the cost of keeping a client anonymous.

# The token of one request, from a counter that runs for the whole Julia session. A late answer to a
# request that timed out therefore matches no request made after it.
const CAPTURE_REQUESTS = Threads.Atomic{Int}(0)

function capture_token()
    return string("cap-", Threads.atomic_add!(CAPTURE_REQUESTS, 1) + 1)
end

# A `core/capture` event arrived. Give the payload to the task that waits for this token.
#
# The `pop!` is what makes the first answer win, and it runs under the lock, so two answers that
# arrive together cannot both find the entry. An answer to no entry is a later answer, or an answer
# to a request that timed out; both are dropped here.
#
# The channel holds one value and the waiting task takes one, so this never blocks. The task that
# reads a client's socket calls it, and that task must never wait on a user's task.
function deliver_capture!(server::Server, payload, region)
    token = get(payload, "token", nothing)
    token isa AbstractString || return nothing
    waiting = lock(server.clients_lock) do
        pop!(server.pending_captures, token, nothing)
    end
    waiting === nothing && return nothing
    put!(waiting, decode_arrays(payload, region))
    return nothing
end

"""
    capture_canvas(server::Server, path; scale=1, timeout=10) -> String

Do not call this from an event listener. It blocks, and the server sends a listener chain's batch
only after the chain completes, so a capture inside a listener waits for an answer it holds up
itself (ADR-0033).

Ask the viewer for one PNG of its canvas, write it to `path`, and return `path`. The call blocks
until the picture arrives.

The **furniture**, the overlay and the floats are HTML above the canvas, so no capture holds them. A
capture shows the globe and everything the modules drew on it.

`scale` multiplies the drawing buffer. A capture at scale 2 of a 1400x800 canvas is 2800x1600
pixels, and the framing does not change. The viewer refuses a scale over what the graphics card
allows, and answers with the reason.

`timeout` is how many seconds to wait for an answer.

The call throws in three cases: no viewer holds this scene, no viewer answers in `timeout`
seconds, or the viewer reports that it cannot make the picture. The third case throws the viewer's
own message.

Every connected viewer answers, because the server broadcasts and a client has no name. The first
answer is the one written, and the server drops the rest. So two browsers on different camera angles
give an undefined choice between them.

The clipboard needs a real click, so only the `canvasCapture` furniture button reaches it. See
[`declare_furniture`](@ref).

```julia
capture_canvas(server, "fig.png"; scale = 2)
```
"""
function capture_canvas(server::Server, path::AbstractString; scale = 1, timeout = 10)
    scale isa Real && scale > 0 ||
        throw(ArgumentError("`scale` multiplies the drawing buffer, so it takes a number above " *
                            "zero (got $(repr(scale)))"))
    timeout isa Real && timeout > 0 ||
        throw(ArgumentError("`timeout` is how many seconds to wait for a viewer, so it takes a " *
                            "number above zero (got $(repr(timeout)))"))
    token = capture_token()
    answer = Channel{Any}(1)
    lock(server.clients_lock) do
        server.pending_captures[token] = answer
    end
    payload = try
        # Broadcast, and deliberately neither retained nor recorded. A capture is a request and not
        # scene state: a client connecting later must not be asked for a picture nobody waits for,
        # and a recording drives a viewer with no server behind it to answer to.
        reached = broadcast_all!(server,
                                 commands_message([Command(CORE_CAPTURE..., (; token, scale))]);
                                 record = false)
        reached == 0 && error("no viewer holds this scene, so nothing can make a capture")
        timedwait(() -> isready(answer), Float64(timeout)) === :ok ||
            error("no viewer answered a capture in $timeout seconds")
        take!(answer)
    finally
        # This request is over, whatever happened. Take the entry away here and nowhere else: a
        # request that timed out would otherwise leave one behind for every call.
        lock(server.clients_lock) do
            delete!(server.pending_captures, token)
        end
    end
    reason = get(payload, "error", nothing)
    reason === nothing || error("a viewer refused a capture: $reason")
    png = get(payload, "png", nothing)
    png isa AbstractArray{UInt8} ||
        error("a viewer answered a capture with neither a picture nor a reason")
    write(path, png)
    return String(path)
end
