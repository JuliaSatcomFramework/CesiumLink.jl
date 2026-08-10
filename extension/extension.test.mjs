// What the extension decides before the panel exists: which directories the webview may read, which
// origins its policy admits, and what the page is told about both. All three are fixed when the
// panel is created and none can be changed afterwards without dropping the scene, so getting them
// wrong shows up as a page that silently loads nothing.
//
// `vscode` exists only inside the editor host, so it is stubbed here. Nothing below touches it.
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
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
const { imageryOrigin, readableMounts, sceneMounts, pageHtml, activate } =
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

test("only a basemap declared as a URL contributes an origin", () => {
  assert.equal(imageryOrigin("https://cdn.test/tiles/{z}/{x}/{y}.png"), "https://cdn.test");
  assert.equal(imageryOrigin("https://cdn.test:8443/a"), "https://cdn.test:8443");
  // A mounted pyramid is an entry in the assets map like any other, so it names no origin.
  assert.equal(imageryOrigin("/data/moon_tiles"), null);
  assert.equal(imageryOrigin(undefined), null);
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
