// What the extension decides before the panel exists: which directories the webview may read, which
// origins its policy admits, and what the page is told about both. All three are fixed when the
// panel is created and none can be changed afterwards without dropping the scene, so getting them
// wrong shows up as a page that silently loads nothing.
//
// `vscode` exists only inside the editor host, so it is stubbed here. Nothing below touches it.
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import net from "node:net";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lines = [];
const STUB = {
  window: {
    createOutputChannel: () => ({ appendLine: (l) => lines.push(l), dispose() {} }),
    registerUriHandler: () => ({ dispose() {} }),
  },
  Uri: { file: (p) => ({ fsPath: p }) },
  ThemeIcon: class {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  ViewColumn: { Active: 1 },
};
const realLoad = Module._load;
Module._load = (req, parent, isMain) =>
  req === "vscode" ? STUB : realLoad(req, parent, isMain);

// Through the default export: for a CommonJS module that is `module.exports` itself, and the named
// bindings Node's lexer offers are not reliable for an object literal built this way.
const { imageryCspSource, readableMounts, sceneMounts, pageHtml, activate,
        discoveryDir, isRunning, answers, scene } =
  (await import("./extension.js")).default;
// `log` is created in `activate`, and `readableMounts` writes to it when a directory is missing.
// The context carries what VSCode gives one, so `activate` announces the build it is running rather
// than reporting that it could not read it.
activate({
  subscriptions: [],
  extensionPath: dirname(fileURLToPath(import.meta.url)),
  extension: { packageJSON: { version: "0.0.0-test" } },
});

const WEBVIEW = { cspSource: "vscode-webview://x" };

test("a mount the extension host cannot see is dropped, and said so in the log", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-ext-"));
  mkdirSync(join(root, "glb"));
  const before = lines.length;
  assert.deepEqual(
    readableMounts({ models: join(root, "glb"), gone: join(root, "nowhere") }),
    { models: join(root, "glb") });
  // A root that does not exist would reach `createWebviewPanel` and fail as a page loading nothing.
  assert.match(lines[before], /"gone" names .*nowhere, which is not on this filesystem/);
});

test("a module directory is a root of its own, under a name no assets mount can take", () => {
  // A module shipped from its own package lives nowhere near the dist. Assuming the dist for it is
  // what left the panel unable to run any third-party module at all.
  const root = mkdtempSync(join(tmpdir(), "cesium-ext-"));
  mkdirSync(join(root, "rf"));
  mkdirSync(join(root, "pics"));
  const before = lines.length;
  assert.deepEqual(
    sceneMounts({ assets: { pics: join(root, "pics") },
                  modules: { rainfade: join(root, "rf"), gone: join(root, "nowhere") } }),
    { pics: join(root, "pics"), "modules/rainfade": join(root, "rf") });
  // The silence this ticket is about: a module the panel cannot reach must say so.
  assert.match(lines[before], /"modules\/gone" names .*nowhere, which is not on this filesystem/);
});

test("only a basemap declared as a URL contributes a source, and it names one path", () => {
  // The whole point of this rule: a shared CDN keeps every other repository it mirrors out of the
  // policy, because the source stops at the directory this scene reads.
  assert.equal(imageryCspSource("https://cdn.test/gh/tiler/marble@a1b2/tiles/{z}/{x}/{y}.jpeg"),
               "https://cdn.test/gh/tiler/marble@a1b2/tiles/");
  assert.equal(imageryCspSource("https://cdn.test:8443/a/b"), "https://cdn.test:8443/a/");
  // A TMS root names no placeholder at all, and a query is outside CSP path matching.
  assert.equal(imageryCspSource("https://cdn.test/tiles/?v=2"), "https://cdn.test/tiles/");
  // A placeholder in the host leaves no path to trust, and a cut into an authority would name a
  // host nobody declared.
  assert.equal(imageryCspSource("https://{s}.tile.test/{z}/{x}/{y}.png"), "https://{s}.tile.test");
  // `;` and `,` are outside the path grammar, and a space would split the joined list in two.
  assert.equal(imageryCspSource("https://cdn.test/a;b/{z}.png"), "https://cdn.test");
  assert.equal(imageryCspSource("https://cdn.test/a,b/{z}.png"), "https://cdn.test");
  assert.equal(imageryCspSource("https://cdn te.st/a/{z}.png"), null);
  // A quote would close the `content` attribute of the `<meta>` element `pageHtml` writes the
  // joined list into, and the rest of the URL would become markup in the page.
  assert.equal(imageryCspSource('https://cdn.test/a"x/{z}.png'), "https://cdn.test");
  assert.equal(imageryCspSource("https://cdn.test/a<x/{z}.png"), "https://cdn.test");
  // A mounted pyramid is an entry in the assets map like any other, so it names no source.
  assert.equal(imageryCspSource("/data/moon_tiles"), null);
  assert.equal(imageryCspSource(undefined), null);
});

