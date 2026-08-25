// The encoded-array codec — the whole of the Core's payload knowledge.
//
// A numeric array anywhere in any payload, at any nesting depth, travels as
//   { $wire: "f32", shape: [3, 264], off: 4096 }
// so a decoder needs no schema. Its bytes sit in the frame's region, at `off` bytes from the start
// of that region. `shape` is row-major, the last dimension varying fastest; Julia, being
// column-major, reverses it at its own boundary.
//
// Typed arrays are host-endian, and every target this runs on is little-endian.
//
// One value here encodes: a canvas capture, which is the only array that travels upward
// (ADR-0033). It rides the same `u8` tag as everything else, so the upward half of the protocol
// uses this contract and does not extend it. See `docs/protocol.md`.

const CTORS = {
  f32: Float32Array,
  f64: Float64Array,
  u8: Uint8Array,
  u32: Uint32Array,
  i32: Int32Array,
} as const;

export type Dtype = keyof typeof CTORS;
type TypedArray = InstanceType<(typeof CTORS)[Dtype]>;

/** An array on the wire: its bytes are `off` bytes into the frame's region. */
export interface WireArray {
  $wire: Dtype;
  shape: number[];
  off: number;
}

/** An array in a payload, decoded. */
export interface NdArray {
  data: TypedArray;
  shape: number[];
}

/** The values one keyframe reads, as an offset into the array that carries them. */
export interface Block {
  readonly data: ArrayLike<number>;
  readonly offset: number;
  /** Values in the block: the product of the trailing dimensions. */
  readonly len: number;
  /** True when the values switch at keyframe crossings. */
  readonly keyframed: boolean;
}

/**
 * The block keyframe `k` addresses, or null where the array says nothing about `k`.
 *
 * The caller names the **base rank** of the form it expects — 1 for a value per entity, 3 for a
 * `[H, W, 4]` raster. An array at or below that rank holds one value for the whole window, and every
 * keyframe reads all of it. An array one rank above it carries a leading keyframe axis, so keyframe
 * `k` is the contiguous block at `k × len`, where `len` is the product of the trailing dimensions.
 *
 * `count` is the keyframes the window carries. An array whose leading axis disagrees with it throws:
 * a payload that claims seven keyframes inside a window of five is a bug worth being loud about,
 * rather than a short block read as data.
 */
export function blockAt(a: NdArray, k: number, baseRank: number, count: number): Block | null {
  const { data, shape } = a;
  if (shape.length <= baseRank) {
    return { data, offset: 0, len: data.length, keyframed: false };
  }
  if (shape.length !== baseRank + 1) {
    throw new Error(`codec: shape [${shape}] is more than one rank above base rank ${baseRank}`);
  }
  if (shape[0] !== count) {
    throw new Error(`codec: shape [${shape}] has ${shape[0]} keyframes, the window carries ${count}`);
  }
  if (k < 0 || k >= count) return null;
  // Multiplied out in place: a module on the interpolation path calls this every tick, and the
  // trailing dimensions are not worth an array of their own.
  let len = 1;
  for (let axis = 1; axis < shape.length; axis++) len *= shape[axis];
  return { data, offset: k * len, len, keyframed: true };
}

/**
 * Replace every encoded array inside `value` with its `{data, shape}` form, reading the bytes out
 * of `region`.
 *
 * Each array is a **view into `region`**, not a copy: copying costs about 1 ms per megabyte, which
 * is most of what the region exists to save. A module that keeps a slice past its window keeps the
 * whole frame alive with it — `new Float32Array(a.data)` detaches a copy. See `docs/module-api.md`.
 */
export function decodeArrays(value: unknown, region: Uint8Array): unknown {
  if (Array.isArray(value)) return value.map((v) => decodeArrays(v, region));
  if (value === null || typeof value !== "object") return value;
  if (isWireArray(value)) return decodeArray(value, region);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeArrays(v, region);
  return out;
}

// An object carrying anything but a known dtype tag, a shape and an offset is an ordinary payload
// value that happens to have a `$wire` key, and passes through untouched.
function isWireArray(v: object): v is WireArray {
  const o = v as Partial<WireArray>;
  return (
    typeof o.$wire === "string" &&
    o.$wire in CTORS &&
    typeof o.off === "number" &&
    Array.isArray(o.shape)
  );
}

/**
 * Whether a decoded value is one of the typed arrays `decodeArrays` produces. Exported because
 * every consumer of a payload has to ask it, and the answer belongs next to the shape it describes.
 */
export function isNdArray(v: unknown): v is NdArray {
  const o = v as Partial<NdArray> | null;
  return !!o && typeof o === "object" && ArrayBuffer.isView(o.data) && Array.isArray(o.shape);
}

/**
 * Read a declared list of numbers as a plain list. A short list travels as JSON, a long list travels
 * as an encoded array, and a field the declaration omits gives the empty list.
 */
export const numbers = (v: number[] | NdArray | undefined): number[] =>
  v === undefined ? [] : isNdArray(v) ? Array.from(v.data) : v;

function decodeArray(w: WireArray, region: Uint8Array): NdArray {
  const Ctor = CTORS[w.$wire];
  const count = elementCount(w.shape);
  const len = count * Ctor.BYTES_PER_ELEMENT;
  // The length is derived from the shape rather than carried, so this is the whole of what stands
  // between a malformed frame and a view over bytes that never arrived.
  if (w.off < 0 || w.off + len > region.byteLength) {
    throw new Error(
      `codec: a ${w.$wire} array of ${len} bytes at offset ${w.off} runs past a region of ` +
        `${region.byteLength} bytes`,
    );
  }
  // Every offset is a multiple of 8, so a Float64Array view is always alignment-legal. An offset
  // that is not means the frame is wrong, and the constructor throwing says so.
  const buf = region.buffer as ArrayBuffer;
  return { data: new Ctor(buf, region.byteOffset + w.off, count), shape: w.shape };
}

/**
 * Describe `bytes` as the array a payload points at.
 *
 * The caller sends `bytes` as the whole region of its frame, so the offset is 0 and the shape is
 * the byte count. A canvas capture is the one array that travels upward, and it needs one array
 * per region (ADR-0033).
 */
export function encodeU8(bytes: Uint8Array): WireArray {
  return { $wire: "u8", shape: [bytes.length], off: 0 };
}

const elementCount = (shape: number[]): number => shape.reduce((a, b) => a * b, 1);
