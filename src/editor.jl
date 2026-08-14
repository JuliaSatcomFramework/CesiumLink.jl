# How a scene reaches a VSCode tab: the URI the extension answers on, the two command lines VSCode
# ships and the option each one takes. It asks the editor and never the server, so nothing here
# holds the lock.

# The URI the editor extension answers on. The port travels in the path, and not in a query: the
# VSCode command line percent-encodes a query on its way to the handler, so `?port=50005` arrives
# there as `port%3D50005`.
scene_uri(port::Integer) = "vscode://disberd.cesiumlink/open/$(Int(port))"

# Whether this process was started from a VSCode terminal. `TERM_PROGRAM` survives into a subshell
# and into `tmux`, where it names a window this process is no longer attached to. The socket the
# command line needs is the stronger signal, so ask for it first.
in_vscode_terminal() =
    haskey(ENV, "VSCODE_IPC_HOOK_CLI") || get(ENV, "TERM_PROGRAM", "") == "vscode"

# What VSCode calls its command line, in the order to try. Windows gets `code.cmd`: that is the name
# VSCode puts in the directory it adds to PATH, and `Sys.which` there looks for `code.exe` and
# `code.com` and for no other name, so a search for `code` alone finds nothing on every Windows
# machine that has VSCode installed.
editor_cli_names() = Sys.iswindows() ? ("code.cmd", "code.exe", "code") : ("code",)

# The `code` program VSCode put on PATH, and not another program of that name.
#
# A remote window reaches its editor through a command line in a `remote-cli` directory, and VSCode
# puts that directory on PATH for its own terminals. Another `code` can still come first — a user's
# own `~/bin/code`, or the standalone tunnel program, which rejects `--openExternal` outright. The
# push runs detached and discards its output, so the wrong program reads as a tab that never opens.
# Prefer the directory that names itself.
function editor_cli()
    names = editor_cli_names()
    for dir in split(get(ENV, "PATH", ""), Sys.iswindows() ? ';' : ':')
        endswith(dir, "remote-cli") || continue
        for name in names
            path = joinpath(dir, name)
            Sys.isexecutable(path) && return path
        end
    end
    for name in names
        found = Sys.which(name)
        found === nothing || return found
    end
    return nothing
end

# Which option opens a URI, for the command line that is going to answer.
#
# The two command lines take different options, and each ignores the other's. `--openExternal`
# belongs to the remote one alone: the desktop one does not know it, and reads the URI behind it as
# a file to open, which is a window that opens on nothing. `--open-url` belongs to the desktop one:
# the remote one drops it with a message on stderr and an exit status of 0, so the wrong flag there
# looks exactly like success.
#
# `VSCODE_IPC_HOOK_CLI` tells the two apart. VSCode sets it for a terminal of a **remote** window and
# never for a terminal of a local one, on every platform — so its absence does not mean "no editor",
# it means "the desktop command line".
editor_flag() = haskey(ENV, "VSCODE_IPC_HOOK_CLI") ? "--openExternal" : "--open-url"

# The command that asks the program at `path` to open `uri` through `flag`.
#
# A `.cmd` is a script for the command interpreter rather than an executable image, and VSCode's
# command line on Windows is `code.cmd`. Starting it directly fails with a message about a program
# that is not a valid application, so the interpreter runs it.
editor_command(path, uri, flag = editor_flag()) =
    endswith(lowercase(path), ".cmd") ? `cmd /c $path $flag $uri` : `$path $flag $uri`

# Ask a VSCode window to show the scene on `port` in an editor tab. Returns `nothing` when the
# request went out, or one line that says why it did not. `mode` is the `open` keyword of
# `start_server`: `true` asks wherever it runs, and anything else asks from a VSCode terminal
# alone.
function push_to_editor(port::Integer, mode)
    if mode !== true
        in_vscode_terminal() || return "the environment names no VSCode terminal"
    end
    code = editor_cli()
    code === nothing && return "no `code` program on PATH"
    try
        # This does not wait for the process. VSCode asks the user for permission before it hands
        # the URI to the extension, and it asks again for every scene until the user stops it. A
        # server that waits here waits on a human.
        run(pipeline(editor_command(code, scene_uri(port)); stdout = devnull,
                     stderr = devnull); wait = false)
    catch e
        return "the `code` program failed: $(sprint(showerror, e))"
    end
    return nothing
end
