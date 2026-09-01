#!/usr/bin/env node
// Writes the checked-in annotation data the label overlay draws: place names, country boundaries
// and region boundaries, all from Natural Earth.
//
//   node tools/make-annotation-data.mjs
//
// Run it by hand, when Natural Earth cuts a release. It is not part of the build: the three files it
// writes are committed, so the build never reaches the network.
//
// It downloads its five inputs the first time and keeps them under `tools/.cache/natural-earth`,
// which git ignores. Delete that directory to re-fetch.
//
// Names come from the 1:10m set and boundaries from the 1:50m set, and the mismatch is deliberate.
// Ground polylines are the expensive half of drawing this: measured with the same names and the
// same paging, 1:110m and 1:50m boundaries both cost 165-371 ms a frame while 1:10m costs 337-785.
// 1:50m is free against 1:110m and its outlines follow the coast, where 1:110m turns Switzerland
// into a chunky polygon at 900 km.
//
// Natural Earth is public domain, so no output carries a credit line.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, "tools/.cache/natural-earth");
const out = join(root, "lib/core/assets/annotations");
const SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

const PLACES = "ne_10m_populated_places_simple";
const COUNTRIES = "ne_10m_admin_0_countries";
const MARINE = "ne_10m_geography_marine_polys";
const BORDERS = "ne_50m_admin_0_boundary_lines_land";
const REGIONS = "ne_50m_admin_1_states_provinces_lines";

// A city or a capital keeps its name to the deepest level a camera reaches, so it needs no ceiling.
const NO_CEILING = 99;

// The seven continent names carry no point in the vector data, so they are written down. Their
// `maxz` is 2 because level 3 is where country names start, and a continent has nothing to say
// once the countries inside it are named. `importance` is land area in square kilometres.
const CONTINENTS = [
  { name: "AFRICA", lon: 20, lat: 2, importance: 30.37e6 },
  { name: "EUROPE", lon: 16, lat: 52, importance: 10.18e6 },
  { name: "ASIA", lon: 90, lat: 45, importance: 44.58e6 },
  { name: "NORTH AMERICA", lon: -100, lat: 45, importance: 24.71e6 },
  { name: "SOUTH AMERICA", lon: -60, lat: -15, importance: 17.84e6 },
  { name: "OCEANIA", lon: 140, lat: -25, importance: 8.6e6 },
  { name: "ANTARCTICA", lon: 0, lat: -82, importance: 14.2e6 },
];

/** Natural Earth's own zoom hints, turned into a geographic level.
 *
 * The hints are Web Mercator levels. A geographic level z holds the same tile width in degrees as a
 * Mercator level z + 1, so a hint of m first shows at z = m - 1. Some hints are fractional.
 */
function level(hint, fallback) {
  return Math.floor(Number(hint) || fallback) - 1;
}

/** The bounding box of every coordinate in a geometry: a centre to hang a name on, and an area.
 *
 * A shape wider than half the world is one that crosses 180 degrees, as the Pacific does. Its raw
 * bounding box spans the whole world and its centre lands on the Greenwich meridian, which is the
 * wrong ocean. Shift the western half east by 360 degrees before measuring, then wrap back.
 */
function boundingBox(geometry) {
  const xs = [];
  const ys = [];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      xs.push(c[0]);
      ys.push(c[1]);
    } else {
      for (const part of c) walk(part);
    }
  };
  walk(geometry.coordinates);
  // Spreading into Math.min overflows the stack on a country of a hundred thousand points.
  const span = (values) => values.reduce(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)],
    [Infinity, -Infinity]);
  let [west, east] = span(xs);
  if (east - west > 180) [west, east] = span(xs.map((x) => (x < 0 ? x + 360 : x)));
  const [south, north] = span(ys);
  let lon = (west + east) / 2;
  if (lon > 180) lon -= 360;
  return { lon, lat: (south + north) / 2, area: (east - west) * (north - south) };
}

