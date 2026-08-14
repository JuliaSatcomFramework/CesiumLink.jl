// Test-only helpers for driving a module against the Core's own answers.
//
// NOT part of the module API, and never reachable from `index.ts`: a module reads what the Core
// hands its `setup(ctx)`, and nothing here is handed to one. A test imports this file directly.
//
// What it exists for: a module test builds a `ModuleContext` of its own, and the parts of that
// context which are the Core's own bookkeeping — placement above all — were modelled once per test
// file. Four models of one mapping can agree with each other and all four be wrong about what the
// Core does.

import type { Placement, WindowInfo } from "./windows";

/** The delivered windows a test has declared, and the placement they add up to. */
export interface WindowCoverage {
  /**
   * Record one delivered window. A `replace` re-indexes, so nothing delivered before it survives;
   * an `append` extends what is there, and a keyframe delivered twice belongs to the window that
   * carried it last.
   */
  deliver(info: WindowInfo): void;
  /** `ctx.placement`: the window carrying absolute keyframe `index`, and the offset within it. */
  placement(index: number): Placement | null;
}

/**
 * The placement bookkeeping `createWindows` does, for a test that drives a module without a clock.
 *
 * It leaves out one rule the Core obeys: the Core trims placements to the frames its delivered
 * buffer still holds (`BUFFER_FRAMES` in `windows.ts`), so a test that declares more frames than
 * that and then asserts on an old one is asking this for an answer the Core would not give.
 */
export function windowCoverage(): WindowCoverage {
  const frames = new Map<number, WindowInfo>();
  return {
    deliver(info) {
      if (info.mode === "replace") frames.clear();
      for (let k = 0; k < info.count; k++) frames.set(info.startFrame + k, info);
    },
    placement(index) {
      const window = frames.get(index);
      return window ? { window, k: index - window.startFrame } : null;
    },
  };
}
