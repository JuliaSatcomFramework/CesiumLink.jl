try; import KaimonSlate; catch; error("This is a Kaimon Slate notebook — running it as plain Julia needs the KaimonSlate runtime in this environment. Add it with `import Pkg; Pkg.add(\"KaimonSlate\")`, or open it in Kaimon Slate."); end; KaimonSlate.standalone!(@__MODULE__; dir=@__DIR__)

#%% md id=intro
@md"""
# The Constellation scene in a notebook

This notebook draws the scene of `run.jl` in one cell.

The cell below starts a server and gives it back. A cell that gives back a server draws the scene on
the socket the page already holds. So a notebook worker on a remote machine needs no forwarded port.

This file sits beside the `Project.toml` of the example, and the worker gets that environment.

Stop the server with `stop_server(server)`. The server keeps serving when you close the viewer.
"""

#%% code id=scene
using CesiumLink, Constellation

server = start_server(; title = "Constellation notebook")
serve_scene!(server, ConstellationScene())
server

# ╔═╡ Slate.config · per-notebook settings (Settings panel)
#   docid = 0dbe7a72-3371-4c56-8d84-3506f2301cf2
# ╚═╡
