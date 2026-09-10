// Runnable check for the graticule's geometry: how a line is cut, what it is labelled, and which
// runs of it the camera can see.
// Run: node lib/core/src/globe.test.mjs
//
// The three passes are pure, but the module they live in draws through Cesium, so the module is
// bundled here against a stand-in that exports the names and nothing behind them.
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const { outputFiles } = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./globe.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  write: false,
  plugins: [{
    name: "cesium-stand-in",
    setup(build) {
      build.onResolve({ filter: /^@cesium\/engine$/ }, () => ({ path: "c", namespace: "stand-in" }));
      build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
        contents: [
          "ArcType", "Cartesian3", "ColorGeometryInstanceAttribute", "GeometryInstance",
          "HeightReference", "HorizontalOrigin", "LabelCollection", "LabelStyle", "Material",
          "PolylineCollection", "PolylineColorAppearance", "PolylineGeometry", "Primitive",
          "SceneMode", "SceneTransforms", "VerticalOrigin",
        ].map((n) => `export const ${n} = {};`).join("\n")
          // `annotations.ts` comes in with this module and reads its line colours as it loads.
          + "\nexport const Color = { BLACK: { withAlpha: () => ({}) },"
          + " WHITE: { withAlpha: () => ({}) }, fromCssColorString: (c) => c };",
        loader: "js",
      }));
    },
  }],
});
const { cuts, graticuleGeometry, meridianLabel, parallelLabel, visibleRuns } = await import(
  "data:text/javascript," + encodeURIComponent(outputFiles[0].text)
);

// --- a line is cut for its own length, so a short circle spends fewer vertices than the equator ---
{
  assert.equal(cuts(180, 1), 60, "a meridian spans 180° and is cut at 3°");
  assert.equal(cuts(360, 1), 120, "so is the equator, over twice the span");
  // The chord error rises with the radius the segment is cut from, so cutting by the root holds
  // that error steady rather than the segment length.
  assert.equal(cuts(360, Math.cos((60 * Math.PI) / 180)), 85, "a parallel at 60° takes 85, not 120");
  assert.equal(cuts(360, Math.cos((80 * Math.PI) / 180)), 51, "and one at 80° takes 51");
  assert.equal(cuts(1, 1), 2, "no line is fewer than two segments");
  assert.equal(cuts(360, 0), 2, "including one cut from a circle of no radius at all");
}

// --- a degree reads as a hemisphere and a number, and zero as neither ---
{
  assert.equal(meridianLabel(0), "0°", "the prime meridian names no hemisphere");
  assert.equal(parallelLabel(0), "0°", "and neither does the equator");
  assert.equal(meridianLabel(30), "30°E");
  assert.equal(meridianLabel(-150), "150°W");
  assert.equal(parallelLabel(45), "45°N");
  assert.equal(parallelLabel(-22.5), "22.5°S", "a fractional spacing keeps its fraction");
}

// --- the lines of a graticule, and the two axes its numbers stand along ---
{
  const { lines, labels } = graticuleGeometry(30, 20);

  // 12 meridians: ±180° is one line and not two.
  const meridians = lines.filter((l) => l.lon[0] === l.lon[l.lon.length - 1]);
  assert.equal(meridians.length, 12, "360° at 30° apart is 12 meridians, counting -180° once");
  assert.ok(!meridians.some((l) => l.lon[0] === 180), "and 180° is not one of them");

  // 90 is not a multiple of 20, so the outermost parallel stands at 80° and the poles carry none.
  const parallels = lines.filter((l) => l.lat[0] === l.lat[l.lat.length - 1]);
  assert.deepEqual(parallels.map((l) => l.lat[0]), [-80, -60, -40, -20, 0, 20, 40, 60, 80]);

  // Every line closes on the span it covers, whatever it was cut into.
  for (const line of meridians) {
    assert.equal(line.lat[0], -90);
    assert.equal(line.lat[line.lat.length - 1], 90);
    assert.equal(line.lon.length, line.lat.length, "a vertex is one longitude and one latitude");
  }
  for (const line of parallels) {
    assert.equal(line.lon[0], -180);
    assert.equal(line.lon[line.lon.length - 1], 180);
  }

  // A meridian is labelled at the equator and a parallel at the prime meridian, so the numbers
  // stand along two axes rather than repeating across the map.
  assert.ok(labels.filter((l) => l.lat === 0).every((l) => l.lon !== 0 || l.text === "0°"));
  assert.ok(labels.filter((l) => l.lon === 0 && l.lat !== 0).every((l) => l.text.endsWith("N") ||
    l.text.endsWith("S")));
  // One label serves both where the two axes meet: 12 meridians and 9 parallels give 20, not 21.
  assert.equal(labels.length, 20);
  assert.equal(labels.filter((l) => l.text === "0°").length, 1);
}

// --- a spacing that divides 90 puts a parallel one step short of each pole ---
{
  const { lines } = graticuleGeometry(10, 10);
  const parallels = lines.filter((l) => l.lat[0] === l.lat[l.lat.length - 1]);
  assert.equal(parallels[0].lat[0], -80, "10° divides 90, so the outermost parallel is 80° and not 90°");
  assert.equal(parallels[parallels.length - 1].lat[0], 80);
}

// --- only the runs on the camera's own side of the Earth are drawn ---
{
  assert.deepEqual(visibleRuns([true, true, true]), [[0, 2]], "a whole line is one run");
  assert.deepEqual(visibleRuns([false, false]), [], "and a line behind the globe is none");
  assert.deepEqual(visibleRuns([false, true, true, false, true, true, true]), [[1, 2], [4, 6]],
                   "a line crossing the limb twice is two runs");
  // A run stops at the last vertex before the limb, so a line reaches it from inside rather than
  // overshooting into space.
  assert.deepEqual(visibleRuns([true, true, false, false]), [[0, 1]]);
  // One vertex is a point, and a point is not a line.
  assert.deepEqual(visibleRuns([true, false, true, true]), [[2, 3]]);
  assert.deepEqual(visibleRuns([]), []);
}

console.log("globe.test.mjs: ok");
