// Runnable check for the paging pass: which names a camera height and a view rectangle keep.
// Run: node lib/core/src/annotations.test.mjs
//
// The pass is pure, but the module it lives in draws through Cesium, so the module is bundled here
// against a stand-in that exports the names and nothing behind them.
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const { outputFiles } = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./annotations.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
  plugins: [{
    name: "cesium-stand-in",
    setup(build) {
      build.onResolve({ filter: /^@cesium\/engine$/ }, () => ({ path: "c", namespace: "stand-in" }));
      build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
        contents: [
          "Cartesian3", "Color", "GeoJsonDataSource", "HeightReference", "HorizontalOrigin",
          "LabelCollection", "LabelStyle", "VerticalOrigin",
        ].map((n) => `export const ${n} = {};`).join("\n"),
        loader: "js",
      }));
    },
  }],
});
const { annotationBase, levelAt, visibleNames } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

const place = (name, lon, lat, minz, maxz, importance = 1) =>
  ({ name, lon, lat, minz, maxz, importance, kind: "city" });
const rect = (west, south, east, north) => {
  const rad = Math.PI / 180;
  return { west: west * rad, south: south * rad, east: east * rad, north: north * rad };
};

// --- the annotation directory sits beside the Cesium tree, in whatever form the host names it ---
{
  assert.equal(annotationBase("cesium/"), "annotations/", "a browser page names a relative base");
  assert.equal(annotationBase("cesium"), "annotations/", "with or without its slash");
  assert.equal(annotationBase("https://host/x/y/cesium/"), "https://host/x/y/annotations/",
               "a webview names an absolute one, and it stays absolute");
  assert.equal(annotationBase("/dist/cesium/"), "/dist/annotations/", "an absolute path stays one");
}

// --- the camera height reads as a geographic level, and never below zero ---
{
  assert.equal(levelAt(4e7), 0, "the whole globe is level 0");
  assert.equal(levelAt(2e7), 1, "and each level down halves the height");
  assert.equal(levelAt(1e8), 0, "a camera further out than the globe is still level 0");
}

// --- a name is kept only on the levels it declares, both ends inclusive ---
{
  const rows = [place("deep", 0, 0, 5, 9), place("shallow", 0, 0, 0, 2), place("here", 0, 0, 2, 5)];
  const names = (level) => visibleNames(rows, level, undefined).map((r) => r.name);
  assert.deepEqual(names(0), ["shallow"], "level 0 carries only what starts there");
  assert.deepEqual(names(2).sort(), ["here", "shallow"], "the last level of a name still draws it");
  assert.deepEqual(names(5).sort(), ["deep", "here"], "and so does the first");
  assert.deepEqual(names(4), ["here"], "a level between the two ends keeps the one that spans it");
}

// --- only what the view holds, and a view across the antimeridian holds the outside of its pair ---
{
  const rows = [place("Tokyo", 139, 36, 0, 9), place("Rome", 12, 42, 0, 9),
                place("Suva", -178, -18, 0, 9)];
  const inside = (view) => visibleNames(rows, 5, view).map((r) => r.name).sort();
  assert.deepEqual(inside(rect(0, 30, 30, 50)), ["Rome"], "a plain view keeps what lies between");
  assert.deepEqual(inside(rect(170, -60, -170, 60)), ["Suva"],
                   "a view whose west runs past its east wraps rather than emptying");
  assert.deepEqual(inside(undefined), ["Rome", "Suva", "Tokyo"],
                   "a camera looking past the globe has no rectangle, and nothing is filtered out");
}

// --- the cap holds whatever the camera height, and the names it keeps are the ranked ones ---
{
  const many = [];
  for (let i = 0; i < 5000; i++) many.push(place(`city ${i}`, i % 180, 0, 0, 9, i));
  const kept = visibleNames(many, 9, undefined);
  assert.equal(kept.length, 400, "the collection is capped at what a frame can afford");
  assert.equal(kept[0].name, "city 4999", "and the cap keeps the most important names");
  assert.ok(kept.every((r) => r.importance >= 4600), "every one of them, in rank order");
}

// --- the shallowest level first, so a continent outranks a city that shares its view ---
{
  const rows = [place("a city", 0, 0, 4, 9, 9e9), place("an ocean", 0, 0, 0, 9, 1)];
  assert.deepEqual(visibleNames(rows, 5, undefined).map((r) => r.name), ["an ocean", "a city"],
                   "importance ranks within a level and not across two");
}

console.log("annotations: ok");
