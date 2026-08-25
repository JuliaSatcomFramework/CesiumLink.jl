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
# Every answer goes in, and the waiting task picks the one that wins. A viewer that refuses answers
# far sooner than a viewer that draws: it returns before the resize, the render and the encode. So
# taking the first answer to arrive would let one viewer that cannot draw beat every viewer that
# can, on every capture, and not by chance.
#
# The entry stays until the waiting task takes it away. An answer to no entry is an answer to a
# request that already finished, and it is dropped here.
#
# The channel holds any number of answers, so this never blocks. The task that reads a client's
# socket calls it, and that task must never wait on a user's task.
function deliver_capture!(server::Server, payload, region)
    token = get(payload, "token", nothing)
    token isa AbstractString || return nothing
    waiting = lock(server.clients_lock) do
        get(server.pending_captures, token, nothing)
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
    answer = Channel{Any}(Inf)
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
        # A picture wins over a refusal, whoever answered first (ADR-0033). Read answers until one
        # carries a picture, until every viewer refused, or until the clock runs out. A viewer that
        # refuses answers sooner than a viewer that draws, so the order they arrive in says nothing
        # about which one to keep.
        deadline = time() + Float64(timeout)
        picture, refusals = nothing, String[]
        while picture === nothing && length(refusals) < reached
            left = deadline - time()
            left > 0 && timedwait(() -> isready(answer), left) === :ok || break
            given = take!(answer)
            reason = get(given, "error", nothing)
            reason === nothing ? (picture = given) : push!(refusals, string(reason))
        end
        # Report a viewer's own reason over a bare timeout: every viewer refusing is a thing the
        # caller can act on, and waiting the whole timeout out to say nothing is not.
        picture === nothing && isempty(refusals) &&
            error("no viewer answered a capture in $timeout seconds")
        picture === nothing ? Dict{String,Any}("error" => first(refusals)) : picture
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
