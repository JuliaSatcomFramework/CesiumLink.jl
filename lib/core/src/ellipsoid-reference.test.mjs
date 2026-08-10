// The committed geodetic ↔ ECEF reference table still is what Cesium computes.
//
// CesiumLink's Julia tests assert their own conversion against `tools/baseline/
// ellipsoid-reference.json`, and that table is only worth asserting against while it holds Cesium's
// current answers — the viewer places every position through them. A Cesium upgrade that moved a
// number, or a hand-edited table, fails here instead of being believed on the Julia side.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reference, TABLE_PATH } from "../../ellipsoid-reference.mjs";

test("the committed ellipsoid reference table is what Cesium computes", () => {
  const committed = JSON.parse(readFileSync(TABLE_PATH, "utf8"));
  const fresh = reference();

  assert.equal(committed.cesium, fresh.cesium,
    `table was computed with Cesium ${committed.cesium}, this tree has ${fresh.cesium} — ` +
    "rerun `node lib/ellipsoid-reference.mjs`");

  // Exactly, not approximately: same code, same inputs, same machine arithmetic. A difference of any
  // size means the table no longer describes what the viewer does.
  assert.deepEqual(committed.ellipsoids, fresh.ellipsoids);
});
