# The file every running server writes, so that a picker can list the scenes this user serves: where
# the directory is, how the file is written in one step, which files are stale, and how the module
# set is written again. Only `refresh_discovery` is given a server, and it reads one field.

"""
    discovery_dir() -> String

The per-user directory every running server writes one file into, so that a picker can list the
scenes this user serves. The location comes from the first of these that applies:

| where | when |
|---|---|
| `\$XDG_RUNTIME_DIR/cesiumlink` | the environment sets it — `/run/user/<uid>`, mode 700 and cleared at logout, which is where VSCode keeps its own sockets |
| `%LOCALAPPDATA%\\cesiumlink` | on Windows |
| `~/.cache/cesiumlink` | otherwise |

Only the first of those is cleared at logout. Under either of the others a server that is killed
leaves its file behind for good, so a reader has to obey the stale rule below rather than treat it
as a nicety.

Each file is JSON and describes one server:

| field | what it holds |
|---|---|
| `port` | the port the server listens on |
| `ws` | the WebSocket URL a client on this machine connects to, route and all |
| `pid` | the process that serves it |
| `title` | the `title` given to [`start_server`](@ref) |
| `started` | when the server started, as an ISO 8601 instant in UTC |
| `dist` | the built viewer this package resolved, [`viewer_dist()`](@ref viewer_dist) |
| `imagery` | where the basemap tiles are: the mounted directory, or the declared URL. Absent when the scene declares no basemap |
| `assets` | every directory the server serves, by mount name |
| `modules` | every registered module's own directory, by module id |
| `trustedOrigins` | the origins the page may reach off-site |

`ws` is stated here rather than built by the reader out of `port`. The route and the host are the
server's own facts: a server bound to `::1` answers no URL that names `127.0.0.1`, and a reader that
builds one from a rule of its own is a second statement of the route to keep in step.

A reader that hosts the page itself mounts the `dist` directory rather than fetching it over HTTP,
so the reader and the server must share a filesystem. The field records the tree the package
resolved whatever `dist_dir` says: a server started with `dist_dir = nothing` serves no assets over
HTTP and still names the same directory here. A reader on another machine finds a path that does
not exist, and reports it.

`imagery`, `assets`, `modules` and `trustedOrigins` are there for the same reader, and for the same
reason: it builds the page before it opens a socket, so it cannot wait for the declaration. A
directory is one more tree to mount, and an origin is one more host the page may load from. A reader
that serves the page over HTTP needs none of them, and ignores the fields.

`modules` is written again by every [`register_module!`](@ref), because modules are registered after
`start_server` returns. A reader that took its copy before then finds a module missing, and must
re-read the file rather than cache it.

The file name is the pid and the port, so two servers in one process each get their own.
[`stop_server`](@ref) removes the file.

## Which files are live

**A file is live while its port answers. A reader shows no scene whose port answers nothing.** The
port is the whole of the rule, and it is the half both ends can always ask: a process that still runs
is no proof that the server inside it does, because a REPL reset takes the server away and leaves the
process.

The pid is an optimisation on top of that rule, and each end takes it as far as its platform allows.
It costs nothing and it drops most stale files before any socket work, so both ends ask it first
where they can. It cannot decide on its own either way: a pid that is gone means the file is stale,
and a pid that runs means nothing.

- Julia asks with `kill(pid, 0)`, which Base offers on unix alone. Off unix this package answers "it
  may be running" and lets the port decide, which keeps a file too many rather than one too few.
- The extension asks with `process.kill(pid, 0)`, which Node offers on every platform, and keeps a
  file it is refused permission to ask about.

The two therefore drop different numbers of stale files on Windows, and never show a different set of
scenes, because the port decides in both.

[`start_server`](@ref) removes the stale files, so a process killed before it reached
[`stop_server`](@ref) leaves nothing behind for long. The reader never removes one: it is a reader.
"""
function discovery_dir()
    runtime = get(ENV, "XDG_RUNTIME_DIR", "")
    isempty(runtime) || return joinpath(runtime, "cesiumlink")
    local_app = Sys.iswindows() ? get(ENV, "LOCALAPPDATA", "") : ""
    isempty(local_app) || return joinpath(local_app, "cesiumlink")
    return joinpath(homedir(), ".cache", "cesiumlink")
end

# Put `content` in `file` in one step, replacing whatever was there.
#
# A reader opens the discovery file at a moment this process does not choose: the editor extension
# reads it as soon as the push reaches the editor, and `register_module!` writes it again right
# after `start_server` returns. `open(file, "w")` truncates in place, so a read between the truncate
# and the last byte returns a fragment, and the reader drops a scene that is running. A rename
# inside one directory replaces the file in one step, and every reader sees one version or the other.
function write_atomically(file, content)
    tmp = "$(file).$(Base.Libc.getpid()).tmp"
    try
        write(tmp, content)
        # The renamed file brings its own mode, so carry over the mode of the file it replaces.
        # A write in place keeps the mode, and the discovery file is deliberately 0600.
        isfile(file) && (try; chmod(tmp, filemode(file) & 0o777); catch; end)
        # `rename` and not `mv(; force = true)`: `mv` removes the destination and then renames, and
        # a reader that opens the file between the two finds nothing there. Which is the whole point
        # of writing it this way, and the gap is wide enough that Windows lands in it.
        Base.Filesystem.rename(tmp, file)
    catch
        rm(tmp; force = true)
        rethrow()
    end
    return file
end

# Tighten the modes, and let the file stand if the filesystem will not take them. A directory the
# user does not own — a shared cache, an exported home — refuses the chmod, and a discovery file
# nobody can lock down is still a discovery file that works.
function chmod_quietly(dir, dir_mode, file, file_mode)
    try
        chmod(dir, dir_mode)
        chmod(file, file_mode)
    catch e
        @debug "could not tighten the discovery file's mode" exception = e
    end
