// The port of a scene URI, `vscode://<publisher>.cesiumlink/open/<port>`.
//
// The port travels in the path, and not in a query. The VSCode command line percent-encodes a
// query on its way to a handler: `?port=50005` arrives as `port%3D50005`, which every reader that
// splits on `=` finds nothing in. A path segment arrives as it was written.
//
// This file requires nothing, so a check can run it outside an editor.

/** The port the URI names, or `null` when the path names none. */
function scenePort(uriPath) {
  const m = /^\/open\/(\d+)$/.exec(uriPath || '');
  return m ? Number(m[1]) : null;
}

module.exports = { scenePort };
