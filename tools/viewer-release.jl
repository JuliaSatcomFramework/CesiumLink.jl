# Writes the `viewer` entry of `Artifacts.toml` for a tarball of `lib/dist`.
#
#     julia tools/viewer-release.jl viewer.tar.gz viewer-v0.1.2
#
# Both hashes come from the tarball itself, so the entry is correct for those exact bytes and for no
# others. The URL names a release that does not exist yet: `ViewerRelease.yml` prepares the entry on
# one run and publishes the asset on a later one, after the pull request carrying the entry is merged.

using Tar, SHA

length(ARGS) == 2 || error("usage: viewer-release.jl <tarball> <tag>")
tarball, tag = ARGS

# What Pkg checks the unpacked tree against, computed the way Pkg computes it.
tree = open(`gzip -dc $tarball`) do io
    Tar.tree_hash(io)
end
sha = bytes2hex(open(sha256, tarball))
repo = get(ENV, "GITHUB_REPOSITORY", "JuliaSatcomFramework/CesiumLink.jl")
url = "https://github.com/$repo/releases/download/$tag/viewer.tar.gz"

write(joinpath(@__DIR__, "..", "Artifacts.toml"), """
[viewer]
git-tree-sha1 = "$tree"
lazy = true

    [[viewer.download]]
    sha256 = "$sha"
    url = "$url"
""")

println("git-tree-sha1 = $tree")
println("sha256 = $sha")
