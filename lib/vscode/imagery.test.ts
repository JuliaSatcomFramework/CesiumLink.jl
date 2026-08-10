import test from "node:test";
import assert from "node:assert/strict";
import { rebaseImagery } from "./imagery.ts";

const BASE = "https://x.vscode-webview.test/tiles/";

test("a mounted pyramid is served from the base the extension gives the page", () => {
  assert.deepEqual(rebaseImagery({ url: "assets/imagery/", layout: "tms" }, BASE),
    { url: BASE, layout: "tms" });
});

test("the path under the mount is kept, and the fields travel with it", () => {
  assert.deepEqual(
    rebaseImagery({ url: "assets/imagery/{z}/{x}/{y}.png", layout: "xyz", maxLevel: 2 }, BASE),
    { url: `${BASE}{z}/{x}/{y}.png`, layout: "xyz", maxLevel: 2 });
});

test("an absolute URL is already where it says it is", () => {
  const spec = { url: "https://tiles.test/{z}/{x}/{y}.png", layout: "xyz" } as const;
  assert.deepEqual(rebaseImagery(spec, BASE), spec);
});

test("no base leaves the declaration as it stands", () => {
  const spec = { url: "assets/imagery/", layout: "tms" } as const;
  assert.deepEqual(rebaseImagery(spec, ""), spec);
});

test("a recording made before the mount was named still rebases", () => {
  // A recording carries the declaration it was made with, and that one said `imagery/`.
  assert.deepEqual(rebaseImagery({ url: "imagery/{z}/{x}/{y}.png", layout: "xyz" }, BASE),
    { url: `${BASE}{z}/{x}/{y}.png`, layout: "xyz" });
});
