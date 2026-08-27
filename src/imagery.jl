# What the globe is textured with, and the directories that are mounted beside it: the `Imagery`
# declaration, the tile-pyramid sniffing an on-disk source needs, and the assets mounts. None of it
# touches the server's lock — it is read once, at `start_server`.

"""
    Imagery(url; name=nothing, tiling=:mercator, max_level=nothing, credit=nothing, backing=false)

One basemap. A session declares a **basemap set** — one of these, or several — and the reader picks
which of them the globe wears. `url` names one of two kinds, and the string itself decides which:

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

`name` is the label in the picker. A set of one draws no picker, so a lone basemap needs none.

`tiling` is the projection an XYZ pyramid is cut in. `:mercator` is the default, because that is
what `{z}/{x}/{y}` means on the web and what the ready-made Moon and Mars basemaps use;
`:geographic` states the other one. A TMS directory carries its scheme in `tilemapresource.xml`, so
`:geographic` given with one warns and is dropped.

`max_level` is the deepest level the source holds. The server probes it from an XYZ directory, so
give it for a URL alone — a remote host cannot be probed, and an unset maximum asks a deep zoom for
tiles that are not there.

`credit` is one line of attribution, drawn over the globe at the bottom right. It names this basemap
and appears only while this basemap is the one on screen. The string is yours to make legally
correct; the viewer only gives it somewhere to appear.

`backing` draws the viewer's own offline pyramid underneath this one, so a source that stops
answering leaves a globe rather than a hole. The pyramid is of Earth, so `start_server` throws when
a session on another body asks for one.

Ready-made values are in [`KNOWN_EARTH_BASEMAPS`](@ref).

```julia
start_server(; imagery = "/data/moon_tiles")
start_server(; imagery = "https://host/tiles/{z}/{x}/{y}.png")
start_server(; imagery = Imagery(url; tiling = :geographic, max_level = 7, credit = "USGS"))
```
"""
struct Imagery
    url::String
    name::Union{String,Nothing}
    tiling::Symbol
    max_level::Union{Int,Nothing}
    credit::Union{String,Nothing}
    backing::Bool
    # The pyramid inside the viewer. It carries no URL: the one it answers on is built from
    # `CESIUM_BASE_URL`, which only the page knows, so the wire carries a marker and the viewer
    # resolves it.
    bundled::Bool
    # An INNER constructor so validation runs for every call form: an unreadable tiling scheme would
    # otherwise be declared to the viewer and build a provider that draws nothing.
    function Imagery(url, name, tiling, max_level, credit, backing, bundled)
        t = Symbol(tiling)
        t in (:mercator, :geographic) ||
            throw(ArgumentError("`tiling` is `:mercator` or `:geographic` (got $(repr(tiling)))"))
        max_level === nothing || max_level > 0 ||
            throw(ArgumentError("`max_level` is the deepest level of the pyramid, so it is a " *
                                "positive integer (got $(repr(max_level)))"))
        u = String(url)
        bundled && !isempty(u) &&
            throw(ArgumentError("the bundled basemap carries no URL — the page builds the one it " *
                                "answers on (got $(repr(u)))"))
        bundled || !isempty(u) ||
            throw(ArgumentError("a basemap needs a URL or a directory, and this one is empty"))
        # The bundled pyramid IS what a backing draws, so backing it with itself would put the same
        # texture on the globe twice.
        bundled && backing &&
            throw(ArgumentError("the bundled basemap is what a backing draws, so it cannot ask " *
                                "for one"))
        return new(u, name === nothing ? nothing : String(name), t,
                   max_level === nothing ? nothing : Int(max_level),
                   credit === nothing ? nothing : String(credit), Bool(backing), Bool(bundled))
    end
end

Imagery(url = ""; name = nothing, tiling = :mercator, max_level = nothing, credit = nothing,
        backing = false, bundled = false) =
    Imagery(url, name, tiling, max_level, credit, backing, bundled)

