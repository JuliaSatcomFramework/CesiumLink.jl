using TestItemRunner

# The tests start many servers, and a server started in a VSCode terminal asks the editor for a
# tab. The editor asks the user for permission, one dialog per scene, so a suite run from such a
# terminal stops on a stack of them. Hide the two variables that name the terminal: the test
# processes start from this environment.
delete!(ENV, "VSCODE_IPC_HOOK_CLI")
delete!(ENV, "TERM_PROGRAM")

# This walks every `.jl` file under the package root, and the package root is the repository root:
# `lib/`, `docs/`, `examples/` and `tools/` are all inside it. That is cheap — the walk reads only
# the files that end in `.jl`, and `lib/node_modules` holds none — but it does mean a `@testitem`
# written anywhere in the repository runs here.
#
# Do not narrow it to `run_tests("test")`. That call reads the package name out of the directory it
# is given, finds no `Project.toml` there, and silently stops importing `CesiumLink` into each test
# item. Every test then fails on an undefined name.
@run_package_tests
