// What the three families share: the Cesium namespace they are handed, and reading a colour out of
// a knob without allocating one per entity.

import type { Color } from "@cesium/engine";
import { at, type Slice } from "./knobs.ts";

export type CesiumRuntime = typeof import("@cesium/engine");

/** What an entity is drawn in when its family sent no colour. */
export const WHITE: readonly number[] = [255, 255, 255, 255];
/** What an area outline is drawn in when its family asked for one without naming a colour. */
export const BLACK: readonly number[] = [0, 0, 0, 217];

/** Component `j` of entity `i`, or `fallback[j]` where the knob was not delivered. */
export const channel = (s: Slice | null, i: number, j: number, fallback: readonly number[]): number =>
  (s ? at(s, i, j) : fallback[j]);

/**
 * The colour of entity `i`, written into `result`. Never into a colour a primitive already holds:
 * the setters skip their upload when handed a value equal to the one they have, which a
 * mutated-in-place colour always is.
 */
export const colorOf = (C: CesiumRuntime, s: Slice | null, i: number,
                        fallback: readonly number[], result: Color): Color =>
  C.Color.fromBytes(channel(s, i, 0, fallback), channel(s, i, 1, fallback),
                    channel(s, i, 2, fallback), channel(s, i, 3, fallback), result);