# The easy case is one string, and it reaches every method that takes an `Imagery`.
Base.convert(::Type{Imagery}, url::AbstractString) = Imagery(url)

"""
    KNOWN_EARTH_BASEMAPS

The basemaps this package knows about, as ready-made [`Imagery`](@ref) values. Every one of them is
of Earth, so none belongs in a session on another body.

| Key | What the globe wears | Deepest level |
|---|---|---|
| `offline_natural_earth` | the pyramid inside the viewer; reaches no network | 2 |
| `blue_marble` | NASA GIBS Blue Marble, with sea-floor colour | 8 |
| `blue_marble_relief` | NASA GIBS Blue Marble, land relief only | 8 |
| `osm` | the OpenStreetMap standard map | 19 |

Pick the ones you want by name. This is a `NamedTuple` rather than a list to filter, because a
filter selects by name string: rename a basemap in a later release and the filter matches nothing,
which hands back a basemap the caller meant to drop.

```julia
start_server()                                                    # the default set
start_server(; imagery = KNOWN_EARTH_BASEMAPS.offline_natural_earth)   # no network, no picker
start_server(; imagery = collect(KNOWN_EARTH_BASEMAPS))                # every one of them
```

Each value carries the attribution its source asks for, and `osm` may not be drawn without one.
"""
const KNOWN_EARTH_BASEMAPS = (;
    offline_natural_earth = Imagery(; name = "Natural Earth", bundled = true),
    blue_marble = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/\
         default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
        name = "Blue Marble", max_level = 8, backing = true,
        credit = "NASA EOSDIS GIBS"),
    blue_marble_relief = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/\
         default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
        name = "Blue Marble Relief", max_level = 8, backing = true,
        credit = "NASA EOSDIS GIBS"),
    osm = Imagery("https://tile.openstreetmap.org/{z}/{x}/{y}.png";
                  name = "OpenStreetMap", max_level = 19, backing = true,
                  credit = "\u00a9 OpenStreetMap contributors"),
)

# What a session declares when the caller names nothing: a sharp globe that repairs itself offline
# (ADR-0034). The offline pyramid is in the set as well as under the first entry, so a reader can
# choose the calm flat map deliberately rather than only by losing the network.
#
# Two entries and no more. The set is also what the picker offers, and what widens the content
# policy: every entry's origin reaches `img-src` and `connect-src`. `osm` is in the catalogue for an
# author to name, and naming it takes on OpenStreetMap's tile usage policy — which is not something
# a session that named no basemap at all has agreed to.
const DEFAULT_EARTH_BASEMAPS = [KNOWN_EARTH_BASEMAPS.blue_marble,
                                KNOWN_EARTH_BASEMAPS.offline_natural_earth]

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
    return with_common(d, im)
end

# The declaration for the pyramid inside the viewer. It carries no URL and no layout: the page
# builds both from `CESIUM_BASE_URL`, which is the one thing about this basemap the server cannot
# know. It is also the basemap a `backing` draws, so a set may hold it twice over — once as an
# entry a reader can pick, and once under an entry that asked to be backed.
bundled_declaration(im::Imagery) = with_common((; bundled = true), im)

# The catalogue name of a basemap, or `nothing` for one an author built. It is what the picker looks
# an icon and a category up by, so renaming a label cannot change what the drop-down draws.
catalogue_key(im::Imagery) = findfirst(==(im), KNOWN_EARTH_BASEMAPS)

# The fields every kind of basemap carries. `key` names the catalogue entry this is, `name` labels
# the entry in the picker, and a set of one draws no picker, so a lone basemap without one declares
# nothing here.
function with_common(d, im::Imagery)
    k = catalogue_key(im)
    k === nothing || (d = (; d..., key = String(k)))
    im.name === nothing || (d = (; d..., im.name))
    im.credit === nothing || (d = (; d..., credit = im.credit))
    im.backing && (d = (; d..., backing = true))
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
    return (with_common(d, im), dir)
