// glTF models, one per entity of a family another module owns.
//
// This module draws nothing of its own. Every family it holds names a family in `primitives` with
// `of`, and it reads that family's live position, its pick stamp and its mask through the read-only
// exports `primitives` publishes. Positions travel once: the marker and the model cannot disagree
// about where a satellite is, because there is one array and both read it (ADR-0022).
//
// It is also the worked example. Whoever writes a sensor cone, a coverage volume or a swath anchors
// it the same way, and the two things worth copying are here: the anchor is read **every frame**,
// because a window may prune or resize the family under you; and the pick stamp is **borrowed**,
// never minted, so one click on a model reports the satellite in the `primitives` namespace as
// though no model existed (ADR-0023).
//
// A model is not batched. `primitives` refuses custom materials by its own charter and a `.glb` is
// nothing but custom materials, which is why this is a module rather than a fourth family there.

import type { Disposable, ModuleContext } from "../../core/src/module-host.ts";
import { ModelFamily, type Anchors, type ModelSpec } from "./family.ts";

/** One window's models, as Julia's `models_payload` builds them. */
interface ScenePayload {
  models?: ModelSpec[];
}

/** The exports of the module that owns the entities a model family stands on. */
const ANCHOR = "primitives";

export default {
  setup(ctx: ModuleContext): Disposable {
    const families = new Map<string, ModelFamily>();
    const said = new Set<string>();
    const say = (key: string, message: string): void => {
      if (said.has(key)) return;
      said.add(key);
      console.warn(message);
    };
    const warn = (message: string): void => console.warn(message);

    // Reached from a callback and never from setup: a peer whose own setup has not run yet answers
    // nothing from every accessor, and the host warns about the lookup rather than the emptiness.
    let peer: Partial<Anchors> | undefined;
    const owner = (): Partial<Anchors> => {
      peer = peer ?? (ctx.modules.get(ANCHOR) as Partial<Anchors> | undefined);
      if (!peer || typeof peer.countOf !== "function") {
        // A declaration naming `models` and not `primitives` is legal, and it draws nothing at all.
        say(ANCHOR, `models: the scene declares no ${ANCHOR} module, so nothing is anchored`);
        return {};
      }
      return peer;
    };
    // One object the families hold, so a peer that is missing at the first window and present at the
    // next needs no rebuild and no second lookup path.
    const anchors: Anchors = {
      positionOf: (kind, idx) => owner().positionOf?.(kind, idx),
      pickIdOf: (kind, idx) => owner().pickIdOf?.(kind, idx),
      showOf: (kind, idx) => owner().showOf?.(kind, idx),
      countOf: (kind) => owner().countOf?.(kind),
    };

    const disposables = [
      ctx.onWindow((w, payload) => {
        const specs = ((payload ?? {}) as ScenePayload).models ?? [];
        if (w.mode === "replace") {
          // A replace may renumber, so a family this window does not name has no author left.
          const named = new Set(specs.map((s) => s.kind));
          for (const [kind, family] of families) {
            if (named.has(kind)) continue;
            family.destroy();
            families.delete(kind);
          }
        }
        for (const spec of specs) {
          let family = families.get(spec.kind);
          if (!family) {
            family = new ModelFamily(spec.kind, ctx.Cesium, ctx.viewer.entities, anchors,
                                     ctx.assetUrl, warn, ctx.perWindow());
            families.set(spec.kind, family);
          }
          family.onWindow(spec, w);
        }
      }),
      ctx.onKeyframe((index) => {
        const at = ctx.placement(index);
        for (const family of families.values()) family.onKeyframe(at);
      }),
      ctx.onFrame(() => {
        for (const family of families.values()) family.onFrame();
      }),
    ];

    return () => {
      for (const dispose of disposables) dispose();
      // The entity collection belongs to the viewer and outlives this module, so every entity added
      // is taken back out one by one.
      for (const family of families.values()) family.destroy();
      families.clear();
      peer = undefined;
    };
  },
};
