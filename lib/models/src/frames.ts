// Which way a model points. Three rotations multiply, in this order:
//
//   frame  x  attitude  x  axes
//
// The **frame** is built from where the entity is now, so it turns as the entity travels. The
// **attitude** is the family's optional quaternion, which turns the model inside that frame. The
// **axes** correction is fixed for the whole family and applies first, because it says nothing about
// the world — it corrects the file's own idea of which way is forward. Cesium takes a model's +X as
// forward, and most files disagree.

import type { Cartesian3, Matrix3, Matrix4, Quaternion } from "@cesium/engine";

/** The one Cesium instance a module is handed. A module never imports the engine itself. */
export type CesiumRuntime = typeof import("@cesium/engine");

/** The reference frames a model family may name. */
export type FrameName = "ecef" | "enu" | "nadir" | "velocity";

const NAMES: readonly string[] = ["ecef", "enu", "nadir", "velocity"];

/** `name` where it is one of the four frames, and nothing where it is not. */
export const frameNamed = (name: unknown): FrameName | undefined =>
  (typeof name === "string" && NAMES.includes(name)) ? (name as FrameName) : undefined;

// Scratch for the composition below. Every value written here is read before the next call, and
// nothing built from it leaves this file except through a caller-supplied `result`.
let enuScratch: Matrix4 | null = null;
let rotScratch: Matrix3 | null = null;
let flip: Quaternion | null = null;
let dirScratch: Cartesian3 | null = null;

// Below which a step is no direction at all. A satellite crosses several hundred metres between two
// ticks, so nothing real is refused here; this only keeps a step of numerical dust out of a
// normalize, which would answer NaN and turn the model inside out.
const STEP_EPSILON_M = 1e-6;

/**
 * The rotation from the model's own axes into ECEF, written into `result`.
 *
 * `velocity` is the one frame that needs more than a position: pass the step the entity took since
 * the previous tick. A step of nothing — a standing entity, the first tick, a held clock — leaves the
 * model with no direction to face, so the frame falls back to east-north-up.
 *
 * **The step is normalized first, and it must be.** `rotationMatrixFromPositionVelocity` carries the
 * magnitude of the vector it is given into the matrix it builds, so a raw step in metres yields a
 * rotation scaled by that many metres. `fromRotationMatrix` then answers a quaternion of norm
 * sqrt(step), and Cesium sizes the model by the square of that — measured here as a 24 km aircraft
 * drawn ten thousand kilometres long, with nothing in any log to say why.
 */
export function frameQuaternion(C: CesiumRuntime, frame: FrameName, at: Cartesian3,
                                step: Cartesian3 | null, result: Quaternion): Quaternion {
  if (frame === "ecef") return C.Quaternion.clone(C.Quaternion.IDENTITY, result);
  if (frame === "velocity" && step && C.Cartesian3.magnitude(step) > STEP_EPSILON_M) {
    dirScratch = C.Cartesian3.normalize(step, dirScratch ?? new C.Cartesian3());
    rotScratch = C.Transforms.rotationMatrixFromPositionVelocity(at, dirScratch, undefined,
                                                                 rotScratch ?? new C.Matrix3());
    return C.Quaternion.fromRotationMatrix(rotScratch, result);
  }
  enuScratch = C.Transforms.eastNorthUpToFixedFrame(at, undefined, enuScratch ?? new C.Matrix4());
  rotScratch = C.Matrix4.getMatrix3(enuScratch, rotScratch ?? new C.Matrix3());
  C.Quaternion.fromRotationMatrix(rotScratch, result);
  // Nadir is that frame turned half a turn about its own east axis: +Z then points at the centre of
  // the ellipsoid and +X still points east, so a model built to fly east still flies east.
  if (frame === "nadir") {
    flip = flip ?? C.Quaternion.fromAxisAngle(C.Cartesian3.UNIT_X, Math.PI, new C.Quaternion());
    C.Quaternion.multiply(result, flip, result);
  }
  return result;
}

/**
 * The fixed correction a family's `axes` asks for, as heading, pitch and roll in degrees, or nothing
 * where the family declared none. Cesium's own convention: heading turns about down, pitch about
 * east, roll about north.
 */
export function axesQuaternion(C: CesiumRuntime, axes: number[]): Quaternion | null {
  if (axes.length !== 3) return null;
  const hpr = new C.HeadingPitchRoll(C.Math.toRadians(axes[0]), C.Math.toRadians(axes[1]),
                                     C.Math.toRadians(axes[2]));
  return C.Quaternion.fromHeadingPitchRoll(hpr, new C.Quaternion());
}
