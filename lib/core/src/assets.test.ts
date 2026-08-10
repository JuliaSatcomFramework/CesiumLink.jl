import test from "node:test";
import assert from "node:assert/strict";
import { createAssetUrl, type AssetMounts } from "./assets.ts";

const MOUNTS: AssetMounts = { models: "assets/models/", imagery: "assets/imagery/" };

/** The resolver under test, plus the warnings it wrote. */
function build(base?: (name: string) => string | null, mounts: AssetMounts = MOUNTS) {
  const warnings: string[] = [];
  return { at: createAssetUrl(() => mounts, base, (m) => warnings.push(m)), warnings };
}

test("a host the server serves gets the declared path back unchanged", () => {
  const { at, warnings } = build();
  assert.equal(at("assets/models/sat.glb"), "assets/models/sat.glb");
  assert.equal(at("assets/imagery/3/4/5.png"), "assets/imagery/3/4/5.png");
  assert.deepEqual(warnings, [], "nothing to say about a path that already resolves");
});

test("a host on another origin gets the base it named, and the path under the mount", () => {
  const { at } = build((name) => `https://x.vscode-webview.test/${name}/`);
  assert.equal(at("assets/models/sat.glb"), "https://x.vscode-webview.test/models/sat.glb");
  // Several levels under the mount stay whole, which is what a tile path needs.
  assert.equal(at("assets/imagery/3/4/5.png"), "https://x.vscode-webview.test/imagery/3/4/5.png");
});

test("a path that is not an asset path answers nothing, and says so once", () => {
  const { at, warnings } = build();
  assert.equal(at("models/sat.glb"), null, "no `assets/` prefix");
  assert.equal(at("/assets/models/sat.glb"), null, "a leading slash is not the declared form");
  assert.equal(at("https://cdn.test/sat.glb"), null, "an absolute URL is not a mount path");
  assert.equal(at("assets/models/"), "assets/models/", "the mount root itself is a path under it");
  assert.equal(warnings.length, 3, "one line per distinct bad path");
  assert.match(warnings[0], /assets\/<mount>\/<file>/);
});

test("a mount the session never declared answers nothing", () => {
  const { at, warnings } = build(undefined, { models: "assets/models/" });
  assert.equal(at("assets/textures/grid.png"), null);
  assert.match(warnings[0], /declares no assets mount named "textures"/);
});

test("a mount this host cannot reach answers nothing, even though the session declared it", () => {
  // The extension drops a directory it cannot see on the filesystem, so the page is never given a
  // base for it. The path is well formed and the mount is real; this host just cannot fetch it.
  const { at, warnings } = build((name) => (name === "models" ? "vscode://x/models/" : null));
  assert.equal(at("assets/models/sat.glb"), "vscode://x/models/sat.glb");
  assert.equal(at("assets/imagery/0/0/0.png"), null);
  assert.match(warnings[0], /cannot reach the assets mount "imagery"/);
});

test("one warning per distinct path, however many times a family asks", () => {
  // A model family resolves once per entity per tick, so warning per call would fill the console
  // for as long as the scene runs.
  const { at, warnings } = build();
  for (let i = 0; i < 100; i++) at("nonsense");
  assert.equal(warnings.length, 1);
  at("more nonsense");
  assert.equal(warnings.length, 2, "a second bad path is still worth one line");
});

test("the mounts are read live, because the declaration arrives after the viewer is built", () => {
  let mounts: AssetMounts = {};
  const at = createAssetUrl(() => mounts, undefined, () => {});
  assert.equal(at("assets/models/sat.glb"), null, "before the declaration there is no mount");
  mounts = MOUNTS;
  assert.equal(at("assets/models/sat.glb"), "assets/models/sat.glb");
});
