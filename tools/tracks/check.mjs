#!/usr/bin/env node
// Headless check for the tracks tracer scene: drives the real viewer in server-local Chrome against
// a running `tools/tracks/serve.jl`, and asserts that the scene animates from a Julia-pushed
// sequence of windows and stays continuous across an append seam.
//
//   node tools/tracks/check.mjs [--url http://localhost:50006/?ws=auto]
//
// Nothing in the page is written for this check. The windows are read off the socket, so what is
// asserted is what the server actually sent; the motion is read through the `primitives` module's
// own read-only accessor, reached by importing the module from the URL the Core imported it from —
// the browser keys module instances by resolved URL, so that is the live instance, not a second one.
//
// A seam that teleported an entity shows up as a per-tick step far larger than the steady one; a
// buffer that stalled shows up as a run of ticks with no motion at all. Draw commands per frame are
// reported, never asserted on: this scene is small, and the number is here to be watched.

import { launchChrome } from "../harness.mjs";

const MODULE_URL = "/modules/primitives/primitives.js";

const url = argOf("--url") ?? "http://localhost:50006/?ws=auto";
// Long enough for playback to eat through the opening window and be topped up several
// times on a host whose rasteriser is software: this scene renders at a few frames a second.
const settleMs = Number(argOf("--settle") ?? 20_000);

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Installed before any of the page's own script runs, so it sees the opening window too.
const TEE_WINDOWS = `
  globalThis.__windows = [];
  const Native = WebSocket;
  globalThis.WebSocket = function (...args) {
    const ws = new Native(...args);
    ws.addEventListener("message", (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.method === "window") {
          const p = m.params;
          globalThis.__windows.push({ mode: p.mode, startFrame: p.startFrame, count: p.count,
                                      id: p.window });
        }
      } catch { /* not a frame this check reads */ }
    });
    return ws;
  };
  globalThis.WebSocket.prototype = Native.prototype;
`;

// Samples what the module draws through its own read-only accessors — the first satellite's
// interpolated position, and how many links stand — plus the per-frame draw-command count, on every
// rendered frame.
const PROBE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  const scene = globalThis.viewer.widget.scene;
  const probe = (globalThis.__probe = { x: [], links: [], endpoints: [], commands: [] });
  scene.postRender.addEventListener(() => {
    const p = mod.positionOf("sat", 0);
    if (p) probe.x.push(p.x);
    const c = mod.pairsOf("link");
    if (c) {
      probe.links.push(c.pairs.length / 2);
      if (c.pairs.length) probe.endpoints.push(mod.edgeEndpoints("link", 0) ? 1 : 0);
    }
    const list = scene.frameState && scene.frameState.commandList;
    if (list) probe.commands.push(list.length);
  });
})()`;

const chrome = await launchChrome();
let code = 1;
try {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const page = chrome.session(sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const failures = [];
  page.on("Runtime.exceptionThrown", (p) =>
    failures.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));

  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: TEE_WINDOWS });
  await page.send("Page.navigate", { url });
  await waitFor(page, "globalThis.__windows && globalThis.__windows.length > 0",
                20_000, "the viewer never received a window");
  await evaluate(page, PROBE);
  await new Promise((r) => setTimeout(r, settleMs));
  const { windows, probe } = await evaluate(page,
    "({windows: globalThis.__windows, probe: globalThis.__probe})");

  const { x, links, endpoints, commands } = probe;
  const appends = windows.filter((w) => w.mode === "append");
  const steps = x.slice(1).map((v, i) => Math.abs(v - x[i])).filter((d) => d > 0);
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  const largest = steps[steps.length - 1];

  console.log(`  windows   ${windows.length} (${appends.length} appended)`);
  console.log(`  identity  ${[...new Set(windows.map((w) => w.id))].join(", ")}`);
  console.log(`  coverage  frames ${windows[0].startFrame}..${
    Math.max(...windows.map((w) => w.startFrame + w.count - 1))}`);
  console.log(`  ticks     ${x.length} samples, median step ${median?.toFixed(1)} m,` +
              ` largest ${largest?.toFixed(1)} m`);
  console.log(`  links     ${Math.max(0, ...links)} at the busiest sampled keyframe,` +
              ` endpoints readable on ${endpoints.filter(Boolean).length}/${endpoints.length}`);
  console.log(`  draw      ${percentile(commands, 0.5)} commands/frame (median of ${
    commands.length}; informational — this host has no GPU)`);

  const problems = [];
  if (windows[0].mode !== "replace") problems.push("the opening window was not a replace");
  if (appends.length < 1) problems.push("no window was appended — nothing answered a need");
  if (new Set(windows.map((w) => w.id)).size !== 1) {
    problems.push("the window identity moved under an append");
  }
  if (x.length < 60) problems.push(`only ${x.length} render ticks — playback did not run`);
  // Visibility comes and goes over the run, so the links are asserted to appear at all rather than
  // to be there at any one keyframe — and wherever one stands, its endpoints must be readable.
  if (!links.length) problems.push("the edge family was never delivered");
  if (Math.max(0, ...links) === 0) problems.push("no link was ever drawn over the whole run");
  if (endpoints.some((ok) => !ok)) {
    problems.push("an edge stood with no endpoints the accessor could read");
  }
  // The seam is what this checks: a teleport at it is a step orders of magnitude past the steady
  // one. Positions move a few kilometres per tick, so 8× the median is well clear of jitter and far
  // below the ~450 km a whole keyframe interval covers.
  if (largest > 8 * median) {
    problems.push(`a step of ${largest.toFixed(1)} m against a median of ${median.toFixed(1)} m ` +
                  "— something jumped, most likely at an append seam");
  }
  if (failures.length) problems.push(`page threw: ${failures.join("; ")}`);

  if (problems.length) for (const p of problems) console.log(`FAIL  ${p}`);
  else console.log("  ok    the tracks scene animates across its append seams");
  code = problems.length ? 1 : 0;
} finally {
  // `process.exit` here would abandon this block and leave Chrome running, so set the code and let
  // the script end on its own.
  await chrome.dispose();
}
process.exit(code);

function percentile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function evaluate(page, expression, timeoutMs = 30_000) {
  const res = await page.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (res.exceptionDetails) {
    throw new Error(`page evaluation failed: ` +
      `${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result.value;
}

async function waitFor(page, expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} (waited ${timeoutMs} ms for ${expression})`);
}
