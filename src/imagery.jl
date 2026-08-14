# What the globe is textured with, and the directories that are mounted beside it: the `Imagery`
# declaration, the tile-pyramid sniffing an on-disk source needs, and the assets mounts. None of it
# touches the server's lock — it is read once, at `start_server`.

"""
    Imagery(url; tiling=:mercator, max_level=nothing, credit=nothing)

What the globe is textured with, in place of the viewer's bundled Earth texture. `url` names one of
two backings, and the string itself decides which:

| `url` | what the server does |
|---|---|
| a directory on disk | mounts it under `/assets/imagery/` and declares a relative URL into it |
| anything else | declares it verbatim, as a `{z}/{x}/{y}` template |

A directory tells the server its own layout, so there is nothing to state: a `tilemapresource.xml`
in it makes it TMS, and a numeric level directory makes it XYZ. gdal2tiles writes TMS by default,
and XYZ under `--xyz`.

The layout decides what the directory declares. A TMS pyramid declares the mount base, because
Cesium reads the template out of `tilemapresource.xml`. An XYZ pyramid declares the template itself,
`assets/imagery/{z}/{x}/{y}.png`, with the extension read from a tile on disk.

`tiling` is the projection an XYZ pyramid is cut in. `:mercator` is the default, because that is
what `{z}/{x}/{y}` means on the web and what the ready-made Moon and Mars basemaps use;
`:geographic` states the other one. A TMS directory carries its scheme in `tilemapresource.xml`, so
`:geographic` given with one warns and is dropped.

`max_level` is the deepest level the source holds. The server probes it from an XYZ directory, so
give it for a URL alone — a remote host cannot be probed, and an unset maximum asks a deep zoom for
tiles that are not there.

`credit` is one line of attribution, drawn over the globe at the bottom right. The string is yours
to make legally correct; the viewer only gives it somewhere to appear.

```julia
start_server(; imagery = "/data/moon_tiles")
start_server(; imagery = "https://host/tiles/{z}/{x}/{y}.png")
start_server(; imagery = Imagery(url; tiling = :geographic, max_level = 7, credit = "USGS"))
```
"""
struct Imagery
    url::String
    tiling::Symbol
    max_level::Union{Int,Nothing}
    credit::Union{String,Nothing}
    # An INNER constructor so validation runs for every call form: an unreadable tiling scheme would
    # otherwise be declared to the viewer and build a provider that draws nothing.
    function Imagery(url, tiling, max_level, credit)
        t = Symbol(tiling)
        t in (:mercator, :geographic) ||
            throw(ArgumentError("`tiling` is `:mercator` or `:geographic` (got $(repr(tiling)))"))
        max_level === nothing || max_level > 0 ||
            throw(ArgumentError("`max_level` is the deepest level of the pyramid, so it is a " *
                                "positive integer (got $(repr(max_level)))"))
        return new(String(url), t, max_level === nothing ? nothing : Int(max_level),
                   credit === nothing ? nothing : String(credit))
    end
end

Imagery(url; tiling = :mercator, max_level = nothing, credit = nothing) =
    Imagery(url, tiling, max_level, credit)

# The easy case is one string, and it reaches every method that takes an `Imagery`.
Base.convert(::Type{Imagery}, url::AbstractString) = Imagery(url)

# The levels of a tile pyramid: every subdirectory whose name is an integer.
level_dirs(dir) = [lvl for lvl in (tryparse(Int, e) for e in readdir(dir)
                                   if isdir(joinpath(dir, e)))
                   if lvl !== nothing]

# The file extension of the tiles in an XYZ pyramid, read from a tile that is there. The declared
# URL is a template the browser requests verbatim, so the name must be right: gdal2tiles writes
# `.png`, and `.jpg` for a pyramid with no transparency.
function tile_extension(dir, levels)
    z = minimum(levels)
    for x in readdir(joinpath(dir, string(z)); join = true)
        isdir(x) || continue
        for tile in readdir(x)
            ext = last(splitext(tile))
            isempty(ext) || return lstrip(ext, '.')
        end
    end
    throw(ArgumentError("$dir holds a level $z with no tile in it, so the name the browser must " *
                        "ask a tile by cannot be read. An XYZ pyramid holds `<z>/<x>/<y>.png`."))
end

# The mount a directory of basemap tiles is served under. Reserved: `assets` may not claim it, or the
# globe would silently wear a pyramid the author never named.
const IMAGERY_MOUNT = "imagery"

# A directory as a mount root: absolute, normalised, and with no trailing separator. The separator
# carries no meaning at the end, and `basename` reads an *empty* name from a path that keeps one — so
# a mount named after its own directory ends up with no name at all.
#
# Split and rejoin rather than strip a character. `splitpath` drops the trailing element and reads
# either separator, so this holds on every platform; stripping `/` leaves the `\` a Windows path ends
# with, and stripping `\` as well would turn `C:\` into a drive-relative `C:`.
mount_dir(path) = joinpath(splitpath(normpath(abspath(String(path))))...)

