import test from "node:test";
import assert from "node:assert/strict";
import { moduleId, moduleUrl, MODULE_MOUNT } from "./modules.ts";

const DIST = "https://x.vscode-webview.test/dist/";
const MOUNTS = { "modules/rainfade": "https://x.vscode-webview.test/rf/", pics: "https://x/p/" };

test("a module the map names is imported from its own directory", () => {
  assert.equal(moduleUrl("/modules/rainfade/rainfade.js", MOUNTS, DIST),
    "https://x.vscode-webview.test/rf/rainfade.js");
  // A sibling chunk resolves against that same directory, which is why the whole directory is the
  // root and not the one file.
  assert.equal(moduleUrl("/modules/rainfade/chunk-ab12.js", MOUNTS, DIST),
    "https://x.vscode-webview.test/rf/chunk-ab12.js");
});

test("a module the map does not name keeps its path under the dist", () => {
  // The three vendored modules live in the dist, so they need no entry and must keep working.
  assert.equal(moduleUrl("/modules/primitives/entry.js", MOUNTS, DIST),
    `${DIST}modules/primitives/entry.js`);
  // And so must a server too old to write the module set into its discovery file.
  assert.equal(moduleUrl("/modules/rainfade/rainfade.js", {}, DIST),
    `${DIST}modules/rainfade/rainfade.js`);
});

test("a URL that is not a declared module keeps its path under the dist", () => {
  assert.equal(moduleUrl("/cesium/Workers/w.js", MOUNTS, DIST), `${DIST}cesium/Workers/w.js`);
  assert.equal(moduleUrl("/modules/rainfade/", MOUNTS, DIST), `${DIST}modules/rainfade/`);
});

test("an assets mount cannot be reached as a module directory", () => {
  // The map holds both namespaces, and an assets mount name is one path element with no `/` in it.
  assert.equal(MODULE_MOUNT("pics"), "modules/pics");
  assert.equal(moduleUrl("/modules/pics/pics.js", MOUNTS, DIST), `${DIST}modules/pics/pics.js`);
});

test("a declared module URL names its id, and nothing else does", () => {
  // The page reports this id to the host when the map does not name the module, and the host grants
  // the directory by building the panel again. An id it cannot read is a panel that stays broken.
  assert.equal(moduleId("/modules/rainfade/rainfade.js"), "rainfade");
  assert.equal(moduleId("modules/rainfade/chunk-ab12.js"), "rainfade");
  assert.equal(moduleId("/cesium/Workers/w.js"), undefined);
  assert.equal(moduleId("/modules/rainfade/"), undefined);
});
