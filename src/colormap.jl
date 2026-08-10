# Julia decides every colour in the scene, so a colormap is an ordinary Julia value: CesiumLink
# neither registers nor names one. Three forms are understood — a vector of colours spread evenly
# over [0, 1], a vector of explicitly placed `fraction => colour` stops, and anything supporting
# `get(cmap, t)`, which is what makes a ColorSchemes.jl scheme work unchanged.
#
# The only colour dependency is ColorTypes.jl: the type layer every Julia colour package already
# agrees on. Which colormap to use is the caller's business.

"""
    RGBA8

One colour as it travels: red, green, blue and alpha as bytes.
"""
const RGBA8 = NTuple{4,UInt8}

byte(x::Real) = round(UInt8, clamp(float(x), 0.0, 1.0) * 255)

"""
    rgba8(c) -> RGBA8

One colour as bytes. A colour is a ColorTypes value, a `"#rgb"`/`"#rrggbb"`/`"#rrggbbaa"` string, or
a tuple of `0..255` integers with or without an alpha component.
"""
rgba8(c::Colorant) = (byte(red(c)), byte(green(c)), byte(blue(c)), byte(alpha(c)))
rgba8(c::RGBA8) = c

function rgba8(s::AbstractString)
    h = startswith(s, '#') ? s[2:end] : s
    all(isxdigit, h) && length(h) in (3, 6, 8) ||
        throw(ArgumentError("a colour string is #rgb, #rrggbb or #rrggbbaa (got $(repr(s)))"))
    # #rgb is the shorthand where each digit stands for a doubled byte, so #f0a means #ff00aa.
    pairs = length(h) == 3 ? [c * c for c in h] : [h[i:i+1] for i in 1:2:length(h)]
    v = parse.(UInt8, pairs; base = 16)
    return (v[1], v[2], v[3], length(v) == 4 ? v[4] : 0xff)
end

function rgba8(t::Tuple)
    length(t) in (3, 4) ||
        throw(ArgumentError("a colour tuple is (r, g, b) or (r, g, b, a) (got $(length(t)) values)"))
    all(x -> x isa Integer && 0 ≤ x ≤ 255, t) ||
        throw(ArgumentError("a colour tuple holds integers in 0..255 (got $(repr(t)))"))
    return (UInt8(t[1]), UInt8(t[2]), UInt8(t[3]), length(t) == 4 ? UInt8(t[4]) : 0xff)
end

# Sampling works in floats and rounds once, so blending two stops does not accumulate rounding.
as_float(c) = (t = rgba8(c); (t[1] / 255, t[2] / 255, t[3] / 255, t[4] / 255))

"""
    colormap_stops(cmap) -> (fractions, colors)

A vector colormap as placed stops: the fractions in `[0, 1]` it is defined at, ascending, and the
colour at each. A vector of colours is spread evenly; a vector of `fraction => colour` pairs is taken
as written.
"""
function colormap_stops(cmap::AbstractVector)
    isempty(cmap) && throw(ArgumentError("a colormap needs at least one colour"))
    if all(x -> x isa Pair, cmap)
        fracs = Float64[float(first(p)) for p in cmap]
        all(f -> 0 ≤ f ≤ 1, fracs) ||
            throw(ArgumentError("colormap stop fractions lie in [0, 1] (got $fracs)"))
        order = sortperm(fracs)
        return fracs[order], [as_float(last(cmap[i])) for i in order]
    end
    n = length(cmap)
    fracs = n == 1 ? [0.0] : collect(range(0.0, 1.0; length = n))
    return fracs, [as_float(c) for c in cmap]
end

"""
    sample_rgba(cmap, t) -> RGBA8

The colormap's colour at fraction `t ∈ [0, 1]`. A vector colormap is interpolated between its stops;
anything else is asked for `get(cmap, t)`, so a ColorSchemes.jl scheme samples as its own package
defines it.
"""
sample_rgba(cmap, t::Real) = rgba8(get(cmap, clamp(float(t), 0.0, 1.0)))

function sample_rgba(cmap::AbstractVector, t::Real)
    fracs, colors = colormap_stops(cmap)
    return sample_stops(fracs, colors, t)
end

function sample_stops(fracs::AbstractVector, colors::AbstractVector, t::Real)
    u = clamp(float(t), 0.0, 1.0)
    i = searchsortedlast(fracs, u)
    i ≤ 0 && return round_rgba(colors[1])
    i ≥ length(fracs) && return round_rgba(colors[end])
    lo, hi = fracs[i], fracs[i+1]
    w = hi == lo ? 0.0 : (u - lo) / (hi - lo)
    a, b = colors[i], colors[i+1]
    return round_rgba(ntuple(k -> a[k] * (1 - w) + b[k] * w, 4))
