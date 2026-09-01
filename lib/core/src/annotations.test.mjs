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
          "LabelCollection", "LabelStyle", "SceneTransforms", "VerticalOrigin",
        ].map((n) => `export const ${n} = {};`).join("\n"),
        loader: "js",
      }));
    },
  }],
});
const { annotationBase, behindGlobe, levelAt, visibleNames } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

const place = (name, lon, lat, minz, maxz, importance = 1, kind = "city") =>
  ({ name, lon, lat, minz, maxz, importance, kind });
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

// --- `importance` mixes units across the kinds, so the sort reads standing inside a kind ---
{
  // An ocean's area reads about 10,000 and a city's population reads millions. Raw, every ocean
  // sorts below every city and the cap drops the water.
  const rows = [place("an ocean", 0, 0, 0, 9, 10_000, "ocean")];
  for (let i = 0; i < 500; i++) rows.push(place(`city ${i}`, i % 180, 0, 0, 9, 1e6 + i));
  const kept = visibleNames(rows, 5, undefined).map((r) => r.name);
  assert.equal(kept.length, 400, "the cap still holds");
  assert.ok(kept.includes("an ocean"), "the only ocean is the first ocean, so the water is drawn");
  assert.ok(kept.indexOf("an ocean") < 2, "top of its kind stands with the top of every other");
  assert.ok(kept.includes("city 499"), "and the largest city keeps its place");
  assert.ok(!kept.includes("city 0"), "while the smallest is still what the cap drops");
}

// --- within one kind the order is `importance`, untouched ---
{
  const rows = [place("Vatican City", 12.4534, 41.9033, 3, 9, 832, "capital"),
                place("Rome", 12.4813, 41.8979, 3, 9, 3_339_000, "capital")];
  assert.deepEqual(visibleNames(rows, 5, undefined).map((r) => r.name), ["Rome", "Vatican City"],
                   "the bigger capital leads, whatever the alphabet says");
}

// --- the globe hides the far hemisphere, and the view rectangle cannot see that ---
{
  // Twenty thousand kilometres over the mid-Pacific, at 160 degrees west on the equator.
  const r = 6_371_000 + 20_000_000;
  const lon = -160 * Math.PI / 180;
  const eye = { x: r * Math.cos(lon), y: r * Math.sin(lon), z: 0 };
  assert.equal(behindGlobe(-160, 0, eye), false, "the point straight below the camera is in front");
  assert.equal(behindGlobe(20, 52, eye), true, "and Europe, half a world away, is behind");
  assert.equal(behindGlobe(0, -90, eye), true, "so is the south pole");
  // The limb of the disc, where a name would write half its text into space.
  const limb = -160 + 180 * Math.acos(6_371_000 / r) / Math.PI;
  assert.equal(behindGlobe(limb, 0, eye), true, "a name exactly on the limb goes with the far side");
  assert.equal(behindGlobe(limb - 10, 0, eye), false, "ten degrees inside it stays");
}

// --- and the pass drops what the globe hides ---
{
  const r = 6_371_000 + 20_000_000;
  const lon = -160 * Math.PI / 180;
  const eye = { x: r * Math.cos(lon), y: r * Math.sin(lon), z: 0 };
  const flat = { eye, window: (lo, la) => ({ x: (lo + 180) * 4, y: (90 - la) * 4 }) };
  const rows = [place("Honolulu", -157.85, 21.3, 0, 9, 1e6), place("EUROPE", 20, 52, 0, 9, 1e7)];
  assert.deepEqual(visibleNames(rows, 5, undefined, flat).map((r) => r.name), ["Honolulu"],
                   "a whole-world view rectangle keeps the far hemisphere; this does not");
}

// --- two names landing on the same pixels: the ranked one keeps them ---
{
  const eye = { x: 30_000_000, y: 0, z: 0 };
  // One screen pixel per hundredth of a degree, so places a few kilometres apart do collide.
  const flat = { eye, window: (lo, la) => ({ x: lo * 100 + 640, y: -la * 100 + 400 }) };
  const rows = [place("Vatican City", 12.4534, 41.9033, 3, 9, 832, "capital"),
                place("Rome", 12.4813, 41.8979, 3, 9, 3_339_000, "capital")];
  assert.deepEqual(visibleNames(rows, 5, undefined, flat).map((r) => r.name), ["Rome"],
                   "two kilometres apart is one box, and the larger capital owns it");
  const apart = [place("Rome", 12.48, 41.9, 3, 9, 3_339_000, "capital"),
                 place("Naples", 14.25, 40.84, 3, 9, 2_200_000, "capital")];
  assert.equal(visibleNames(apart, 5, undefined, flat).length, 2,
               "and names far enough apart both draw");
}

// --- a place the camera cannot put on the canvas takes no slot ---
{
  const eye = { x: 30_000_000, y: 0, z: 0 };
  const nowhere = { eye, window: (lo) => (lo > 0 ? { x: lo, y: 0 } : undefined) };
  const rows = [place("on", 10, 0, 0, 9, 1), place("off", -10, 0, 0, 9, 2)];
  assert.deepEqual(visibleNames(rows, 5, undefined, nowhere).map((r) => r.name), ["on"],
                   "the higher ranked name projects nowhere, and the pass moves on");
}

console.log("annotations: ok");
