# What the globe is textured with, and the directories that are mounted beside it: the `Imagery`
# declaration, the tile-pyramid sniffing an on-disk source needs, and the assets mounts. None of it
# touches the server's lock — it is read once, at `start_server`.

# The border style a basemap wears when it names none: white at 0.55, two pixels wide. Strong enough
# to read over a photograph and a drawn relief map alike, and faint enough that a whole-globe view is
# a globe with borders rather than a net with a globe behind it. The viewer holds the same pair, for
# a page that no server declared a basemap to.
const DEFAULT_BORDER_COLOR = "#ffffff8c"
const DEFAULT_BORDER_WIDTH = 2.0

"""
    Imagery(url; name=nothing, tiling=:mercator, max_level=nothing, credit=nothing, backing=false,
            border_color="#ffffff8c", border_width=2.0)

One basemap. A session declares a **basemap set** (one of these, or several), and the reader picks
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

`tiling` is the grid an XYZ pyramid is cut on, and it takes one of three values. `:mercator` is the
default, because that is what `{z}/{x}/{y}` means on the web and what the ready-made Moon and Mars
basemaps use. `:geographic` states the other common one, which is 256 pixel tiles on a level 0 of
two columns by one row. `:gibs_geographic` states the EPSG:4326 grid NASA GIBS publishes: 512 pixel
tiles, a level 0 of two columns by one row, then 3 by 2, 5 by 3, 10 by 5, and a doubling per level
below that. A TMS directory carries its scheme in `tilemapresource.xml`, so a `tiling` given with
one warns and is dropped.

`max_level` is the deepest level the source holds. The server probes it from an XYZ directory, so
give it for a URL alone — a remote host cannot be probed, and an unset maximum asks a deep zoom for
tiles that are not there.

`credit` is one line of attribution, drawn over the globe at the bottom right. It names this basemap
and appears only while this basemap is the one on screen. The string is HTML, so it can hold the
link a source asks for, and the viewer sanitizes it before it draws it. The string is yours to make
legally correct. The viewer only gives it somewhere to appear.

`backing` draws the viewer's own offline pyramid underneath this one, so a source that returns no
tiles leaves a globe instead of a hole. The pyramid is of Earth, so `start_server` throws when
a session on another body asks for one.

`border_color` and `border_width` are the **border style**: the colour and the width the country
borders wear while this basemap is on the globe. The right colour depends on what lies under the
line, so each basemap names its own, and the viewer restyles the lines on every pick. The colour is
a CSS colour string. The browser parses it; this server checks only that it is not empty, and a
string the browser cannot read draws the default and says so once. The width is in pixels, and it
is the width the reader sees zoomed in: the viewer thins the line towards the whole-globe view.

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
    border_color::String
    border_width::Float64
    # The pyramid inside the viewer. It carries no URL. The page builds the one it answers on
    # from `CESIUM_BASE_URL`, and only the page knows that value. The wire therefore carries a
    # marker, and the viewer resolves it.
    bundled::Bool
    # An INNER constructor so validation runs for every call form: an unreadable tiling scheme would
    # otherwise be declared to the viewer and build a provider that draws nothing.
    function Imagery(url, name, tiling, max_level, credit, backing, border_color, border_width,
                     bundled)
        t = Symbol(tiling)
        t in (:mercator, :geographic, :gibs_geographic) ||
            throw(ArgumentError("`tiling` is `:mercator`, `:geographic` or `:gibs_geographic` " *
                                "(got $(repr(tiling)))"))
        max_level === nothing || max_level > 0 ||
            throw(ArgumentError("`max_level` is the deepest level of the pyramid, so it is a " *
                                "positive integer (got $(repr(max_level)))"))
        u = String(url)
        bundled && !isempty(u) &&
            throw(ArgumentError("the bundled basemap carries no URL — the page builds the one it " *
                                "answers on (got $(repr(u)))"))
        bundled || !isempty(u) ||
            throw(ArgumentError("a basemap needs a URL or a directory, and this one is empty"))
        # The bundled pyramid IS what a backing draws. If it backed itself, the same texture
        # would sit on the globe twice.
        bundled && backing &&
            throw(ArgumentError("the bundled basemap is what a backing draws, so it cannot ask " *
                                "for one"))
        # The browser parses the colour, so the only thing worth refusing here is a string that
        # names nothing at all. Reading CSS in Julia would be a second parser to keep true to the
        # first one.
        bc = String(border_color)
        isempty(bc) &&
            throw(ArgumentError("`border_color` is the CSS colour the country borders are drawn " *
                                "in, so it is not empty. The browser parses the string."))
        border_width > 0 ||
            throw(ArgumentError("`border_width` is the width of a country border in pixels, so " *
                                "it is positive (got $(repr(border_width)))"))
        return new(u, name === nothing ? nothing : String(name), t,
                   max_level === nothing ? nothing : Int(max_level),
                   credit === nothing ? nothing : String(credit), Bool(backing), bc,
                   Float64(border_width), Bool(bundled))
    end
end

Imagery(url = ""; name = nothing, tiling = :mercator, max_level = nothing, credit = nothing,
        backing = false, border_color = DEFAULT_BORDER_COLOR,
        border_width = DEFAULT_BORDER_WIDTH, bundled = false) =
    Imagery(url, name, tiling, max_level, credit, backing, border_color, border_width, bundled)

# The easy case is one string, and it reaches every method that takes an `Imagery`.
Base.convert(::Type{Imagery}, url::AbstractString) = Imagery(url)

"""
    KNOWN_EARTH_BASEMAPS

