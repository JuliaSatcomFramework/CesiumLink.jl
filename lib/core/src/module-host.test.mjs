// Runnable check for the Core module host. Run: node lib/core/src/module-host.test.mjs
// (transpiles module-host.ts in-memory via esbuild — no Cesium, no test framework.)
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const src = await readFile(new URL("./module-host.ts", import.meta.url), "utf8");
const { code } = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { createModuleHost } = await import(
  "data:text/javascript," + encodeURIComponent(code)
);

// A fake module served as a data: URL — exercises the REAL dynamic import(). It reports through a
// global channel because it loads in its own module scope, isolated from this test.
const fakeModule = (key) =>
  "data:text/javascript," +
  encodeURIComponent(`export default { setup(ctx) { (globalThis.${key} ??= []).push(ctx); } };`);

// A declaration entry as the server sends it: the module's own URL, gated by apiVersion.
const decl = (id, url, apiVersion = 0) => ({ id, url, apiVersion });

// --- loads a declared module: gate apiVersion, import the url, call setup(ctx) once ---
{
  globalThis.__p1 = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: (id) => ({ id }) });
  await host.loadAll([decl("p", fakeModule("__p1"))]);
  assert.equal(globalThis.__p1.length, 1, "setup called exactly once");
  assert.equal(globalThis.__p1[0].id, "p", "setup received the context carrying the module id");
  assert.equal(host.has("p"), true, "loaded module is tracked");
}

// --- apiVersion mismatch: warn, do NOT import (no module code runs), stay non-fatal ---
{
  const imported = [];
  const warnings = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: (id) => ({ id }),
    importModule: (url) => {
      imported.push(url);
      return import(url);
    },
    onWarn: (m) => warnings.push(m),
  });
  globalThis.__p1 = [];
  await host.loadAll([decl("bad", fakeModule("__p1"), 99), decl("ok", fakeModule("__p1"))]);
  assert.equal(host.has("bad"), false, "version-mismatched module is not loaded");
  assert.equal(imported.length, 1, "mismatched module is never imported (no code executed)");
  assert.equal(host.has("ok"), true, "a matching module after a mismatch still loads (non-fatal)");
  assert.ok(warnings.some((w) => w.includes("apiVersion")), "the mismatch is warned loudly");
}

// --- declaration order is load order: each setup runs after every earlier module's ---
{
  globalThis.__order = [];
  const step = (name) =>
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup() { globalThis.__order.push(${JSON.stringify(name)}); } };`,
    );
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("a", step("a")), decl("b", step("b")), decl("c", step("c"))]);
  assert.deepEqual(globalThis.__order, ["a", "b", "c"], "setups ran in declaration order");
}

// --- ctx.modules.get: a consumer reaches its provider's exports; nothing else ---
// What crosses the seam is code, never state (ADR-0006): the provider's exported functions.
{
  globalThis.__seen = {};
  const provider =
    "data:text/javascript," +
    encodeURIComponent(
      `export const positionOf = (i) => "pos" + i;` +
        `export default { setup(ctx) { globalThis.__seen.providerSeesConsumer = ctx.modules.get("consumer");` +
        `globalThis.__seen.providerSeesSelf = ctx.modules.get("provider"); } };`,
    );
  const consumer =
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) { globalThis.__seen.provider = ctx.modules.get("provider");` +
        `globalThis.__seen.undeclared = ctx.modules.get("nobody"); } };`,
    );
  // Both lookups happen during setup, so the one aimed at the not-yet-set-up module warns; that is
  // its own case below, and the sink just keeps it off this suite's output.
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}), onWarn: () => {} });
  await host.loadAll([decl("provider", provider), decl("consumer", consumer)]);

  assert.equal(globalThis.__seen.provider.positionOf(2), "pos2", "the provider's exports are reachable");
  assert.equal(globalThis.__seen.undeclared, undefined, "a module that was never declared → undefined");
  assert.ok(
    globalThis.__seen.providerSeesConsumer,
    "a module declared later is reachable too: declaration order does not decide visibility",
  );
  assert.equal(globalThis.__seen.providerSeesSelf, undefined, "a module does not reach its own exports");
}

