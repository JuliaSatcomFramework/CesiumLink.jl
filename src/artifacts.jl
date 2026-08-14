# Where the built viewer is, and which file inside it a vendored module loads from. Both answer from
# the filesystem alone, and neither is given a server.

"""
    viewer_dist() -> String

The built viewer the package ships: the directory `start_server` serves the page, the Cesium runtime
and the vendored modules from. Pass a path of your own when developing the viewer itself.

The viewer sources are in `lib/`, beside the Julia sources. `npm run build` writes the bundle to
`lib/dist`, and that tree wins when it exists. An installed package has no `lib/dist`, so it gets the
tree from the `viewer` artifact, which downloads on the first call.
"""
function viewer_dist()
    built = normpath(joinpath(pkgdir(CesiumLink), "lib", "dist"))
    isdir(built) && return built
    # Say what is about to happen. This function is the default value of a keyword on `start_server`
    # and on `vendored`, so the first `start_server()` of an installed package otherwise stops for
    # about 9 MB with nothing on screen.
    hash = artifact_hash("viewer", joinpath(pkgdir(CesiumLink), "Artifacts.toml"))
    (hash === nothing || artifact_exists(hash)) ||
        @info "CesiumLink downloads the built viewer, about 9 MB. It is kept for later runs."
    return artifact"viewer"
end

"""
    vendored(id; dist_dir=viewer_dist()) -> ModuleEntry

The declaration entry for a module shipped inside the viewer dist: `:primitives`, the generic
renderer, `:ui`, the overlay panel and the tooltip, `:heatmap`, which drapes a grid of finished
colour over a box of degrees, and `:models`, which draws a glTF model per entity of a node family.
There is no privileged loading path: the entry it returns is
registered exactly like anyone else's, and the module runs only because it was declared.

A module is vendored when its vocabulary is domain-free. Each of these is told a shape, a value or a
colour and never a domain concept, so no package owns one of them more than another does. A module
that must be told about elevation angles or rain fade ships from the package that owns those words —
see [`register_module!`](@ref).

Registration order is the order the viewer draws and stacks these in, and nothing else: a module a
float mounts may be registered either side of the `:ui` that mounts it, because `ctx.modules` reaches
the whole declared set whatever the order.

```julia
register_module!(server, vendored(:primitives))
register_module!(server, vendored(:heatmap))
register_module!(server, vendored(:ui))
```
"""
function vendored(id; dist_dir = viewer_dist())
    path = joinpath(dist_dir, "modules", String(id), "$id.js")
    isfile(path) ||
        throw(ArgumentError("no vendored module $(repr(id)) at $path — build the viewer dist"))
    return ModuleEntry(id, path)
end