# The mounts `start_server` was given, as name => absolute directory. A bare string is one mount,
# named after the last element of its path, so `/data/glb` answers `/assets/glb/`. Every name is part
# of a URL the scene declares, so it is checked here rather than in the browser: a reader can see
# which folder a file comes from without reading the server call.
function resolve_assets(assets)
    assets === nothing && return Dict{String,String}()
    pairs = assets isa AbstractString ? [basename(mount_dir(assets)) => assets] : collect(assets)
    dirs = Dict{String,String}()
    for (name, path) in pairs
        n = String(name)
        isempty(n) && throw(ArgumentError("an assets mount needs a name, and one is empty"))
        occursin('/', n) &&
            throw(ArgumentError("an assets mount name is one path element, so it holds no `/` " *
                                "(got $(repr(n)))"))
        n == IMAGERY_MOUNT &&
            throw(ArgumentError("`$IMAGERY_MOUNT` is the mount a basemap directory is served " *
                                "under, so `assets` may not claim it. Pass the directory as " *
                                "`imagery = $(repr(String(path)))` instead."))
        dir = mount_dir(path)
        isdir(dir) || throw(ArgumentError("the assets mount $(repr(n)) names $dir, which is not a " *
                                          "directory"))
        dirs[n] = dir
    end
    return dirs
end

# The declaration for a source that is not on disk. It is declared as it stands and never fetched:
# there is no network call at `start_server`, and a URL that answers nothing is found by the
# browser, which says so and falls back to the bundled texture.
function url_declaration(im::Imagery)
    d = (; im.url, layout = "xyz", tiling = String(im.tiling))
    im.max_level === nothing || (d = (; d..., maxLevel = im.max_level))
    im.credit === nothing || (d = (; d..., credit = im.credit))
    return d
end

# The declaration for a directory of tiles, and the directory the mount serves it from. Read once,
# at `start_server`: the layout is sniffed from what the directory holds, and the depth is probed
# from the level names. The URL declared is relative, so the page reaches the mount same-origin and
# no CORS header is needed anywhere.
function dir_declaration(im::Imagery)
    dir = mount_dir(im.url)
    tms = isfile(joinpath(dir, "tilemapresource.xml"))
    levels = level_dirs(dir)
    tms || !isempty(levels) ||
        throw(ArgumentError("$dir holds neither a `tilemapresource.xml` nor a numeric level " *
                            "directory, so it is neither a TMS nor an XYZ pyramid. gdal2tiles " *
                            "writes TMS by default, and XYZ under `--xyz`."))
    # A TMS pyramid is declared as a base, and an XYZ one as a template. Cesium reads the base with
    # `TileMapServiceImageryProvider` and builds a template of its own, but it hands an XYZ URL to
    # `UrlTemplateImageryProvider`, whose `url` *is* the template. A URL with no `{z}`, `{x}` or
    # `{y}` in it is then requested unchanged for every tile, and that request is the mount root —
    # a directory, which answers 404 and leaves the globe bare.
    d = (; url = tms ? "assets/$(IMAGERY_MOUNT)/" :
                 "assets/$(IMAGERY_MOUNT)/{z}/{x}/{y}.$(tile_extension(dir, levels))",
         layout = tms ? "tms" : "xyz")
    if tms
        # `tilemapresource.xml` carries the tiling scheme and the depth, and Cesium reads both out
        # of it, so neither travels on the declaration.
        im.tiling === :mercator ||
            @warn "`tilemapresource.xml` decides the tiling scheme of a TMS directory, so the \
                declared one is dropped" dir tiling = im.tiling
    else
        d = (; d..., tiling = String(im.tiling),
             maxLevel = im.max_level === nothing ? maximum(levels) : im.max_level)
    end
    im.credit === nothing || (d = (; d..., credit = im.credit))
    return (d, dir)
end

# What `start_server` was given for `imagery`, as the wire declaration and the directory to mount:
# `nothing` declares no field at all and leaves the viewer on its bundled texture, `false` asks for
# a globe with no base layer, and anything else names one source.
function resolve_imagery(imagery)
    imagery === nothing && return (nothing, nothing)
    imagery === :none && return (false, nothing)
    imagery isa Symbol &&
        throw(ArgumentError("`imagery` takes a directory, a URL template, an `Imagery`, or " *
                            "`:none` for a globe with no base layer (got $(repr(imagery)))"))
    im = convert(Imagery, imagery)
    isdir(im.url) || return (url_declaration(im), nothing)
    return dir_declaration(im)
end

# Where the basemap tiles are, for the discovery file: the mounted directory, or the declared URL.
# `nothing` for a scene that declares no basemap, and for one that declares `false` — a globe with
# no base layer needs no tiles from anywhere.
imagery_source(server) = get(server.asset_dirs, IMAGERY_MOUNT,
                             server.imagery isa NamedTuple ? server.imagery.url : nothing)

# What each mount answers on the wire: the same-origin base, not the directory behind it. A host
# whose page sits on another origin builds its own URL per mount out of this.
declared_assets(server) =
    Dict(name => "assets/$name/" for name in keys(server.asset_dirs))

# The origin of a declared URL — scheme, host and port — or `nothing` for anything that is not an
# absolute URL. A CSP names origins and not paths, so a tile template reaches the list as its origin.
function url_origin(url::AbstractString)
    m = match(r"^([a-zA-Z][a-zA-Z0-9+.\-]*://[^/?#]+)", url)
    return m === nothing ? nothing : m.captures[1]
end
