# The static half of the one port: the MIME table, which directory a request path is served from, the
# gzip cache, the ETag and the traversal guard. `mount_for` takes the server's lock to read the
# module set, and `serve_static` reads `dist_dir`; nothing else here is given a server.

# A browser applies strict MIME checking to an ES module and refuses to execute one that does not
# arrive as JavaScript, so `.mjs` — the extension a module commonly ships its entry file under —
# resolves to the same type as `.js`. An extension absent from here falls back to
# `application/octet-stream`, which also decides against compressing the body (`COMPRESSIBLE` below).
const MIME_TYPES = Dict(
    ".html" => "text/html", ".css" => "text/css",
    ".js" => "text/javascript", ".mjs" => "text/javascript",
    ".json" => "application/json", ".jpg" => "image/jpeg", ".jpeg" => "image/jpeg",
    ".png" => "image/png", ".gif" => "image/gif", ".svg" => "image/svg+xml",
    ".wasm" => "application/wasm", ".xml" => "application/xml", ".map" => "application/json",
    ".ktx2" => "image/ktx2", ".bin" => "application/octet-stream")

# Which directory a request path is served from: `/modules/<id>/<rest>` comes from the registered
# module's own directory, `/assets/<name>/<rest>` from the mount of that name, everything else from
# the viewer dist. Returns `(root, relative_path)`, or `nothing` for a root that is not configured.
function mount_for(server::Server, path::AbstractString)
    parts = split(path, '/'; limit = 4)                    # ["", "modules", id, rest]
    if length(parts) == 4 && parts[2] == "modules"
        entry = lock(server.clients_lock) do
            i = findfirst(m -> m.id == parts[3], server.modules)
            i === nothing ? nothing : server.modules[i]
        end
        entry === nothing && return nothing
        return (dirname(entry.path), parts[4])
    end
    if length(parts) == 4 && parts[2] == "assets"
        root = get(server.asset_dirs, parts[3], nothing)
        root === nothing && return nothing
        # The limit of 4 above leaves the rest whole, which a tile path needs: it is `<z>/<x>/<y>.png`
        # and names three levels of its own. The traversal guard in `serve_static` is what refuses a
        # path that climbs out of the mount.
        return (root, parts[4])
    end
    server.dist_dir === nothing && return nothing
    return (server.dist_dir, lstrip(path, '/'))
end

# Content types worth gzipping: text and wasm shrink several-fold, while the image and archive
# formats above are already compressed, so gzipping one spends CPU to grow the body.
const COMPRESSIBLE = Set(("text/html", "text/javascript", "text/css", "application/json",
                          "image/svg+xml", "application/xml", "application/wasm"))

# Under this, the gzip header and trailer are most of what would be sent.
const GZIP_MIN_BYTES = 1024

# Gzipped bodies keyed by absolute path, each held with the modification time and size the file had
# when it was compressed. The viewer dist is rebuilt while a server runs, so an entry whose stamp no
# longer matches the file on disk is recompressed rather than served.
# Unbounded and process-global — one entry per compressible file ever requested, a few
# dozen for a viewer dist. Bound it if a mount ever serves generated paths.
const GZIP_CACHE = Dict{String,Tuple{Tuple{Float64,Int},Vector{UInt8}}}()
const GZIP_CACHE_LOCK = ReentrantLock()

# A file's identity for cache purposes: its modification time and its size.
file_stamp(file::AbstractString) = (mtime(file), Int(filesize(file)))

# The validator a client revalidates against, derived from the stamp rather than from the content:
# the viewer bundle is ~11 MB and hashing it per request would cost more than the transfer it saves.
# The modification time goes in as its exact bits, so a rebuild landing in the same second as the
# previous one still changes the tag.
file_tag(stamp::Tuple{Float64,Int}) =
    string('"', string(reinterpret(UInt64, stamp[1]); base = 16), '-',
           string(stamp[2]; base = 16), '"')

# The gzip of `file`, compressed once per `stamp` it is seen at.
function gzipped(file::AbstractString, stamp::Tuple{Float64,Int})
    lock(GZIP_CACHE_LOCK) do
        hit = get(GZIP_CACHE, file, nothing)
        hit !== nothing && first(hit) == stamp && return last(hit)
        # Compresses under the lock, so two first-time requests for different files
        # serialize. Paid once per file per build, which is cheaper than the machinery to avoid it.
        gz = transcode(GzipCompressor, read(file))
        GZIP_CACHE[file] = (stamp, gz)
        return gz
    end
end

# Whether `file` lies strictly under the mount root `root`. The path-traversal guard: a request may
# reach a file inside its mount and nothing else.
#
# Compare the path elements, and never the two strings. A string comparison has to name a separator,
# which is `\` on Windows and `/` everywhere else, so `root * "/"` matches nothing at all on Windows
# and the mount serves none of its own files — with the server reporting no fault. `splitpath` reads
# either separator and drops a trailing one, so a root written with a slash still agrees with a file
# `joinpath` built with a backslash.
#
# Strictly under: the file must have more elements than the root, so a sibling directory like
# `<root>Evil` cannot pass, and neither can the root itself.
function under_root(file, root)
    r = splitpath(root)
    f = splitpath(file)
    return length(f) > length(r) && view(f, eachindex(r)) == r
end

function serve_static(server::Server, stream)
    path = split(stream.message.target, '?')[1]
    path == "/" && (path = "/index.html")
    mount = mount_for(server, path)
    if mount === nothing
        HTTP.setstatus(stream, 404); HTTP.startwrite(stream); return
    end
    root, rel = mount
    file = normpath(joinpath(root, rel))
    under = under_root(file, root)
    if !under || !isfile(file)
        HTTP.setstatus(stream, under ? 404 : 403)
        HTTP.startwrite(stream); return
    end
    stamp = file_stamp(file)
    tag = file_tag(stamp)
    ctype = get(MIME_TYPES, lowercase(splitext(file)[2]), "application/octet-stream")
    HTTP.setheader(stream, "Content-Type" => ctype)
    HTTP.setheader(stream, "ETag" => tag)
    # Revalidate every time rather than expire: nothing here is served under a versioned URL, so a
    # client allowed to skip the ask would keep one build until its own cache turned over. The ask
    # costs a round trip, and only a file that has actually changed costs its bytes.
    HTTP.setheader(stream, "Cache-Control" => "no-cache")
    # The body depends on what the client accepts, so anything caching in front of this must say so.
    HTTP.setheader(stream, "Vary" => "Accept-Encoding")
    # `If-None-Match` carries a list, and may carry `*`; a tag is a quoted token, so finding ours
    # anywhere in the list is the match. HTTP.jl writes no body for a 304.
    inm = HTTP.header(stream.message, "If-None-Match")
    if inm == "*" || occursin(tag, inm)
        HTTP.setstatus(stream, 304); HTTP.startwrite(stream); return
    end
    compress = ctype in COMPRESSIBLE && stamp[2] >= GZIP_MIN_BYTES &&
               occursin("gzip", HTTP.header(stream.message, "Accept-Encoding"))
    body = compress ? gzipped(file, stamp) : read(file)
    compress && HTTP.setheader(stream, "Content-Encoding" => "gzip")
    HTTP.setstatus(stream, 200)
    HTTP.setheader(stream, "Content-Length" => string(length(body)))
    HTTP.startwrite(stream)
    write(stream, body)
end
