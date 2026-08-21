// The half of a custom-thing registry that every seam spells the same way.
//
// Two seams here let another module register something under an owner-namespaced name. Both hold a
// `Map`, refuse a bare name, refuse a second registration of one name, and empty on teardown. Only
// the `switch` that uses the answer differs, so only this half is shared. It follows
// `defineWidget` and `clearWidgets` in the `ui` module, which already work this way.

import { sourceOf } from "../../core/src/source.ts";

/**
 * One registry of things of kind `what`, where `what` names the kind in a warning ("sprite").
 *
 * A registration that is refused warns and is dropped. It never throws: the module that registers
 * is loading, and a throw there takes down more than the one registration.
 *
 * `clear()` runs when the module unloads. The registered factories close over a context that no
 * longer exists, so they must not outlive it.
 */
export function registry<F>(what: string) {
  const map = new Map<string, F>();
  return {
    define(name: string, f: F): void {
      if (sourceOf(name).kind !== "module") {
        console.warn(`primitives: ${what} ${JSON.stringify(name)} is not owner-namespaced ` +
                     `(e.g. "orbits.${name}"); the registration is ignored`);
        return;
      }
      if (map.has(name)) {
        console.warn(`primitives: ${what} ${JSON.stringify(name)} is already registered; ` +
                     "the registration is ignored");
        return;
      }
      map.set(name, f);
    },
    get: (name: string) => map.get(name),
    clear: () => map.clear(),
  };
}
