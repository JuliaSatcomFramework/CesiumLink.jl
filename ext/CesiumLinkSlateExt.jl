module CesiumLinkSlateExt

using CesiumLink: Server, viewer_url
import SlateExtensionsBase as SEB

# A spike: the iframe host. It proves the extension triggers inside a Slate worker and that a Slate
# cell can frame another origin. The inline host is what the transport work replaces this with.
SEB.slate_render(s::Server) = SEB.html_fragment(
    """<iframe src="$(viewer_url(s))" style="width:100%;height:520px;border:0"></iframe>""")

end
