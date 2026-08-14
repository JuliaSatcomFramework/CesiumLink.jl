// Runnable check for the host bootstrap. Run: node lib/core/src/host.test.mjs
// (bundles host.ts in-memory via esbuild — no Cesium, no DOM.)
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const { outputFiles } = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./host.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
});
const { connectAndDeclare, ignoredByDeclaration } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

// A transport that answers the four calls the bootstrap makes. `declaration` is what the server
// declares, and a transport given none declares nothing at all — which is the wait that times out.
// The handler fires as it is registered, so a test needs no clock of its own.
function fake({ refuse = false, declaration = undefined } = {}) {
  return {
    sent: [],
    ready: refuse ? Promise.reject(new Error("refused")) : Promise.resolve(),
    notify(method, params) { this.sent.push({ method, params }); },
    on(method, handler) { if (method === "modules" && declaration) handler(declaration); },
    close() {},
  };
}

// --- a server that declares: the page says it is ready, and gets the declaration back ---
{
  const declared = { modules: [{ id: "ui" }], ellipsoid: { a: 1, b: 1 } };
  const t = fake({ declaration: declared });
  const got = await connectAndDeclare(t, 50);
  assert.deepEqual(got, { live: true, declaration: declared }, "the declaration comes back whole");
  assert.equal(t.sent.length, 1, "one message before the viewer exists");
  assert.equal(t.sent[0].method, "ready", "and it is `ready`");
  assert.equal(typeof t.sent[0].params.protocol, "number", "which announces the wire version");
}

// --- a connection that never opens: no `ready` is sent, and the reason comes back to the host ---
{
  const t = fake({ refuse: true });
  const got = await connectAndDeclare(t, 50);
  assert.equal(got.live, false, "a refused connection is not live");
  assert.equal(got.declaration, null, "and declares nothing");
  assert.match(String(got.error), /refused/, "the host is given the reason to report");
  assert.deepEqual(t.sent, [], "nothing is sent over a transport that never opened");
}

// --- a server that connects and declares nothing: live, but the globe is built without it ---
{
  const t = fake();
  const got = await connectAndDeclare(t, 10);
  assert.equal(got.live, true, "the connection is open");
  assert.equal(got.declaration, null, "and the wait ended with nothing declared");
}

// --- a live server's declaration overrules the address bar, and only where it states something ---
{
  const asked = { imagery: { url: "https://tiles.test" }, ellipsoid: { a: 2, b: 2 } };
  assert.deepEqual(ignoredByDeclaration(asked, null), [],
                   "a server that declared nothing overrules nothing");
  assert.deepEqual(ignoredByDeclaration(asked, { modules: [] }), [],
                   "a declaration that names neither leaves both parameters standing");
  assert.deepEqual(ignoredByDeclaration(asked, { modules: [], imagery: false }), ["?imagery"],
                   "a declared bare globe is a basemap decision, so it overrules ?imagery");
  assert.deepEqual(
    ignoredByDeclaration(asked, { modules: [], imagery: false, ellipsoid: { a: 1, b: 1 } }),
    ["?imagery", "?ellipsoid"], "both are named when the declaration states both");
  assert.deepEqual(ignoredByDeclaration({}, { modules: [], imagery: false }), [],
                   "a page that asked for nothing has nothing overruled");
}

console.log("host.test.mjs: all assertions passed");