end

# Whether anything is listening on `port` of the loopback.
function port_answers(port::Integer)
    try
        close(Sockets.connect(Sockets.localhost, port))
        return true
    catch
        return false
    end
end

# Whether the process that wrote a discovery file is still running. See the liveness rule in
# `discovery_dir`'s docstring: this is the optimisation half of it, and the port decides.
#
# `kill(pid, 0)` sends no signal and only asks. A process of one's own always answers, so a zero
# return means it is there. Base offers no such call off unix, so this answers "it may be running"
# there and leaves the port to decide — one file too many, which is the direction to err in.
process_alive(pid::Integer) =
    !Sys.isunix() || ccall(:kill, Cint, (Cint, Cint), pid, 0) == 0

# Drop the discovery files of servers that have stopped. A server removes its own in `stop_server`,
# so this collects the ones a killed process left behind. Nothing else ever would, and the directory
# grows for as long as the machine stands.
#
# Both halves of the name are read, and the process is asked about first — which is also the order a
# reader asks in. The port alone is not enough: a scene is usually served on a port somebody picked
# and reuses, so a file from a process that died last week names a port that answers today, and a
# sweep that trusted the port would keep every one of them.
#
# Housekeeping, so it never costs the caller a session: a file that cannot be read or removed is left
# where it is.
function sweep_discovery(dir)
    for name in readdir(dir; join = true)
        endswith(name, ".json") || continue
        stamp = discovery_stamp(basename(name))
        stamp === nothing && continue
        pid, port = stamp
        try
            (process_alive(pid) && port_answers(port)) || rm(name; force = true)
        catch e
            @debug "could not remove a stale discovery file" file = name exception = e
        end
    end
    return nothing
end

# The `(pid, port)` a discovery file's name carries, or `nothing` for a name that carries neither.
function discovery_stamp(name)
    parts = rsplit(name[1:(end - length(".json"))], '-'; limit = 2)
    length(parts) == 2 || return nothing
    pid, port = tryparse(Int, parts[1]), tryparse(Int, parts[2])
    return pid === nothing || port === nothing ? nothing : (pid, port)
end

# Write the discovery file for a server on `port` and return its path, or `nothing` if the directory
# refused it. A directory that cannot be written costs a warning rather than the server: the scene
# still serves, and a picker that cannot find it is a smaller loss than a session that never starts.
function write_discovery(port::Integer, title::AbstractString, imagery = nothing;
                         host::AbstractString = "127.0.0.1",
                         assets = Dict{String,String}(), trusted_origins = String[],
                         modules = Dict{String,String}())
    pid = Int(Base.Libc.getpid())
    try
        dir = discovery_dir()
        mkpath(dir)
        # Before this server's own file goes in, so the directory holds the servers that are running
        # and nothing else. Our own port is already bound and answers, so it is never swept.
        sweep_discovery(dir)
        file = joinpath(dir, "$pid-$port.json")
        entry = Dict("port" => Int(port),
                     # The route as well as the number, so a reader connects with what the file says
                     # rather than with a rule of its own. A wildcard bind answers on every
                     # interface, and `url_host` names the loopback for it, exactly as `viewer_url`
                     # does for the page.
                     "ws" => "ws://$(url_host(host)):$(Int(port))/ws",
                     "pid" => pid, "title" => String(title),
                     "started" => Dates.format(Dates.now(Dates.UTC), "yyyy-mm-ddTHH:MM:SSZ"),
                     # A reader that hosts the page itself needs the directory before it opens a
                     # socket, so the path travels here rather than on the wire.
                     "dist" => viewer_dist(),
                     # Both of these reach the editor extension before it builds the page: a webview
                     # is given its resource roots and its policy when its panel is created, and
                     # neither can be changed afterwards without dropping the scene.
                     "assets" => assets,
                     # A host that serves the page itself must reach each module's own directory,
                     # and a module may be registered after this file is written — so
                     # `register_module!` writes this key again.
                     "modules" => modules,
                     "trustedOrigins" => trusted_origins)
        imagery === nothing || (entry["imagery"] = imagery)
        write_atomically(file, JSON.json(entry))
        # `/run/user/<uid>` is already 700, but the two fallbacks sit under directories that are
        # usually world-readable. A scene binds to loopback, and on a shared machine loopback is
        # shared: naming the port to every other user is worth a chmod. This does not make the
        # scene private — a port scan finds it anyway — it only stops the file from handing it over.
        Sys.isunix() && chmod_quietly(dir, 0o700, file, 0o600)
        return file
    catch e
        @warn "could not write the discovery file; a picker will not list this server" exception = e
        return nothing
    end
end

# Each registered module's own directory, by id — the directory `/modules/<id>/` answers out of. A
# host that does not serve the page from this server needs every one of them, exactly as it needs
# every assets mount.
module_dirs(server) = Dict(m.id => dirname(m.path) for m in server.modules)

# Write the module set into the discovery file again. `start_server` writes that file, and modules
# are registered after it returns, so the set in the file is otherwise always empty. A file that
# cannot be updated costs a debug line: the scene serves either way, and only a host that hosts the
# page itself reads this.
function refresh_discovery(server::Server)
    server.discovery_file === nothing && return nothing
    try
        entry = JSON.parsefile(server.discovery_file)
        entry["modules"] = module_dirs(server)
        write_atomically(server.discovery_file, JSON.json(entry))
    catch e
        @debug "could not write the module set into the discovery file" exception = e
    end
    return nothing
end
