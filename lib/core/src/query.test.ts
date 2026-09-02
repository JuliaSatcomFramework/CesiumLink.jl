import test from "node:test";
import assert from "node:assert/strict";
import { sceneFromQuery } from "./query.ts";

/** Read a query string, collecting whatever the helper warned about. */
const read = (query: string) => {
  const warnings: string[] = [];
  const scene = sceneFromQuery(new URLSearchParams(query), (m) => warnings.push(m));
  return { scene, warnings };
};

test("a template URL is an XYZ source, and takes tiling and maxlevel", () => {
  const { scene, warnings } = read("imagery=https://x.test/{z}/{x}/{y}.png&tiling=geographic&maxlevel=7");
  assert.deepEqual(scene.imagery, {
    url: "https://x.test/{z}/{x}/{y}.png", layout: "xyz", tiling: "geographic", maxLevel: 7,
  });
  assert.deepEqual(warnings, []);
});

test("gibs-geographic is a tiling scheme too", () => {
  const { scene, warnings } = read("imagery=https://x.test/{z}/{y}/{x}.jpeg&tiling=gibs-geographic");
  assert.equal(scene.imagery?.tiling, "gibs-geographic");
  assert.deepEqual(warnings, []);
});

test("a URL with no template is the directory of a TMS pyramid", () => {
  const { scene } = read("imagery=/tiles/moon");
  assert.deepEqual(scene.imagery, { url: "/tiles/moon", layout: "tms" });
});

test("a TMS pyramid states its own tiling scheme, so a stated one is dropped and said aloud", () => {
  const { scene, warnings } = read("imagery=/tiles/moon&tiling=geographic&maxlevel=3");
  assert.deepEqual(scene.imagery, { url: "/tiles/moon", layout: "tms" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tilemapresource\.xml/);
});

test("a mistyped tiling costs that parameter and nothing else", () => {
  const { scene, warnings } = read("imagery=https://x.test/{z}/{x}/{y}.png&tiling=geografic");
  assert.deepEqual(scene.imagery, { url: "https://x.test/{z}/{x}/{y}.png", layout: "xyz" });
  assert.equal(warnings.length, 1);
});

test("a maxlevel that is not a whole level is dropped", () => {
  // "" is the one that matters: `Number("")` is 0, which pins the globe flat at level 0.
  for (const bad of ["two", "1.5", "-1", "", "1e1", "0x2"]) {
    const { scene, warnings } = read(`imagery=https://x.test/{z}/{x}/{y}.png&maxlevel=${bad}`);
    assert.equal(scene.imagery?.maxLevel, undefined, bad);
    assert.equal(warnings.length, 1, bad);
  }
});

test("a credit travels from the address to the spec, verbatim", () => {
  const { scene, warnings } = read(
    "imagery=https://x.test/{z}/{x}/{y}.png&credit=" + encodeURIComponent("OPM · LOLA/USGS"),
  );
  assert.equal(scene.imagery?.credit, "OPM · LOLA/USGS");
  assert.deepEqual(warnings, []);
  // An empty credit is no credit: the viewer would otherwise paint an empty box over the globe.
  assert.equal(
    read("imagery=https://x.test/{z}/{x}/{y}.png&credit=").scene.imagery?.credit, undefined);
});

test("the ellipsoid is two raw radii in metres", () => {
  const { scene, warnings } = read("ellipsoid=1737400,1737400");
  assert.deepEqual(scene.ellipsoid, { a: 1737400, b: 1737400 });
  assert.deepEqual(warnings, []);
  assert.equal(scene.imagery, undefined);
});

test("radii that are not two positive numbers are dropped", () => {
  for (const bad of ["1737400", "1737400,1737400,1737400", "moon", "0,1737400", "-1,2"]) {
    const { scene, warnings } = read(`ellipsoid=${bad}`);
    assert.equal(scene.ellipsoid, undefined, bad);
    assert.equal(warnings.length, 1, bad);
  }
});

test("a page with no parameters is told nothing", () => {
  const { scene, warnings } = read("ws=auto&speed=2");
  assert.deepEqual(scene, {});
  assert.deepEqual(warnings, []);
});