async function input(name) {
  mkdirSync(cache, { recursive: true });
  const path = join(cache, `${name}.geojson`);
  if (!existsSync(path)) {
    const url = `${SOURCE}/${name}.geojson`;
    console.log(`fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

const features = async (name) => JSON.parse(readFileSync(await input(name), "utf8")).features;

/** One row per name: where it is, what it is, and the band of levels it competes in.
 *
 * `minz` and `maxz` are both written, never a floor alone. A continent, an ocean and a country name
 * each have to stop competing at the level where the places inside them take over; with no ceiling
 * they go on fighting a city name for the same pixels and the winner is arbitrary.
 *
 * `importance` breaks a tie inside one kind, and is only comparable inside one kind: population for
 * a country, a city and a capital, bounding-box area for a water body, land area for a continent.
 * It never comes from the name. Rome and Vatican City are two kilometres apart and both are
 * capitals; sorted by name Vatican City wins the alphabet and Rome disappears.
 */
async function places() {
  const rows = CONTINENTS.map((c) => ({ ...c, kind: "continent", minz: 0, maxz: 2 }));

  for (const f of await features(MARINE)) {
    const p = f.properties;
    const cla = (p.featurecla || "").toLowerCase();
    // 1:10m carries gulfs, straits, bays and sounds as well as seas, and each one's own `min_label`
    // already says how deep it belongs. Only these three have no place on a globe.
    if (cla === "river" || cla === "reef" || cla === "generic") continue;
    const kind = cla.includes("ocean") ? "ocean" : "sea";
    const box = boundingBox(f.geometry);
    const minz = kind === "ocean" ? 0 : Math.max(3, level(p.min_label, 4));
    rows.push({
      name: p.name, lon: box.lon, lat: box.lat, kind,
      minz, maxz: Math.max(minz, level(p.max_label, 10)), importance: box.area,
    });
  }

  // The level each country's name starts at, by its three-letter code, which is what puts a capital
  // on the globe at the same level as its country.
  const countryLevel = new Map();
  for (const f of await features(COUNTRIES)) {
    const p = f.properties;
    // LABELRANK runs 1 (most important) to 10, and is a rank rather than a zoom hint: rank 2 lands
    // at level 3 and rank 10 at level 7.
    const minz = Math.max(3, (Number(p.LABELRANK) || 5) + 1);
    countryLevel.set(p.ADM0_A3, minz);
    const box = p.LABEL_X === null || p.LABEL_Y === null ? boundingBox(f.geometry) : null;
    rows.push({
      name: p.NAME || p.ADMIN,
      lon: box ? box.lon : p.LABEL_X,
      lat: box ? box.lat : p.LABEL_Y,
      kind: "country",
      minz,
      maxz: Math.max(minz, level(p.MAX_LABEL, 9)),
      importance: Number(p.POP_EST) || 0,
    });
  }

  for (const f of await features(PLACES)) {
    const p = f.properties;
    const capital = Boolean(p.adm0cap);
    const minz = Math.max(3, level(p.min_zoom, 6));
    rows.push({
      name: p.name, lon: p.longitude, lat: p.latitude,
      kind: capital ? "capital" : "city",
      // A capital is named at the level its country is, however small the city: not before it,
      // which would put Algiers on a globe that says nothing of Algeria, and not after.
      minz: capital ? (countryLevel.get(p.adm0_a3) ?? Math.min(minz, 3)) : minz,
      maxz: NO_CEILING,
      importance: Number(p.pop_max) || 0,
    });
  }

  // Four decimal places is about eleven metres, which is far finer than a name needs and saves a
  // fifth of the file.
  const round = (v) => Math.round(v * 1e4) / 1e4;
  return rows.map((r) => ({ ...r, lon: round(r.lon), lat: round(r.lat) }));
}

/** The region boundaries, each carrying the level it starts drawing at and nothing else.
 *
 * Natural Earth's `MIN_ZOOM` is what keeps this layer from reading as noise: all 581 lines at once
 * from the globe say nothing and cost frames. The hint is converted the way `minz` is, so the
 * three bands it holds are levels 1, 2 and 3.
 *
 * The rest of the properties go. Every line is the same `SCALERANK` and the file carries thirty-odd
 * `FCLASS_` columns, one per country's own view of the boundary, all null here. Dropping them takes
 * the file from 883 KB to 419 KB, and the layer reads none of them.
 */
async function regions() {
  return {
    type: "FeatureCollection",
    features: (await features(REGIONS)).map((f) => ({
      type: "Feature",
      properties: { minz: Math.max(0, level(f.properties.MIN_ZOOM, 3)) },
      geometry: f.geometry,
    })),
  };
}

const rows = await places();
const lines = await regions();
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "named-places.json"), JSON.stringify(rows));
// The boundary file travels as it stands: Cesium builds a ground polyline per LineString, and it
// will not draw the outline of a polygon on terrain.
cpSync(await input(BORDERS), join(out, "country-borders.geojson"));
writeFileSync(join(out, "region-borders.geojson"), JSON.stringify(lines));

const kb = (f) => `${Math.round(statSync(join(out, f)).size / 1024)} KB`;
console.log(`wrote ${rows.length} names to ${join(out, "named-places.json")} (${kb("named-places.json")})`);
console.log(`wrote ${join(out, "country-borders.geojson")} (${kb("country-borders.geojson")})`);
console.log(`wrote ${lines.features.length} region lines to \
${join(out, "region-borders.geojson")} (${kb("region-borders.geojson")})`);