The basemaps this package knows about, as ready-made [`Imagery`](@ref) values. Every one of them is
of Earth, so none belongs in a session on another body.

| Key | What the globe wears | Deepest level | Border |
|---|---|---|---|
| `offline_natural_earth` | the pyramid inside the viewer, which reaches no network | 2 | dark grey |
| `aster_colour_relief` | ASTER shaded relief from NASA GIBS, in colour | 11 | dark grey |
| `aster_grey_relief` | ASTER shaded relief from NASA GIBS, in grey | 11 | black |
| `emodnet_baselayer` | EMODnet Bathymetry, with sea-floor relief | 15 | dark grey |
| `blue_marble` | Blue Marble from NASA GIBS, with sea-floor colour | 7 | white |
| `blue_marble_relief` | Blue Marble from NASA GIBS, land relief only | 7 | white |
| `city_lights` | night-time city lights from NASA GIBS, VIIRS 2012 | 7 | white |

Every online entry draws to both poles. The six are cut on a geographic grid, which covers the
whole globe, so the backing under them shows only while a host is unreachable.

Pick the ones you want by name. This is a `NamedTuple` and not a list to filter, because a filter
selects by name string. Rename a basemap in a later release, and the filter matches nothing and
hands back a basemap the caller meant to drop.

```julia
start_server()                                                    # the default set
start_server(; imagery = KNOWN_EARTH_BASEMAPS.offline_natural_earth)   # no network, no picker
start_server(; imagery = collect(KNOWN_EARTH_BASEMAPS))                # every one of them
```