end

# Whether a session stands on Earth. A backing draws the pyramid inside the viewer, which is of
# Earth, and so is every basemap in the default set. Every real Earth datum agrees with WGS 84 to
# far better than a percent of the semi-major axis, and every other body differs by much more, so
# this refuses the Moon without refusing GRS 80.
is_earth(ellipsoid) = ellipsoid === nothing ||
                      isapprox(Float64(ellipsoid.a), Ellipsoids.WGS84.a; rtol = 0.01)

# One `imagery` argument as a list of `Imagery`. A string is a basemap and not a collection of
# characters, so it is matched before anything is iterated.
basemap_set(imagery::Union{AbstractString,Imagery}) = [convert(Imagery, imagery)]
basemap_set(imagery) = Imagery[convert(Imagery, e) for e in imagery]

# What `start_server` was given for `imagery`, as the wire declaration and the directory to mount.
# The declaration is a *list*: a session declares every basemap it can wear, and the reader picks
# between them (ADR-0034). `nothing` declares the default set, `false` asks for a globe with no base
# layer, and anything else names the set itself.
function resolve_imagery(imagery, ellipsoid = nothing)
    imagery === nothing && return default_declaration(ellipsoid)
    imagery === :none && return (false, nothing)
    imagery isa Symbol &&
        throw(ArgumentError("`imagery` takes a basemap, a list of them, or `:none` for a globe " *
                            "with no base layer (got $(repr(imagery)))"))
    set = basemap_set(imagery)
    isempty(set) &&
        throw(ArgumentError("a basemap set holds at least one basemap. Pass `:none` for a globe " *
                            "with no base layer."))
    earth = is_earth(ellipsoid)
    declarations, dir = NamedTuple[], nothing
    for im in set
        if im.backing && !earth
            throw(ArgumentError("a backing draws the pyramid inside the viewer, which is of " *
                                "Earth, so the basemap $(repr(something(im.name, im.url))) may " *
                                "not ask for one on this ellipsoid. Drop `backing`, or name a " *
                                "basemap of this body."))
        end
        if im.bundled
            push!(declarations, bundled_declaration(im))
        elseif isdir(im.url)
            # One server serves one `imagery` mount, so one set holds at most one directory.
            dir === nothing ||
                throw(ArgumentError("a basemap set holds at most one directory of tiles, because " *
                                    "one server serves one `$IMAGERY_MOUNT` mount. Serve the " *
                                    "others from a URL."))
            d, dir = dir_declaration(im)
            push!(declarations, d)
        else
            push!(declarations, url_declaration(im))
        end
    end
    return (declarations, dir)
end

# What a session that names no basemap declares. On Earth that is the default set, which is the one
# behaviour a reader notices on upgrade. On another body it is nothing at all, so the viewer keeps
# the bundled texture it has always kept: the default set is of Earth, and Earth's coastlines under
# a Moon scene are the picture ADR-0020 warns about.
function default_declaration(ellipsoid)
    is_earth(ellipsoid) || return (nothing, nothing)
    return (NamedTuple[e.bundled ? bundled_declaration(e) : url_declaration(e)
                       for e in DEFAULT_EARTH_BASEMAPS], nothing)
end

# Where the basemap tiles are, for the discovery file: the mounted directory, or the declared URL.
# `nothing` for a scene that declares no basemap, and for one that declares `false` — a globe with
# no base layer needs no tiles from anywhere.
function imagery_source(server)
    haskey(server.asset_dirs, IMAGERY_MOUNT) && return server.asset_dirs[IMAGERY_MOUNT]
    server.imagery isa AbstractVector || return nothing
    # The first entry the reader can be sent to, which is the first that names a URL. The bundled
    # pyramid names none, and it is in the viewer wherever the viewer is.
    for d in server.imagery
        haskey(d, :url) && return d.url
    end
    return nothing
end

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
