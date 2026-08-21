import test from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./source.ts";

test("an asset path is an asset, even though it holds a file extension", () => {
  // The `/` decides this, not the order of the tests. An asset path holds a file extension, so a
  // rule that keys on the extension sends every asset to the registry and fetches no file.
  assert.deepEqual(sourceOf("assets/models/sat.glb"),
    { kind: "asset", path: "assets/models/sat.glb" });
  assert.deepEqual(sourceOf("assets/pics/dish.png"), { kind: "asset", path: "assets/pics/dish.png" });
});

test("a malformed path is an asset too, so the caller names the real mistake", () => {
  // `createAssetUrl` answers this with `an asset path is assets/<mount>/<file>`. Read as a module
  // name, it would instead be reported as a name that nobody registered, which points nowhere.
  assert.deepEqual(sourceOf("asset/models/sat.glb"), { kind: "asset", path: "asset/models/sat.glb" });
});

test("a data URI is data, whatever else it holds", () => {
  // This URI holds a `/` and a `.`. The scheme is read first, so neither shape test sees it.
  const uri = "data:image/svg+xml;base64,PHN2Zy8+";
  assert.deepEqual(sourceOf(uri), { kind: "data", uri });
});

test("a name holding a dot and no slash is a module name", () => {
  assert.deepEqual(sourceOf("orbits.pulse"), { kind: "module", name: "orbits.pulse" });
});

test("a bare name is stock", () => {
  assert.deepEqual(sourceOf("disc"), { kind: "stock", name: "disc" });
  assert.deepEqual(sourceOf(""), { kind: "stock", name: "" });
});