// --- both directions stay reachable however long after setup the lookup happens ---
{
  globalThis.__ctxs = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("first", fakeModule("__ctxs")), decl("second", fakeModule("__ctxs"))]);
  const [firstCtx, secondCtx] = globalThis.__ctxs;
  assert.ok(firstCtx.modules.get("second"), "the later module is reachable from the earlier one");
  assert.ok(secondCtx.modules.get("first"), "the earlier module stays reachable");
}

// --- a consumer declared BEFORE its provider reaches it through ctx.modules ---
// The pairing no total declaration order can satisfy: a module that both feeds and extends another.
// Only the *call* has to wait for the provider's setup, which is what a callback gives it.
{
  globalThis.__early = {};
  const consumer =
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) {` +
        `globalThis.__early.call = () => ctx.modules.get("late").positionOf(3);` +
        `} };`,
    );
  const provider =
    "data:text/javascript," +
    encodeURIComponent(`export const positionOf = (i) => "pos" + i; export default { setup() {} };`);
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("early", consumer), decl("late", provider)]);
  assert.equal(globalThis.__early.call(), "pos3", "a provider declared after its consumer is reachable");
}

// --- retained commands replay only after EVERY module's setup has run ---
// This is what makes a late contribution work: the command a module is replayed at load is applied
// against the whole declared set, so a module declared after it has already had its say.
{
  globalThis.__phases = [];
  const step = (name, topic) =>
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) { globalThis.__phases.push("setup:" + ${JSON.stringify(name)});` +
        (topic
          ? `ctx.onCommand(${JSON.stringify(topic)}, () => globalThis.__phases.push("replay:" + ${JSON.stringify(name)}));`
          : ``) +
        `} };`,
    );
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    importModule: async (url) => {
      host.dispatch("first", "go", 1); // lands while both are still importing, so it is retained
      return import(url);
    },
  });
  await host.loadAll([decl("first", step("first", "go")), decl("second", step("second"))]);
  assert.deepEqual(
    globalThis.__phases,
    ["setup:first", "setup:second", "replay:first"],
    "the retained command reaches its handler only after the last module's setup",
  );
}