Each value carries the attribution its source asks for.
"""
# The border colour each basemap names, picked from screenshots at 1,500 km and 20,000 km: a dark
# line reads on a pale map, and a white line reads on a dark one. ASTER Grey Relief takes black
# rather than dark grey, because its land is pale grey and a dark grey line all but disappears on it.
const KNOWN_EARTH_BASEMAPS = (;
    offline_natural_earth = Imagery(; name = "Natural Earth", bundled = true,
                                    border_color = "#3a3a3ab3"),
    # The five GIBS entries are declared on the EPSG:4326 endpoint, on the `gibs_geographic` grid.
    # It draws to both poles, where the Web Mercator endpoint stops at 85.0511 degrees and leaves
    # the backing showing as a disc. It is also finer per level: ASTER is 30.5 metres per pixel at
    # level 11, against 38.2 at Mercator level 12.
    #
    # Their path order is `{z}/{y}/{x}`, where the EMODnet entry is `{z}/{x}/{y}`: a WMTS REST path
    # names the tile row before the tile column. A template reaches the browser as it stands, so a
    # swapped pair draws a scrambled globe rather than an error.
    #
    # The two ASTER reliefs are drawn maps of the land and reach 30.5 metres per pixel, finer than
    # any photograph GIBS serves. Neither carries sea-floor colour: the ocean is one flat blue.
    aster_colour_relief = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/ASTER_GDEM_Color_Shaded_Relief/\
         default/default/31.25m/{z}/{y}/{x}.jpeg";
        name = "ASTER Colour Relief", tiling = :gibs_geographic, max_level = 11, backing = true,
        credit = "NASA EOSDIS GIBS", border_color = "#3a3a3ab3"),
    aster_grey_relief = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/ASTER_GDEM_Greyscale_Shaded_Relief/\
         default/default/31.25m/{z}/{y}/{x}.jpeg";
        name = "ASTER Grey Relief", tiling = :gibs_geographic, max_level = 11, backing = true,
        credit = "NASA EOSDIS GIBS", border_color = "#0000008c"),
    # The one entry on a host other than GIBS, and the one whose path order is `{z}/{x}/{y}`.
    #
    # EMODnet publishes the same layer on five tile matrix sets, and `inspire_quad` is the
    # EPSG:4326 one. It is Cesium's `GeographicTilingScheme` exactly: 256 pixel tiles, a level 0 of
    # two columns by one row, and a doubling per level. A Web Mercator basemap stops at 85.0511
    # degrees and leaves a disc at each pole. This one draws to the pole.
    emodnet_baselayer = Imagery(
        "https://tiles.emodnet-bathymetry.eu/2020/baselayer/inspire_quad/{z}/{x}/{y}.png";
        name = "EMODnet Baselayer", tiling = :geographic, max_level = 15, backing = true,
        credit = "EMODnet Bathymetry (CC BY 4.0)", border_color = "#3a3a3ab3"),
    blue_marble = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/\
         default/default/500m/{z}/{y}/{x}.jpeg";
        name = "Blue Marble", tiling = :gibs_geographic, max_level = 7, backing = true,
        credit = "NASA EOSDIS GIBS", border_color = "#ffffff8c"),
    blue_marble_relief = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief/\
         default/default/500m/{z}/{y}/{x}.jpeg";
        name = "Blue Marble Relief", tiling = :gibs_geographic, max_level = 7, backing = true,
        credit = "NASA EOSDIS GIBS", border_color = "#ffffff8c"),
    # Night-time lights, near black but for the cities on it, so it takes the same white border as
    # the Blue Marbles.
    city_lights = Imagery(
        "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_CityLights_2012/\
         default/default/500m/{z}/{y}/{x}.jpeg";
        name = "City Lights", tiling = :gibs_geographic, max_level = 7, backing = true,
        credit = "NASA EOSDIS GIBS", border_color = "#ffffff8c"),
)

# What a session declares when the caller declares nothing (ADR-0034): every basemap this package
# knows. An entry costs nothing until the reader picks it: the page builds a tile provider for
# entry 0 alone (`buildBaseLayers` in `lib/core/src/scene.ts`), so the default set can hold the
# whole catalogue and still open one host at startup.
#
# The content policy admits each entry's tile directory, not the host under it: `img-src` and
# `connect-src` widen by one directory per entry with a URL, and the set never trusts a host wider
# than the directories its own entries name.
#
# ASTER Colour Relief leads, sharp and alone on `gibs.earthdata.nasa.gov`. The offline pyramid is
# last: the calm map that needs no network, always there for the reader to fall back on.
const DEFAULT_EARTH_BASEMAPS = [KNOWN_EARTH_BASEMAPS.aster_colour_relief,
                                KNOWN_EARTH_BASEMAPS.aster_grey_relief,
                                KNOWN_EARTH_BASEMAPS.blue_marble,
                                KNOWN_EARTH_BASEMAPS.blue_marble_relief,
                                KNOWN_EARTH_BASEMAPS.city_lights,
                                KNOWN_EARTH_BASEMAPS.emodnet_baselayer,
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

# The spelling of a tiling scheme on the wire. A Julia symbol joins two words with an underscore,
# and the wire joins them with a hyphen, as `gibs-geographic`.
wire_tiling(tiling::Symbol) = replace(String(tiling), '_' => '-')

# The declaration for a source that is not on disk. It is declared as it stands and never fetched:
# there is no network call at `start_server`, and a URL that answers nothing is found by the
# browser, which says so and falls back to the bundled texture.
function url_declaration(im::Imagery)
    d = (; im.url, layout = "xyz", tiling = wire_tiling(im.tiling))
    im.max_level === nothing || (d = (; d..., maxLevel = im.max_level))
    return with_common(d, im)
end

# The declaration for the pyramid inside the viewer. It carries no URL and no layout: the page
# builds both from `CESIUM_BASE_URL`, which is the one thing about this basemap the server cannot
# know. It is also the basemap a `backing` draws, so a set can hold it twice over. It appears once
# as an entry a reader can pick, and once under an entry that asked for a backing.
bundled_declaration(im::Imagery) = with_common((; bundled = true), im)

# The catalogue name of a basemap, or `nothing` for one an author built. It is what the picker looks
# an icon and a category up by, so a renamed label cannot change what the drop-down draws.
catalogue_key(im::Imagery) = findfirst(==(im), KNOWN_EARTH_BASEMAPS)

# The fields every kind of basemap carries. `key` names the catalogue entry this is, and `name`
# labels the entry in the picker. A set of one draws no picker, so a lone basemap without one
# declares nothing here.
#
# The border style travels on every entry rather than only on the ones that ask for something of
# their own. The viewer restyles the country borders on each pick, so it needs the whole style of
# whatever entry the reader lands on, and an absent field would make it guess.
function with_common(d, im::Imagery)
    k = catalogue_key(im)
    k === nothing || (d = (; d..., key = String(k)))
    im.name === nothing || (d = (; d..., name = im.name))
    im.credit === nothing || (d = (; d..., credit = im.credit))
    im.backing && (d = (; d..., backing = true))
    return (; d..., borderColor = im.border_color, borderWidth = im.border_width)
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
        d = (; d..., tiling = wire_tiling(im.tiling),
             maxLevel = im.max_level === nothing ? maximum(levels) : im.max_level)
    end
    return (with_common(d, im), dir)
end

# Whether a session stands on Earth. A backing draws the pyramid inside the viewer, which is of
# Earth, and so is every basemap in the default set. Every real Earth datum agrees with WGS 84 to
# far better than a percent of the semi-major axis. Every other body differs by much more. This
# test therefore refuses the Moon and accepts Geodetic Reference System 1980 (GRS 80).
is_earth(ellipsoid) = ellipsoid === nothing ||
                      isapprox(Float64(ellipsoid.a), Ellipsoids.WGS84.a; rtol = 0.01)

# One `imagery` argument as a list of `Imagery`. A string is a basemap and not a collection of
# characters, so the string method takes it first, before the method that iterates.
basemap_set(imagery::Union{AbstractString,Imagery}) = [convert(Imagery, imagery)]
basemap_set(imagery) = Imagery[convert(Imagery, e) for e in imagery]

# What the caller gave `start_server` for `imagery`, as the wire declaration and the directory to
# mount.
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
        # The bundled pyramid is of Earth, and so is the one a backing draws underneath a URL.
        # Neither may stand on another body: Earth's coastlines under a Moon scene are the picture
        # ADR-0020 warns about.
        if im.bundled && !earth
            throw(ArgumentError("the bundled basemap is the pyramid inside the viewer, which is " *
                                "of Earth, so it may not stand on this ellipsoid. Name a " *
                                "basemap of this body."))
        end
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

# The declaration for a session with no basemap of its own. On Earth that is the default set, which is the one
# behaviour a reader notices on upgrade. On another body it is nothing at all, so the viewer keeps
# the bundled texture it has always kept. The default set is of Earth, and Earth's coastlines under
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
    # The first entry the page can send the reader to, which is the first with a URL. The
    # bundled pyramid names none, and it is in the viewer wherever the viewer is.
    for d in server.imagery
        haskey(d, :url) && return d.url
    end
    return nothing
end

# What each mount answers on the wire: the same-origin base, not the directory behind it. A host
# whose page sits on another origin builds its own URL per mount out of this.
declared_assets(server) =
    Dict(name => "assets/$name/" for name in keys(server.asset_dirs))

# The characters a CSP source may not carry. Whitespace splits the list, `;` and `,` split the
# directives, and a quote or an angle bracket escapes the `<meta content>` attribute a host writes
# the joined list into. `imageryCspSource` in `extension/extension.js` refuses the same set.
const CSP_UNSAFE = r"[\s;,'\"<>]"

# The content-policy source expression for a declared URL, or `nothing` for anything that is not an
# absolute URL. A CSP source takes a path as well as an origin, and a path ending in `/` matches by
# prefix, so a declared basemap trusts one tile directory rather than every repository its CDN
# mirrors. The prefix runs to the last `/` before the first `{`, since everything from the first
# placeholder on differs per tile.
function csp_source(url::AbstractString)
    m = match(r"^([a-zA-Z][a-zA-Z0-9+.\-]*://[^/?#]+)([^?#]*)", url)
    m === nothing && return nothing
    origin, path = m.captures[1], m.captures[2]
    # The list joins with a space and the directives join with `;`, so a source carrying whitespace,
    # `;` or `,` would not be one source any more. An origin carrying one names nothing reachable.
    # A quote or an angle bracket is refused for where the source lands: a host writes this list
    # into the `content` attribute of a `<meta>` element, and a quote there closes the attribute.
    occursin(CSP_UNSAFE, origin) && return nothing
    # A placeholder in the host leaves no path to trust: cutting inside an authority would name a
    # host nobody declared.
    occursin('{', origin) && return origin
    i = findfirst('{', path)
    head = i === nothing ? path : path[1:prevind(path, i)]
    j = findlast('/', head)
    j === nothing && return origin
    prefix = head[1:j]
    # The same rule for the path: it is the half a declared URL controls most freely.
    occursin(CSP_UNSAFE, prefix) && return origin
    return origin * prefix
end
