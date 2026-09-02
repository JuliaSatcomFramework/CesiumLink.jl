import test from "node:test";
import assert from "node:assert/strict";
import { Cartographic, Math as CesiumMath } from "@cesium/engine";
import { GibsGeographicTilingScheme } from "./gibs-tiling.ts";

const scheme = new GibsGeographicTilingScheme();

test("the tile counts are the ones GIBS publishes, and they double from level 3", () => {
  const columns = [0, 1, 2, 3, 4, 5, 11].map((l) => scheme.getNumberOfXTilesAtLevel(l));
  const rows = [0, 1, 2, 3, 4, 5, 11].map((l) => scheme.getNumberOfYTilesAtLevel(l));
  assert.deepEqual(columns, [2, 3, 5, 10, 20, 40, 2560]);
  assert.deepEqual(rows, [1, 2, 3, 5, 10, 20, 1280]);
});

test("a tile covers the rectangle its level 0 resolution says it does", () => {
  // Level 3 draws 0.0703125 degrees per pixel, so a 512 pixel tile is 36 degrees square. Column 5
  // starts 5 tiles east of -180, and row 0 starts at the north pole. The tile draws Norway and
  // Svalbard, which is what says the grid is right.
  const r = scheme.tileXYToRectangle(5, 0, 3);
  const degrees = [r.west, r.south, r.east, r.north].map((x) => CesiumMath.toDegrees(x));
  assert.deepEqual(degrees.map((d) => Math.round(d * 1e6) / 1e6), [0, 54, 36, 90]);
});

test("a position falls in the tile that covers it", () => {
  const oslo = Cartographic.fromDegrees(10.75, 59.91);
  const xy = scheme.positionToTileXY(oslo, 3);
  assert.deepEqual([xy.x, xy.y], [5, 0]);
});