test("the page is told the base of every mount it may reach", () => {
  const html = pageHtml(WEBVIEW, "vscode-webview://x/dist/",
                        { models: "vscode-webview://x/glb/", imagery: "vscode-webview://x/tiles/" },
                        []);
  assert.match(html, /globalThis\.CESIUM_LINK_MOUNTS = \{"models":"vscode-webview:\/\/x\/glb\/","imagery":"vscode-webview:\/\/x\/tiles\/"\};/);
  assert.match(html, /globalThis\.CESIUM_LINK_ASSET_BASE = "vscode-webview:\/\/x\/dist\/";/);
});

test("a trusted origin widens the image and the connection policy together", () => {
  // Cesium asks for a tile with `preferBlob`, so the request is a connection and not an image load.
  // One directive without the other draws a basemap on one code path and nothing on the other.
  const html = pageHtml(WEBVIEW, "b/", {}, ["https://cdn.test", "https://fonts.test"]);
  const csp = /content="([^"]*)"/.exec(html)[1];
  const of = (name) => csp.split("; ").find((d) => d.startsWith(name + " "));
  assert.ok(of("img-src").endsWith("https://cdn.test https://fonts.test"));
  assert.ok(of("connect-src").endsWith("https://cdn.test https://fonts.test"));
});

test("a session that trusts nothing names no origin at all", () => {
  const csp = /content="([^"]*)"/.exec(pageHtml(WEBVIEW, "b/", {}, []))[1];
  for (const name of ["img-src", "connect-src"]) {
    const d = csp.split("; ").find((x) => x.startsWith(name + " "));
    assert.equal(d, `${name} ${WEBVIEW.cspSource} blob: data:`, "no trailing space, no origin");
  }
});

test("a mount path cannot end the script block it is written into", () => {
  // The paths come off a file any local process may write, and they land inline in a `<script>`.
  const html = pageHtml(WEBVIEW, "b/", { evil: "vscode://x/</script><script>alert(1)</script>/" }, []);
  assert.ok(!html.includes("</script><script>alert(1)"), "the closing tag is escaped");
  assert.match(html, /\\u003c\/script>/);
});

Module._load = realLoad;

// --- the discovery file, as the reader sees it -----------------------------------------------
//
// `fixtures/discovery.json` is one file of the kind a running server writes. The Julia suite writes
// a real one and checks it carries the same fields, so a field added or renamed on the writing side
// fails a test here and there rather than showing up as a scene that will not open.

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "discovery.json"), "utf8"),
);

test("a scene row is read out of the file rather than derived from the port", () => {
  const s = scene(FIXTURE);
  // The route and the host come from the file: a server bound to `::1` answers no URL naming
  // `127.0.0.1`, so the reader must never build this one itself.
  assert.equal(s.url, "ws://127.0.0.1:54321/ws");
  assert.equal(s.port, 54321);
  assert.equal(s.label, "the fixture scene");
  assert.equal(s.dist, "/home/somebody/.julia/artifacts/f1x7u2e/dist");
  assert.deepEqual(s.assets, { models: "/data/glb" });
  assert.deepEqual(Object.keys(s.modules), ["primitives"]);
  assert.deepEqual(s.trustedOrigins, ["https://tiles.example"]);
  // The three the panel needs before it exists all come from this one file.
  assert.equal(imageryCspSource(s.imagery), "https://tiles.example/");
});

test("a file from a server older than the `ws` field still opens", () => {
  const { ws, ...older } = FIXTURE;
  assert.equal(scene(older).url, "ws://localhost:54321/ws", "the route such a server answered on");
});

test("the picker's directory is the one the server writes into", () => {
  const dir = discoveryDir();
  assert.ok(dir.endsWith("cesiumlink"), `expected a cesiumlink directory, got ${dir}`);
  // The first branch of the three, which is the one a Linux session takes.
  if (process.env.XDG_RUNTIME_DIR) {
    assert.equal(dir, join(process.env.XDG_RUNTIME_DIR, "cesiumlink"));
  }
});

test("liveness asks the pid first and the port last", async () => {
  assert.equal(isRunning(process.pid), true, "this very process is running");
  // A pid nothing can be running under. `isRunning` answers for the pid alone, and the port is what
  // decides — so a scene on a port that answers nothing is never shown, whatever the pid says.
  assert.equal(isRunning(0x7fffffff), false);
  assert.equal(await answers("ws://localhost:1/ws"), false,
               "port 1 is privileged, so no scene of ours holds it");

  // The probe dials the address the scene's URL names. A server bound to `::1` answers nothing on
  // `127.0.0.1`, and many machines resolve `localhost` to that address alone.
  const server = net.createServer();
  await new Promise((done) => server.listen(0, "::1", done));
  try {
    const { port } = server.address();
    assert.equal(await answers(`ws://[::1]:${port}/ws`), true, "an IPv6 loopback server answers");
  } finally {
    server.close();
  }
});