// --- reaching a peer whose setup has not run is warned; the same lookup afterwards is not ---
// The exports exist for the whole declared set before any setup, so a stateful accessor read too
// early would answer undefined instead of failing. The host says so and hands the exports over.
{
  globalThis.__r1 = {};
  const warnings = [];
  const consumer =
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) { globalThis.__r1.during = ctx.modules.get("provider");` +
        `globalThis.__r1.later = () => ctx.modules.get("provider"); } };`,
    );
  const provider =
    "data:text/javascript," +
    encodeURIComponent(`export const positionOf = (i) => "pos" + i; export default { setup() {} };`);
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("consumer", consumer), decl("provider", provider)]);
  assert.equal(globalThis.__r1.during.positionOf(1), "pos1", "the exports come back regardless");
  assert.equal(warnings.length, 1, "exactly the one premature lookup is warned");
  assert.ok(
    warnings[0].includes("consumer") && warnings[0].includes("provider"),
    "the warning names both modules",
  );

  warnings.length = 0;
  assert.ok(globalThis.__r1.later(), "the same lookup from a callback resolves");
  assert.deepEqual(warnings, [], "and is not warned about, since every setup has run");
}

// --- setup's returned cleanup is drained on unload ---
{
  globalThis.__d_setup = false;
  globalThis.__d_dispose = false;
  const host = createModuleHost({ apiVersion: 0, makeContext: (id) => ({ id }) });
  await host.loadAll([
    decl(
      "d",
      "data:text/javascript," +
        encodeURIComponent(
          `export default { setup() { globalThis.__d_setup = true; return () => { globalThis.__d_dispose = true; }; } };`,
        ),
    ),
  ]);
  assert.equal(globalThis.__d_setup, true, "setup ran on load");
  assert.equal(globalThis.__d_dispose, false, "cleanup does not run while loaded");
  host.unload("d");
  assert.equal(globalThis.__d_dispose, true, "cleanup ran on unload");
  assert.equal(host.has("d"), false, "unloaded module is no longer tracked");
}

// --- a capability's own remover is drained on unload, even if setup returns no cleanup ---
// The host tracks it, so a module physically cannot leave a pointer handler or an overlay control
// behind by forgetting to tear it down.
{
  globalThis.__untracked = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: (id, track) => ({
      id,
      onPointer: () => track(() => globalThis.__untracked.push("pointer")),
    }),
  });
  await host.loadAll([
    decl(
      "t",
      "data:text/javascript," +
        encodeURIComponent(`export default { setup(ctx) { ctx.onPointer(() => {}); } };`),
    ),
  ]);
  assert.deepEqual(globalThis.__untracked, [], "registering does not tear down");
  host.unload("t");
  assert.deepEqual(globalThis.__untracked, ["pointer"], "the registration was drained by unload");
}

// --- unloadAll drains every loaded module (the viewer's destroy path) ---
{
  globalThis.__gone = [];
  const bye = (name) =>
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup() { return () => globalThis.__gone.push(${JSON.stringify(name)}); } };`,
    );
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("a", bye("a")), decl("b", bye("b"))]);
  host.unloadAll();
  assert.deepEqual(globalThis.__gone.sort(), ["a", "b"], "every loaded module was torn down");
  assert.equal(host.has("a") || host.has("b"), false, "nothing is tracked after unloadAll");
}

// --- a failing module does not abort loading the others ---
{
  const warnings = [];
  const boomEntry =
    "data:text/javascript," + encodeURIComponent(`throw new Error("boom at import");`);
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: (id) => ({ id }),
    onWarn: (m) => warnings.push(m),
  });
  globalThis.__p1 = [];
  await host.loadAll([decl("boom", boomEntry), decl("good", fakeModule("__p1"))]);
  assert.equal(host.has("boom"), false, "the failing module is not tracked");
  assert.equal(host.has("good"), true, "a later module still loads after one fails");
  assert.ok(warnings.some((w) => w.includes("boom")), "the failure is warned, not thrown");
}

// --- reloading an already-loaded id is refused (a silent reload would orphan disposables) ---
{
  globalThis.__dup = [];
  const warnings = [];
  const entry =
    "data:text/javascript," +
    encodeURIComponent(`export default { setup() { globalThis.__dup.push(1); } };`);
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: (id) => ({ id }),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("dup", entry)]);
  await host.loadAll([decl("dup", entry)]);
  assert.equal(globalThis.__dup.length, 1, "setup runs once; a second load of the same id is refused");
  assert.ok(warnings.some((w) => w.includes("already loaded")), "the refused reload is warned");
}

// A module that registers a topic handler reporting payloads through a global channel.
const rxModule = (topic, key) =>
  "data:text/javascript," +
  encodeURIComponent(
    `export default { setup(ctx) {` +
      `ctx.onCommand(${JSON.stringify(topic)}, (p) => { (globalThis.${key} ??= []).push(p); });` +
      `} };`,
  );

// --- an inbound envelope routes to the registered module+topic handler ---
{
  globalThis.__rx = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("r", rxModule("field", "__rx"))]);
  host.dispatch("r", "field", { n: 1 });
  host.dispatch("r", "field", { n: 2 });
  assert.deepEqual(globalThis.__rx, [{ n: 1 }, { n: 2 }], "envelope payloads reach the topic handler in order");
}

