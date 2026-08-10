#!/usr/bin/env node
// Headless check that a page opened once playback has advanced gets a scene it can draw: run the
// tracks tracer scene, let a first page stream far enough that the server is holding an appended
// window, then open a second page and assert what that page is sent.
//
//   PORT=50021 node tools/tracks/rejoin-check.mjs
//
// An append extends a replace, so it may omit anything that replace established — an area family's
// footprint centres above all. A joining page has received no replace, so being replayed the append
// leaves it with a scene it cannot build. What it must be given instead is a window that stands on
// its own, and that is the assertion here. The windows are read off each page's own socket, so what
// is asserted is what the server actually sent to that page.

import { spawn } from "node:child_process";
import { launchChrome } from "../harness.mjs";

// The port comes from the environment rather than a flag: tools/harness.mjs parses process.argv at
// import time and rejects anything it does not recognise.
const port = Number(process.env.PORT ?? 50021);
const root = new URL("../../", import.meta.url).pathname;

const MODULE_URL = "/modules/primitives/primitives.js";

// Installed before any of the page's own script runs, so it sees the first window a page is sent.
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

const DREW_THE_SCENE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  return !!mod.positionOf("sat", 0);
})()`;

const server = spawn("julia", ["--project=.", "tools/tracks/serve.jl", String(port)],
                     { cwd: root });

const problems = [];
const chrome = await launchChrome();
try {
  // The port, not the log: Julia block-buffers stdout when it is not a terminal, so the line the
  // server prints on startup may sit unflushed for the whole run.
  await until(async () => {
    try {
      return (await fetch(`http://localhost:${port}/index.html`)).ok;
    } catch { return false; }
  }, 180_000, "the tracks server never started");

  const first = await open("first");
  await until(() => evaluate(first, DREW_THE_SCENE), 60_000,
              "the first page never drew the tracks scene");
  // Playback has to eat through the opening window and be topped up, so that what the server is
  // holding when the second page arrives is an append rather than the opening replace.
  const streamed = await until(async () => {
    const w = await evaluate(first, "globalThis.__windows");
    return w.filter((one) => one.mode === "append").length >= 2 ? w : null;
  }, 180_000, "playback never advanced past the opening window");
  console.log(`  streamed  ${streamed.length} windows to the first page` +
              ` (${streamed.filter((w) => w.mode === "append").length} appended)`);

  const second = await open("second");
  const joined = await until(async () => {
    const w = await evaluate(second, "globalThis.__windows");
    return w.length ? w : null;
  }, 60_000, "the second page was sent no window at all");
  console.log(`  joined    first window: ${JSON.stringify(joined[0])}`);

  if (joined[0].mode !== "replace") {
    problems.push(`the joining page was sent a ${joined[0].mode}, which extends a window it never` +
                  " received");
  }
  if (joined[0].startFrame === 0) {
    problems.push("the joining page was sent the opening frames, not where playback had reached");
  }
  if (!(await evaluate(second, DREW_THE_SCENE))) {
    problems.push("the joining page drew no scene");
  }

  // A rebuilt window is broadcast, so the pages already watching are re-based on it and carry on.
  const rebased = await until(async () => {
    const w = await evaluate(first, "globalThis.__windows");
    return w.length > streamed.length ? w : null;
  }, 60_000, "the first page saw nothing after the second joined");
  if (rebased[streamed.length].id === streamed[streamed.length - 1].id) {
    problems.push("the rebuilt window kept the identity of the one it replaced");
  }
  const after = rebased.length;
  if (!(await until(async () => {
    const w = await evaluate(first, "globalThis.__windows");
    return w.length > after;
  }, 60_000, null))) {
    problems.push("the first page stalled on the rebuilt window instead of asking for more");
  }
  console.log(`  rebased   first page continued to ${
    (await evaluate(first, "globalThis.__windows")).length} windows`);
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
console.log("  ok    a page joining mid-playback is sent a window that stands on its own");
process.exit(0);

async function open(what) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const page = chrome.session(sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", (p) =>
    problems.push(`${what} page threw: ` +
      (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text)));
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: TEE_WINDOWS });
  await page.send("Page.navigate", { url: `http://localhost:${port}/?ws=auto` });
  return page;
}

async function evaluate(page, expression, timeoutMs = 60_000) {
  const res = await page.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (res.exceptionDetails) {
    throw new Error("page evaluation failed: " +
      (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  }
  return res.result.value;
}

// Poll `probe` until it returns something truthy, and hand that back. A `what` of null makes the
// timeout an answer of its own rather than a thrown failure.
async function until(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (what === null) return null;
  throw new Error(`${what} (waited ${timeoutMs} ms)`);
}
