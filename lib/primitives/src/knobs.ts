// Every appearance knob is data, and the shape it arrives with says how far it varies. The base rank
// of a knob is 1 — one value per entity — or 2 where an entity takes several components, such as the
// four bytes of a colour. `blockAt` reads the keyframe axis above that rank; the forms below it are
// this file's own, because they are about a family of entities rather than about time.
//
// Resolving a knob at a keyframe yields a `Slice`, read as
//
//   slice.data[slice.offset + i * slice.stride + j]
//
// for entity `i` and component `j`. That is the same expression whichever form was sent: `stride` is
// 0 when one value covers the family, and `offset` is 0 when the knob does not vary over the window.
// A list of one array per keyframe is the fourth form, and the only one that carries a different
// entity count at each keyframe. Nothing here allocates per entity.

import { blockAt, isNdArray } from "../../core/src/codec.ts";

/** One keyframe's values for a knob, addressed by entity and component. */
export interface Slice {
  readonly data: ArrayLike<number>;
  readonly offset: number;
  /** Components per entity, or 0 when one value covers the family. */
  readonly stride: number;
  /** Entities the slice holds values for, or Infinity when one value covers the family. */
  readonly length: number;
}

/** Component `j` of entity `i` in `s`. */
export const at = (s: Slice, i: number, j = 0): number => s.data[s.offset + i * s.stride + j];

/** One delivered knob: how far it varies, and how to resolve it at a keyframe. */
export interface Knob {
  /** True when the values switch at keyframe crossings. */
  readonly keyframed: boolean;
  /** Values at window-relative keyframe `k`, or null when this window says nothing about `k`. */
  frame(k: number): Slice | null;
}

interface KnobShape {
  /** Components per entity: 1 for a size, a width or a flag, 2 for an index pair, 4 for a colour. */
  itemLen: number;
  /** Keyframes this window carries. */
  count: number;
  /** Names the knob in the error a shape matching no form raises. */
  what: string;
  /** The module the knob belongs to, which prefixes that error. Other modules resolve knobs too. */
  module?: string;
  /**
   * Entities in the family, where the family has a fixed one. Omitted for a family whose membership
   * is itself per-keyframe — an edge family's connectivity — where only the rank can be checked.
   */
  n?: number;
}

const whole = (data: ArrayLike<number>, stride: number): Slice =>
  ({ data, offset: 0, stride, length: stride === 0 ? Infinity : data.length / stride });

const constant = (slice: Slice): Knob => ({ keyframed: false, frame: () => slice });

/**
 * Resolve one delivered knob against the family it belongs to, or null when it was not sent. Throws
 * naming `what` for a shape that matches none of the forms — Julia validated it on the way out, so a
 * mismatch here is a bug worth being loud about rather than a scene silently missing a colour.
 */
export function knob(raw: unknown, s: KnobShape): Knob | null {
  const { itemLen, count, what, n, module = "primitives" } = s;
  const name = `${module}: ${what}`;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (itemLen !== 1) {
      throw new Error(`${name} takes ${itemLen} components, not one number`);
    }
    return constant(whole([raw], 0));
  }
  // One array per keyframe: the only form that carries a different entity count at each of them.
  if (Array.isArray(raw)) {
    if (raw.length !== count) {
      throw new Error(`${name} has ${raw.length} keyframes, the window carries ${count}`);
    }
    const slices = raw.map((one, k) => {
      if (!isNdArray(one)) throw new Error(`${name} keyframe ${k} is not an array`);
      if (one.data.length % itemLen !== 0) {
        throw new Error(`${name} keyframe ${k} has ${one.data.length} values, ` +
                        `not whole groups of ${itemLen}`);
      }
      return whole(one.data, itemLen);
    });
    return { keyframed: true, frame: (k) => slices[k] ?? null };
  }
  if (!isNdArray(raw)) throw new Error(`${name} is neither a number nor an array`);

  const { data, shape } = raw;
  const dims = shape.length;
  const want = (expected: number, form: string) => {
    if (data.length !== expected) {
      throw new Error(`${name} as ${form} wants ${expected} values, got ${data.length}`);
    }
  };
  // A lone vector of the right length is the family's one value; a per-entity array always carries
  // an entity axis of its own, so the two forms differ in rank even where the family holds one entity.
  if (itemLen > 1 && dims === 1) {
    want(itemLen, "one value for the family");
    return constant(whole(data, 0));
  }
  const entityDims = itemLen > 1 ? 2 : 1;
  if (dims === entityDims) {
    if (n !== undefined) want(n * itemLen, "one value per entity");
    else if (data.length % itemLen !== 0) want(data.length, "one value per entity");
    return constant(whole(data, itemLen));
  }
  if (dims === entityDims + 1) {
    // The Core owns the block arithmetic and rejects a leading axis the window disagrees with. Read
    // the first keyframe here, so that rejection names the knob and arrives at delivery rather than
    // at the first draw. Whatever it accepts, no later keyframe of the same array can be refused.
    let first;
    try {
      first = blockAt(raw, 0, entityDims, count);
    } catch (err) {
      throw new Error(`${name}, ${(err as Error).message}`);
    }
    if (first && n !== undefined && first.len !== n * itemLen) {
      want(count * n * itemLen, "one value per entity per keyframe");
    }
    return {
      keyframed: true,
      frame: (k) => {
        const block = blockAt(raw, k, entityDims, count);
        return block && { data: block.data, offset: block.offset,
                          stride: itemLen, length: block.len / itemLen };
      },
    };
  }
  throw new Error(`${name} has shape [${shape}], which is none of the forms ` +
                  `for a family of ${n ?? "?"} over ${count} keyframes`);
}
