import test from "node:test";
import assert from "node:assert/strict";
import { registry } from "./registry.ts";

/** Run `f` with `console.warn` captured, and answer what it wrote. */
function warnings(f: () => void): string[] {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => said.push(m);
  try {
    f();
  } finally {
    console.warn = warn;
  }
  return said;
}

test("a name that is not owner-namespaced is refused and warns", () => {
  const r = registry<number>("sprite");
  const said = warnings(() => r.define("pulse", 1));
  assert.equal(r.get("pulse"), undefined);
  assert.match(said.join("\n"), /orbits\.pulse/);
});

test("a second registration of one name is refused and warns", () => {
  const r = registry<number>("sprite");
  r.define("orbits.pulse", 1);
  const said = warnings(() => r.define("orbits.pulse", 2));
  // The first registration stands, so a module cannot take over a name another module answers.
  assert.equal(r.get("orbits.pulse"), 1);
  assert.match(said.join("\n"), /already registered/);
});

test("clear empties it", () => {
  const r = registry<number>("sprite");
  r.define("orbits.pulse", 1);
  r.clear();
  assert.equal(r.get("orbits.pulse"), undefined);
  // And the name is free again, so reloading the module registers it a second time.
  r.define("orbits.pulse", 2);
  assert.equal(r.get("orbits.pulse"), 2);
});
