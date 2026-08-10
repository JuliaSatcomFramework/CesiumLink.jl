#!/usr/bin/env julia
# Print what a wire frame carries: the header as formatted JSON, and one line per array with its
# dtype, shape, offset and a short sample of its values.
#
# The wire is binary, so `less` and `jq` no longer read a captured frame on their own. This is what
# gives that back — one decoder, rather than a second wire format nobody would then keep in step.
#
#   julia --project=. tools/decode-frame.jl tools/baseline/golden-frame.bin
#   julia --project=. tools/decode-frame.jl tools/recordings/e2e-session.jsonl
#   julia --project=. tools/decode-frame.jl session.jsonl 3     # the 3rd frame
#
# A `.jsonl` recording is read line by line; anything else is one packed frame. A version 2
# recording keeps its header readable to `jq` already, so the arrays are this script's real job.

using CesiumLink
using JSON

usage() = println("""
    usage: decode-frame.jl <frame.bin | recording.jsonl> [frame index, 1-based]

    Print the header of one wire frame and every array behind it.""")

# Up to `n` values of an array, as one line.
function sample(a, n = 6)
    v = vec(a)
    isempty(v) && return "(empty)"
    head = join(first(v, n), ", ")
    return length(v) > n ? "$head, … ($(length(v)) values)" : head
end

# Every encoded array in `value`, as `(path, wire object)` pairs, deepest last.
function arrays(value, path = "", found = Pair{String,Any}[])
    if value isa AbstractDict
        CesiumLink.is_wire_array(value) && return push!(found, path => value)
        for k in sort(collect(keys(value)))
            arrays(value[k], isempty(path) ? String(k) : "$path.$k", found)
        end
    elseif value isa AbstractVector
        for (i, v) in enumerate(value)
            arrays(v, "$path[$i]", found)
        end
    end
    return found
end

function report(f::CesiumLink.Frame)
    msg = JSON.parse(f.header)
    println(JSON.json(msg, 2))
    found = arrays(msg)
    println("\nregion: $(length(f.blobs)) bytes, $(length(found)) array(s)")
    isempty(found) && return nothing
    for (path, w) in found
        # Decoded rather than read off the header, so a wrong offset or a short region shows here
        # rather than travelling on to a module.
        a = CesiumLink.decode_array(w, f.blobs)
        println("  $path  $(w["\$wire"])  shape $(Int.(w["shape"]))  off $(get(w, "off", "-"))" *
                "  →  $(sample(a))")
    end
    return nothing
end

function main(argv)
    isempty(argv) && (usage(); exit(2))
    path = argv[1]
    which = length(argv) > 1 ? parse(Int, argv[2]) : 1
    if endswith(path, ".jsonl")
        # The first line of a recording is its header, naming the version and the modules.
        lines = readlines(path)
        println(JSON.json(JSON.parse(lines[1]), 2))
        frames = lines[2:end]
        1 <= which <= length(frames) ||
            (println("\n$path holds $(length(frames)) frames"); exit(2))
        println("\n--- frame $which of $(length(frames)) ---")
        report(CesiumLink.frame_of(JSON.parse(frames[which])))
    else
        report(CesiumLink.unpack(read(path)))
    end
end

main(ARGS)
