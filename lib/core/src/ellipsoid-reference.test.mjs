// The committed geodetic ↔ ECEF reference table still is what Cesium computes, to the precision the
// table is used at.
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

  same(committed.ellipsoids, fresh.ellipsoids, "ellipsoids");
});

// How far two numbers may stand apart and still describe the same conversion, relative to the larger
// of them.
//
// Not bit-exact. A JavaScript engine computes a transcendental function to within a few of the last
// bits, and what it lands on differs between architectures — this table is written on one machine
// and checked on whichever one runs the tests. At Earth's radius `1e-12` is under five micrometres,
// while the Julia side asserts against the same table to a millimetre (`test/snippets.jl`), so
// anything large enough to matter there still fails here.
const RTOL = 1e-12;

// Deep comparison, structure exactly and numbers within `RTOL`.
function same(got, want, where) {
  if (typeof want === "number") {
    assert.equal(typeof got, "number", `${where}: ${got} is not a number`);
    const scale = Math.max(Math.abs(got), Math.abs(want), 1);
    assert.ok(Math.abs(got - want) <= RTOL * scale,
      `${where}: ${got} against ${want}, which is more than ${RTOL} apart`);
  } else if (Array.isArray(want)) {
    assert.ok(Array.isArray(got) && got.length === want.length,
      `${where}: expected ${want.length} entries`);
    want.forEach((w, i) => same(got[i], w, `${where}[${i}]`));
  } else if (want !== null && typeof want === "object") {
    assert.deepEqual(Object.keys(got ?? {}).sort(), Object.keys(want).sort(), `${where}: keys`);
    for (const k of Object.keys(want)) same(got[k], want[k], `${where}.${k}`);
  } else {
    assert.equal(got, want, where);
  }
}
