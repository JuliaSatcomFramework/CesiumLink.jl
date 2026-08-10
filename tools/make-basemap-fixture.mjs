#!/usr/bin/env node
// Writes the checked-in basemap fixture: a levels 0-2 pyramid of solid-colour tiles, in both
// layouts. `tools/zoom-check.mjs` loads it, and it is what you point a browser at to see the
// basemap path work with no server and no remote tile host.
//
//   node tools/make-basemap-fixture.mjs
//
// One colour per level, and nothing else in the tile: the question a screenshot has to answer is
// which level the globe is wearing, and a solid colour answers it from across the room.
//
// The tiles are Web Mercator, which is what `{z}/{x}/{y}` means on the web and what an unstated
// `tiling` gives, so level z holds 2^z x 2^z of them. A colour depends on the level alone, so the
// two layouts hold the same tiles: TMS numbers y from the south and XYZ from the north, and it adds
// the `tilemapresource.xml` that a TMS pyramid is known by (the shape `test`
// writes for the mount tests).
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "basemap");
const DEPTH = 2;
const TILE = 256;
/** Level 0 red, level 1 green, level 2 blue. */
const COLORS = [[176, 48, 48], [48, 160, 64], [48, 96, 200]];

function writePyramids() {
  rmSync(out, { recursive: true, force: true });
  for (const layout of ["xyz", "tms"]) {
    for (let z = 0; z <= DEPTH; z++) {
      const png = solidPng(COLORS[z]);
      for (let x = 0; x < 2 ** z; x++) {
        mkdirSync(join(out, layout, String(z), String(x)), { recursive: true });
        for (let y = 0; y < 2 ** z; y++) {
          writeFileSync(join(out, layout, String(z), String(x), `${y}.png`), png);
        }
      }
    }
  }
  writeFileSync(join(out, "tms", "tilemapresource.xml"), tileMapResource());
  console.log(`wrote levels 0-${DEPTH} of both layouts to ${out}`);
}

/** A `TILE` x `TILE` 8-bit RGB PNG of one colour. */
function solidPng([r, g, b]) {
  // One filter byte (0, no filter) in front of each row of pixels.
  const raw = Buffer.alloc(TILE * (1 + TILE * 3));
  for (let row = 0; row < TILE; row++) {
    const start = row * (1 + TILE * 3) + 1;
    for (let i = 0; i < TILE; i++) raw.set([r, g, b], start + i * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(TILE, 0);
  ihdr.writeUInt32BE(TILE, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, colour type 2 (RGB), no interlace.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** What gdal2tiles writes beside a Web Mercator pyramid, and what Cesium reads the depth from. */
function tileMapResource() {
  const EDGE = 85.05112877980659; // Where Web Mercator stops.
  const sets = COLORS.map((_, z) =>
    `    <TileSet href="${z}" units-per-pixel="${156543.0339280410 / 2 ** z}" order="${z}"/>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">
  <Title>CesiumLink basemap fixture</Title>
  <Abstract>One solid colour per level: 0 red, 1 green, 2 blue.</Abstract>
  <SRS>EPSG:900913</SRS>
  <BoundingBox minx="-180.0" miny="-${EDGE}" maxx="180.0" maxy="${EDGE}"/>
  <Origin x="-180.0" y="-${EDGE}"/>
  <TileFormat width="${TILE}" height="${TILE}" mime-type="image/png" extension="png"/>
  <TileSets profile="mercator">
${sets.join("\n")}
  </TileSets>
</TileMap>
`;
}

writePyramids();
