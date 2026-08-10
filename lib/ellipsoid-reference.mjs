#!/usr/bin/env node
// The reference table both implementations of the geodetic ↔ ECEF conversion are checked against.
//
// Cesium owns the answer: the viewer places everything through `Ellipsoid.cartographicToCartesian`
// and reads positions back with `Cartographic.fromCartesian`, so a scene whose coordinates were
// computed elsewhere lands where it is drawn only if it agrees with those two. This file computes
// them for a fixed table of awkward points and writes the result to
// `tools/baseline/ellipsoid-reference.json`, which CesiumLink's Julia tests assert against.
//
//   node lib/ellipsoid-reference.mjs        # rewrite the table
//
// The committed table is checked against a fresh Cesium computation by
// `lib/core/src/ellipsoid-reference.test.mjs`, so it cannot go stale unnoticed: a Cesium
// upgrade that moved a number fails there rather than being believed by the Julia side.
//
// It lives here rather than under `tools/` because it imports Cesium by name, and `node_modules` is
// under `lib/`.
//
// Cesium is imported directly. Both conversions are arithmetic on three numbers and touch no WebGL,
// so no browser is involved and the numbers are the ones the viewer computes.

import { Cartographic, Ellipsoid } from "@cesium/engine";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TABLE_PATH = join(here, "..", "tools", "baseline", "ellipsoid-reference.json");

// WGS84, the shape the viewer keeps when a server declares none, and a strongly flattened one no
// planet has: a session may declare any ellipsoid, and a conversion that quietly hard-codes Earth's
// flattening still passes every WGS84 point.
export const ELLIPSOIDS = {
  wgs84: { a: 6378137.0, b: 6356752.3142451793 },
  oblate: { a: 6378137.0, b: 6000000.0 },
};

// Longitude, geodetic latitude (degrees) and height above the ellipsoid (metres). The awkward cases
// are the point: both poles, where longitude means nothing; the equator, where the parallel is
// longest; both signs of the antimeridian; heights below the surface; and heights far enough out
// that the height term dominates the radius.
export const POINTS = [
  [0, 0, 0],
  [0, 0, -500],
  [90, 0, 0],
  [180, 0, 0],
  [-180, 0, 1000],
  [179.9999, -0.0001, 0],
  [12.5, 41.9, 100],
  [-71.0589, 42.3601, -30],
  [45, 90, 0],
  [-45, -90, 250],
  [0, 89.9999, 0],
  [123.456, -89.9, 7],
  [30, 45, 3_500_000],
  [-120, -60, 20_200_000],
  [10, 80, -11_000],
];

const degrees = (rad) => (rad * 180) / Math.PI;

/** The table as Cesium computes it: every point, on every ellipsoid, in both directions. */
export function reference() {
  const entries = Object.entries(ELLIPSOIDS).map(([name, { a, b }]) => {
    // The radii the viewer builds its globe from — `new Ellipsoid(a, a, b)`, an ellipsoid of
    // revolution about the polar axis.
    const ellipsoid = new Ellipsoid(a, a, b);
    const points = POINTS.map(([lon, lat, height]) => {
      const xyz = ellipsoid.cartographicToCartesian(Cartographic.fromDegrees(lon, lat, height));
      const back = Cartographic.fromCartesian(xyz, ellipsoid, new Cartographic());
      return {
        lonlat: [lon, lat, height],
        ecef: [xyz.x, xyz.y, xyz.z],
        geodetic: [degrees(back.longitude), degrees(back.latitude), back.height],
      };
    });
    return [name, { a, b, points }];
  });
  const { version } = JSON.parse(
    readFileSync(join(here, "node_modules/@cesium/engine/package.json"), "utf8"));
  return { cesium: version, ellipsoids: Object.fromEntries(entries) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(TABLE_PATH, `${JSON.stringify(reference(), null, 2)}\n`);
  console.log(`wrote ${TABLE_PATH}`);
}
