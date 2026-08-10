#!/usr/bin/env julia
# The golden frame: one packed wire frame, checked in, that both languages read.
#
# Julia only builds frames and the browser only reads them, so neither side can round-trip against
# itself and nothing in either suite would catch the two drifting apart. This file is the pin. The
# Julia suite asserts the bytes it produces; the TypeScript suite decodes `tools/baseline/golden-
# frame.bin` and asserts the arrays that come out.
#
# The payload is hostile on purpose. A frame of same-dtype arrays exercises no padding at all,
# because every offset lands 8-aligned by luck and the test still looks green. This one needs a pad
# of 5, then 7, then 4, and it carries a multi-dimensional array so the row-major shape reversal is
# pinned too.
#
# Regenerate it deliberately, and only when the format changes:
#
#   julia --project=. tools/golden-frame.jl
#
# The header's key order is whatever Julia's `Dict` gives, so a rebuild may reorder it. Assert the
# header by parsing it and the region byte for byte.

using CesiumLink

const GOLDEN_PATH = normpath(joinpath(@__DIR__, "baseline", "golden-frame.bin"))

# A NamedTuple, not an array of pairs: it fixes the order the arrays are written in, and it keeps
# each element type to itself. `["a" => f64s, "b" => u8s]` promotes the UInt8 array to Float64 with
# no error at all — eight times the bytes and the wrong dtype on the wire.
golden_payload() = (;
    flags = UInt8[1, 2, 3],                 # 3 bytes at 0, so the next array needs a pad of 5
    scale = Float64[1.5, -2.5],             # at 8, and 16 bytes fill to 24 exactly
    one = UInt8[7],                         # 1 byte at 24, so the next array needs a pad of 7
    speed = Float32[1, 2, 3],               # at 32: a 4-byte element type still lands on 8
    depth = Float64[9.25],                  # at 48, after a pad of 4
    grid = Int32[1 3 5; 2 4 6],             # at 56, and row-major `shape` is [3, 2]
    label = "north",                        # a plain value keeps travelling in the header
    nested = (; count = 3, kind = "cell", ids = UInt32[10, 20]))   # at 80, found at depth

# The frame the fixture holds: a `commands` message carrying the payload above.
golden_frame() = CesiumLink.commands_message([Command("golden", "fixture", golden_payload())])

if abspath(PROGRAM_FILE) == @__FILE__
    write(GOLDEN_PATH, CesiumLink.pack(golden_frame()))
    println("wrote $GOLDEN_PATH")
end
