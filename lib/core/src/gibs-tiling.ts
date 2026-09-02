import { GeographicTilingScheme, Rectangle } from "@cesium/engine";
import type { Cartesian2, Cartographic } from "@cesium/engine";

/** The pixel width and height of one GIBS EPSG:4326 tile. */
export const GIBS_TILE_PIXELS = 512;

/** Degrees per pixel at level 0, which every deeper level halves. */
const LEVEL_0_DEGREES_PER_PIXEL = 0.5625;

/** The number of tile columns at levels 0 to 3. From level 4 on, the count doubles per level. */
const FIRST_WIDTHS = [2, 3, 5, 10];

/** The number of tile rows at levels 0 to 3. From level 4 on, the count doubles per level. */
const FIRST_HEIGHTS = [1, 2, 3, 5];

/** The angular width and height of one tile at this level, in radians. */
const tileSpan = (level: number) =>
  ((LEVEL_0_DEGREES_PER_PIXEL * GIBS_TILE_PIXELS) / 2 ** level) * (Math.PI / 180);

/** A count that starts at the level 3 seed and doubles per level below it. */
const countAtLevel = (first: number[], level: number) =>
  level < first.length ? first[level] : first[first.length - 1] * 2 ** (level - first.length + 1);

/**
 * The tile grid NASA GIBS publishes its EPSG:4326 layers on.
 *
 * A GIBS geographic level holds a different number of tiles from a Cesium geographic level.
 * Level 0 is 2 columns by 1 row, then 3 by 2, 5 by 3, 10 by 5, and it doubles from there.
 * `GeographicTilingScheme` answers `2 << level` columns, so it matches this grid at no level.
 * A tile is 512 pixels square, and level 0 draws 0.5625 degrees per pixel. One level 0 tile is
 * therefore 288 degrees across, so the world sits in the corner of the pair and the rest is
 * padding. That is the grid as GIBS publishes it.
 *
 * The four methods here are what a tiling scheme has to state for Cesium to place a tile:
 * the two tile counts, the rectangle a tile covers, and the tile a position falls in.
 *
 * Adapted from `gibs.js` in NASA's `nasa-gibs/web-examples` (Apache License 2.0).
 */
export class GibsGeographicTilingScheme extends GeographicTilingScheme {
  getNumberOfXTilesAtLevel(level: number): number {
    return countAtLevel(FIRST_WIDTHS, level);
  }

  getNumberOfYTilesAtLevel(level: number): number {
    return countAtLevel(FIRST_HEIGHTS, level);
  }

  tileXYToRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle {
    const span = tileSpan(level);
    const r = result ?? new Rectangle();
    r.west = Rectangle.MAX_VALUE.west + x * span;
    r.east = Rectangle.MAX_VALUE.west + (x + 1) * span;
    r.north = Rectangle.MAX_VALUE.north - y * span;
    r.south = Rectangle.MAX_VALUE.north - (y + 1) * span;
    return r;
  }

  positionToTileXY(position: Cartographic, level: number, result?: Cartesian2): Cartesian2 {
    // A position off the globe belongs to no tile. Cesium reads the answer as optional here, and
    // the declared return type does not say so.
    if (!Rectangle.contains(Rectangle.MAX_VALUE, position)) {
      return undefined as unknown as Cartesian2;
    }
    const span = tileSpan(level);
    const r = (result ?? { x: 0, y: 0 }) as Cartesian2;
    // The last row and the last column run past the globe, so a position on the far edge lands
    // one tile beyond the grid unless it is held back.
    r.x = Math.min(
      this.getNumberOfXTilesAtLevel(level) - 1,
      Math.floor((position.longitude - Rectangle.MAX_VALUE.west) / span),
    );
    r.y = Math.min(
      this.getNumberOfYTilesAtLevel(level) - 1,
      Math.floor((Rectangle.MAX_VALUE.north - position.latitude) / span),
    );
    return r;
  }
}