end

round_rgba(c::NTuple{4}) = (byte(c[1]), byte(c[2]), byte(c[3]), byte(c[4]))

# The value span a colormap covers when the caller states none. Missing data is the normal case for a
# gridded field, and `extrema` over one `NaN` answers `(NaN, NaN)`, which poisons every value rather
# than its own.
function finite_extrema(values)
    lo, hi = Inf, -Inf
    for v in values
        x = float(v)
        isfinite(x) || continue
        lo = min(lo, x)
        hi = max(hi, x)
    end
    lo ≤ hi || throw(ArgumentError("the range cannot be computed: no value is finite"))
    return lo, hi
end

"""
    rgba(cmap, values; range=finite_extrema(values), alpha=1.0) -> Matrix{UInt8}

Map a per-entity `values` onto the `4 × length(values)` byte matrix `Nodes`, `Edges` and `Areas` take
as `color`. `range` is the value span the colormap covers, and values outside it clamp to its ends.
`alpha` is a scalar or one value per entity, in `[0, 1]`, multiplied into whatever alpha the colormap
itself carries — which is how a dimmed idle entity is expressed.

A value that is `NaN` draws nothing: it takes `alpha = 0`, whatever `alpha` says. The default `range`
covers the finite values only, so one missing entry does not move the colours of the others. State
`range` yourself and the convention holds the same way. Every value missing raises, because there is
no range to compute.

On `Nodes` and `Areas` a colour is a per-entity attribute and a ramp over thousands of entities costs
one draw command. **On `Edges` it is the batch key**: a line's colour lives in its material and the
renderer emits one draw command per run of lines sharing one, so a ramp over an edge family costs a
draw command per distinct colour. Colour edges by a handful of appearances rather than by a
continuous value — see [`Edges`](@ref).

```julia
using ColorSchemes
color = rgba(ColorSchemes.viridis, throughput; range = (0, 12))
color = rgba(["#202020", "#33e0ff"], load; alpha = [idle ? 0.1 : 1.0 for idle in idles])
```
"""
function rgba(cmap, values; range = finite_extrema(values), alpha = 1.0)
    n = length(values)
    lo, hi = float(first(range)), float(last(range))
    alphas = alpha isa Real ? nothing : collect(float.(alpha))
    alphas === nothing || length(alphas) == n ||
        throw(ArgumentError("alpha has $(length(alphas)) values for $n entities"))
    scalar = alpha isa Real ? clamp(float(alpha), 0.0, 1.0) : 0.0
    # A vector colormap is resolved to its stops once rather than per value.
    stops = cmap isa AbstractVector ? colormap_stops(cmap) : nothing
    span = hi - lo
    out = Matrix{UInt8}(undef, 4, n)
    for (j, v) in enumerate(values)
        x = float(v)
        # A missing value draws nothing, so its colour never has to be chosen.
        if isnan(x)
            out[1, j], out[2, j], out[3, j], out[4, j] = 0x00, 0x00, 0x00, 0x00
            continue
        end
        # A degenerate range has nothing to spread values over, so every entity takes the low end.
        t = span == 0 ? 0.0 : (x - lo) / span
        c = stops === nothing ? sample_rgba(cmap, t) : sample_stops(stops[1], stops[2], t)
        a = alphas === nothing ? scalar : clamp(alphas[j], 0.0, 1.0)
        out[1, j], out[2, j], out[3, j] = c[1], c[2], c[3]
        out[4, j] = byte(c[4] / 255 * a)
    end
    return out
end

# How finely a colormap that is only sampleable is turned into stops. A gradient the browser
# interpolates linearly between these is indistinguishable from the curve at bar height.
const LEGEND_SAMPLES = 33

"""
    legend_stops(cmap) -> Vector{Tuple{Float64,String}}

The colormap as `(fraction, "#rrggbb")` stops from fraction 0 to 1. A vector colormap keeps its own
stops exactly; anything else is sampled, which is what makes a ColorSchemes.jl scheme work unchanged.
"""
function legend_stops(cmap::AbstractVector)
    fracs, colors = colormap_stops(cmap)
    return [(f, hex_color(round_rgba(c))) for (f, c) in zip(fracs, colors)]
end

function legend_stops(cmap)
    ts = range(0.0, 1.0; length = LEGEND_SAMPLES)
    return [(t, hex_color(sample_rgba(cmap, t))) for t in ts]
end

# `#rrggbb`, or `#rrggbbaa` where the colour is not opaque: a CSS gradient stop reads both.
function hex_color(c::RGBA8)
    n = c[4] == 0xff ? 3 : 4
    return "#" * join(string(c[i]; base = 16, pad = 2) for i in 1:n)
end
