#!/usr/bin/env node
// Headless check that a pointer event reaches Julia: click a satellite in the tracks tracer scene,
// once per modifier combination, and assert the listener registered in tools/tracks/serve.jl saw the
// entity, the modifiers and the frame. Runs the whole loop — Julia server, real viewer in
// server-local Chrome, real scene.pick — because that is the only place the pick id, the
// subscription, the input-action registration and the 0-based/1-based boundary are all exercised at
// once.
//
//   PORT=50007 node tools/tracks/pointer-check.mjs
//
// The server prints one `click {...}` line per event its listener answered; this reads that line
// back. A viewer that forwarded nothing, or that resolved the hit to the wrong entity, leaves it
// absent or wrong.
//
// The whole matrix is driven rather than one gesture because the failure this guards against is
// per-combination: ScreenSpaceEventHandler keys its actions on the entire modifier set held, so a
// combination the Core did not register an action for is dropped inside Cesium and never reaches
// any of the code below. Only a real browser can show that — a unit test over a stubbed handler
// asserts the registrations the Core makes, not the key format Cesium looks them up under.

import { spawn } from "node:child_process";
import { launchChrome } from "../harness.mjs";

// The port comes from the environment rather than a flag: tools/harness.mjs parses process.argv at
// import time and rejects anything it does not recognise.
const port = Number(process.env.PORT ?? 50007);
const root = new URL("../../", import.meta.url).pathname;

const MODULE_URL = "/modules/primitives/primitives.js";

// CDP's modifier bitmask, and every subset of the three the Core registers an action for. The
// expected set is in the order the Core reports one, which is the order the listener prints.
const ALT = 1, CTRL = 2, SHIFT = 8;
const COMBINATIONS = [
  { mask: 0, expect: [] },
  { mask: ALT, expect: ["alt"] },
  { mask: CTRL, expect: ["ctrl"] },
  { mask: SHIFT, expect: ["shift"] },
  { mask: ALT | CTRL, expect: ["alt", "ctrl"] },
  { mask: ALT | SHIFT, expect: ["alt", "shift"] },
  { mask: CTRL | SHIFT, expect: ["ctrl", "shift"] },
  { mask: ALT | CTRL | SHIFT, expect: ["alt", "ctrl", "shift"] },
];

// The scene is drawn once the renderer holds a position for the first satellite.
const DREW_THE_SCENE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  return !!mod.positionOf("sat", 0);
})()`;

// Runs in the page: project each satellite to the canvas through the renderer's own read-only
// accessor and return the first that scene.pick actually resolves to a stamped primitive there.
const PICK_A_SATELLITE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  const scene = globalThis.viewer.widget.scene;
  for (let i = 0; ; i++) {
    const p = mod.positionOf("sat", i);
    if (!p) return null;
    const w = scene.cartesianToCanvasCoordinates(p);
    if (!w || !Number.isFinite(w.x)) continue;
    const hit = scene.pick(w);
    const id = hit && hit.id;
    if (id && typeof id.kind === "string") {
      return { kind: id.kind, idx: id.idx, x: Math.round(w.x), y: Math.round(w.y) };
    }
  }
})()`;

const server = spawn("julia", ["--project=.", "tools/tracks/serve.jl", String(port)],
                     { cwd: root });
let log = "";
server.stdout.on("data", (b) => { log += b; });
server.stderr.on("data", (b) => { log += b; });

const problems = [];
const chrome = await launchChrome();
try {
  await until(() => log.includes("tracks scene on http"), 120_000, "the tracks server never started");

  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const page = chrome.session(sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", (p) =>
    problems.push(`page threw: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));

  await page.send("Page.navigate", { url: `http://localhost:${port}/?ws=auto` });
  await until(async () => await evaluate(page, DREW_THE_SCENE),
              30_000, "the primitives module never drew the tracks scene");

  // Hold the clock before choosing a target. A satellite crosses several of its own glyph widths in
  // the time three CDP round trips take, so a moving scene is picked at one instant and clicked at
  // another, and the click lands on empty sky.
  await evaluate(page, "globalThis.viewer.widget.clock.shouldAnimate = false");

  // A satellite that is both projected inside the canvas and actually picked there: the far side of
  // the globe projects to coordinates that hit nothing.
  const target = await until(() => evaluate(page, PICK_A_SATELLITE), 30_000,
                             "no satellite was pickable on the visible side of the globe");
  console.log(`  target    ${target.kind} ${target.idx} at (${target.x}, ${target.y})`);

  // One click per combination. The down/up pair is what Cesium synthesises LEFT_CLICK from, and the
  // modifiers ride on all three events so the whole gesture is held under the same keys.
  for (const c of COMBINATIONS) {
    const name = c.expect.length ? c.expect.join("+") : "(none)";
    const answered = (log.match(/^click /gm) ?? []).length;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent",
        { type, x: target.x, y: target.y, button: "left", clickCount: 1, modifiers: c.mask });
    }
    // Wait for the whole line, not just its prefix: the server's stdout arrives in chunks, and a
    // report split across two of them parses as truncated JSON.
    let got = null;
    try {
      got = await until(() => {
        const all = [...log.matchAll(/^click (.*)\n/gm)];
        return all.length > answered ? JSON.parse(all[all.length - 1][1]) : null;
      }, 15_000, `no ${name} click reached the Julia listener`);
    } catch (e) {
      problems.push(String(e.message ?? e));
      console.log(`  FAIL  ${name.padEnd(16)} → nothing arrived`);
      continue;
    }
    console.log(`  ok    ${name.padEnd(16)} → ${JSON.stringify(got.mods)}`);

    if (got.kind !== target.kind) problems.push(`${name}: kind ${got.kind}, not ${target.kind}`);
    // The wire is 0-based and the Julia API 1-based, so the listener's index is the viewer's plus one.
    if (got.idx !== target.idx + 1) problems.push(`${name}: idx ${got.idx}, not ${target.idx + 1}`);
    if (JSON.stringify(got.mods) !== JSON.stringify(c.expect)) {
      problems.push(`${name}: mods ${JSON.stringify(got.mods)}, not ${JSON.stringify(c.expect)}`);
    }
    if (!Number.isInteger(got.frame) || got.frame < 1) problems.push(`${name}: frame ${got.frame}`);
  }
} catch (e) {
  problems.push(String(e.message ?? e));
} finally {
  chrome.dispose();
  server.kill("SIGKILL");
}

if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log("  ok    a click on an entity reaches the Julia listener under every modifier combination");
process.exit(0);

async function evaluate(page, expression, timeoutMs = 60_000) {
  const res = await page.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (res.exceptionDetails) {
    throw new Error("page evaluation failed: " +
      (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  }
  return res.result.value;
}

// Poll `probe` until it returns something truthy, and hand that back.
async function until(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} (waited ${timeoutMs} ms)`);
}