// --- an envelope for an unknown module or topic is warned and ignored, never thrown ---
{
  globalThis.__rx = [];
  const warnings = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("r", rxModule("field", "__rx"))]);
  host.dispatch("nope", "field", { n: 1 }); // unknown module
  host.dispatch("r", "unknown", { n: 2 }); // known module, unregistered topic
  assert.equal(globalThis.__rx.length, 0, "no handler runs for an unknown module/topic");
  assert.equal(warnings.filter((w) => w.includes("unknown module/topic")).length, 2, "each is warned");

  // Neither was retained, so a module later taking that id does not inherit a stray payload.
  globalThis.__nope = [];
  await host.loadAll([decl("nope", rxModule("field", "__nope"))]);
  assert.deepEqual(globalThis.__nope, [], "an undeliverable envelope is dropped, not retained");
}

// --- one handler per topic: a second registration is inert and warned ---
{
  globalThis.__rx = [];
  const warnings = [];
  const twice =
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) {` +
        `ctx.onCommand("t", (p) => { (globalThis.__rx ??= []).push(["a", p]); });` +
        `ctx.onCommand("t", (p) => { (globalThis.__rx ??= []).push(["b", p]); });` +
        `} };`,
    );
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("r", twice)]);
  host.dispatch("r", "t", 1);
  assert.deepEqual(globalThis.__rx, [["a", 1]], "only the first handler for a topic is kept");
  assert.ok(warnings.some((w) => w.includes("already has a handler")), "the duplicate registration is warned");
}

// --- the seq of the event a batch answers travels with the command, and survives retention ---
{
  // A module deciding staleness for itself: it keeps only what answers the last event it saw.
  const seqModule = (key) =>
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) {` +
        `ctx.onCommand("tooltip", (p, seq) => { (globalThis.${key} ??= []).push([p, seq]); });` +
        `} };`,
    );
  globalThis.__seq1 = [];
  globalThis.__seq2 = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("r", seqModule("__seq1"))]);
  host.dispatch("r", "tooltip", { html: "a" }, 41);
  host.dispatch("r", "tooltip", { html: "b" }); // sent unprompted, answering no event
  assert.deepEqual(
    globalThis.__seq1,
    [[{ html: "a" }, 41], [{ html: "b" }, null]],
    "a handler is told which event its command answers, or null when it answers none",
  );

  host.unload("r");
  await host.loadAll([decl("r", seqModule("__seq2"))]);
  assert.deepEqual(
    globalThis.__seq2,
    [[{ html: "b" }, null]],
    "a replayed command carries the seq it arrived with, not the moment of the replay",
  );
}

// --- a throwing topic handler is isolated: warned, not thrown, other topics keep working ---
{
  globalThis.__rx = [];
  const warnings = [];
  const boom =
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) {` +
        `ctx.onCommand("boom", () => { throw new Error("handler boom"); });` +
        `ctx.onCommand("ok", (p) => { (globalThis.__rx ??= []).push(p); });` +
        `} };`,
    );
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("r", boom)]);
  assert.doesNotThrow(() => host.dispatch("r", "boom", 1), "a throwing handler does not propagate");
  host.dispatch("r", "ok", 2);
  assert.deepEqual(globalThis.__rx, [2], "a sibling topic still routes after another topic threw");
  assert.ok(warnings.some((w) => w.includes("handler threw")), "the throw is warned");
}

// --- unload drains topic handlers: a later envelope for that module is ignored ---
{
  globalThis.__rx = [];
  const warnings = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
  });
  await host.loadAll([decl("r", rxModule("field", "__rx"))]);
  host.dispatch("r", "field", 1);
  host.unload("r");
  host.dispatch("r", "field", 2); // routing gone
  assert.deepEqual(globalThis.__rx, [1], "envelopes after unload no longer reach the handler");
  assert.ok(warnings.some((w) => w.includes("unknown module/topic")), "the post-unload envelope is warned as unknown");
}

// --- commands arriving while a declared module is still importing are replayed after its setup ---
// The server replays `modules` and then the retained commands; the import in between is async, so
// the commands land before any handler exists. They must not be lost, nor warned about.
{
  globalThis.__late = [];
  const warnings = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: () => ({}),
    onWarn: (m) => warnings.push(m),
    importModule: async (url) => {
      host.dispatch("slow", "field", { n: 1 });
      host.dispatch("slow", "field", { n: 2 });
      return import(url);
    },
  });
  await host.loadAll([decl("slow", rxModule("field", "__late"))]);
  assert.deepEqual(globalThis.__late, [{ n: 2 }], "the latest payload per topic reaches the handler after setup");
  assert.deepEqual(warnings, [], "a command for a module still importing is not a stray");
}

// --- retained-latest replay: a handler registering after dispatches catches up to the latest ---
// Models a module reloaded mid-session: it starts from the current scene without the server
// re-sending, and only from the LATEST payload per topic.
{
  globalThis.__rx1 = [];
  globalThis.__rx2 = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("r", rxModule("field", "__rx1"))]); // instance 1 → __rx1
  host.dispatch("r", "field", { n: 1 });
  host.dispatch("r", "field", { n: 2 });
  assert.deepEqual(globalThis.__rx1, [{ n: 1 }, { n: 2 }], "live delivery to the first handler");

  host.unload("r");
  await host.loadAll([decl("r", rxModule("field", "__rx2"))]); // instance 2 → replay after setup
  assert.deepEqual(globalThis.__rx2, [{ n: 2 }], "the reloaded handler catches up to the latest retained payload");
  assert.equal(globalThis.__rx1.length, 2, "the unloaded handler is not re-invoked by the replay");
}

// --- reload replays retained topics in recency order (most recently sent applied last) ---
{
  const twoTopic = (key) =>
    "data:text/javascript," +
    encodeURIComponent(
      `export default { setup(ctx) {` +
        `ctx.onCommand("field", (p) => { (globalThis.${key} ??= []).push(["field", p]); });` +
        `ctx.onCommand("grid", (p) => { (globalThis.${key} ??= []).push(["grid", p]); });` +
        `} };`,
    );
  globalThis.__ord1 = [];
  globalThis.__ord2 = [];
  const host = createModuleHost({ apiVersion: 0, makeContext: () => ({}) });
  await host.loadAll([decl("r", twoTopic("__ord1"))]);
  host.dispatch("r", "grid", { k: 1 });
  host.dispatch("r", "field", { s: 1 }); // field is the more recent send
  host.unload("r");
  await host.loadAll([decl("r", twoTopic("__ord2"))]);
  assert.deepEqual(
    globalThis.__ord2,
    [["grid", { k: 1 }], ["field", { s: 1 }]],
    "retained topics replay oldest-first, so the most recently sent (field) is applied last",
  );
}

// --- a live accessor on the capabilities object stays live in the module's ctx ---
// makeContext may expose a getter (ctx.frame reads the active playback's frame index). The
// host must not flatten it to a one-time value when it attaches id/modules/onCommand — a module
// reading ctx.frame every frame must see the current value, not the one at load time.
{
  let live = null; // stands in for the active playback's live frame index
  globalThis.__cf = [];
  const host = createModuleHost({
    apiVersion: 0,
    makeContext: (id) => ({
      id,
      get frame() {
        return live;
      },
    }),
  });
  await host.loadAll([decl("cf", fakeModule("__cf"))]);
  const ctx = globalThis.__cf[0];
  assert.equal(ctx.frame, null, "reads null before playback starts");
  live = 0;
  assert.equal(ctx.frame, 0, "reflects the live value after playback starts (getter not frozen)");
  live = 7;
  assert.equal(ctx.frame, 7, "tracks the advancing frame index every read");
}

console.log("module-host.test.mjs OK");
