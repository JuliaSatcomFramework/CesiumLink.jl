#!/usr/bin/env node
// Headless regression harness: renders the viewer in server-local Chrome and reports the numbers a
// renderer regression would move — draw commands per frame, bytes on the wire per payload, JS time
// per interpolation tick, and the latency of a request that crosses the transport.
//
// Frames per second and frame time are NOT reported and must never be asserted on: this host has no
// GPU and Chrome falls back to SwiftShader, a software rasteriser whose absolute timings say nothing
// about a real machine. Draw-command count is a CPU-side property of how primitives are batched, so
// it stays meaningful; that is the number this harness exists for.
//
// The viewer renders only what a server declares and pushes, so this half always needs one behind
// it; tools/harness.jl starts that server and calls this. Point --url at a server you started
// yourself to measure a scene this repo does not build.
//
//   node tools/harness.mjs --url 'http://localhost:50004/?ws=auto' [--out FILE | --check FILE]
//
// One page is one host. `--key HOST` names which host a run measures, so `--check` reads that
// host's numbers out of a baseline file that holds several.
//
// Chrome is driven over CDP directly, as the docs tooling does — no Puppeteer.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A fixed camera: straight down on the centroid of the scene's cell grid, high enough that the whole
// served region and the constellation above it are in the frustum. Everything about the baseline is
// a property of what is in view, so this may not drift.
const CAMERA = { lon: 12.49, lat: 42.66, height: 12_000_000 };

// The regression this harness exists to catch is an order-of-magnitude one — batching lost, a
// collection per entity. A quarter more draw commands for the same scene is already well past
// anything a faithful re-implementation should cost.
const DRAW_COMMAND_TOLERANCE = 1.25;

const args = parseArgs(process.argv.slice(2));

async function run() {
  const server = args.url ? null : await startViewerServer();
  const url = args.url ?? `http://127.0.0.1:${server.port}/`;
  const chrome = await launchChrome();
  try {
    const report = await measure(chrome, url);
    report.url = url;
    report.capturedAt = new Date().toISOString();
    report.caveat =
      "Frames per second and frame time are meaningless here — this host renders through " +
      "SwiftShader, a software rasteriser. Neither is measured and neither may be asserted on. " +
      "Draw-command count is CPU-side and does not depend on having a GPU.";
    print(report);
    if (args.out) {
      mkdirSync(dirname(resolve(root, args.out)), { recursive: true });
      writeFileSync(resolve(root, args.out), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nbaseline written to ${args.out}`);
    }
    if (args.check) return compare(baselineFor(JSON.parse(readFileSync(resolve(root, args.check), "utf8"))), report);
    return 0;
  } finally {
    await chrome.dispose();
    server?.close();
  }
}

// ---------------------------------------------------------------------------- measurement

async function measure(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const failures = [];
  page.on("Runtime.exceptionThrown", (p) =>
    failures.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));

  // Before the app's own script, so the transport wrappers see the first byte the viewer receives.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: readFileSync(join(root, "tools/page-probe.js"), "utf8"),
  });
  await page.send("Page.navigate", { url });

  // A page that threw never reports ready, so the wait is what fails. Say what the page threw:
  // without it the report is a bare timeout, and the exception that caused it is lost.
  try {
    await waitFor(page, "globalThis.__harness && globalThis.__harness.ready()", args.timeoutMs,
      "viewer never drew a scene");
  } catch (err) {
    if (!failures.length) throw err;
    throw new Error(`${err.message}, and the page threw:\n  ${failures.join("\n  ")}`);
  }
  if (failures.length) throw new Error(`page threw before the scene was ready:\n  ${failures.join("\n  ")}`);

  const opts = {
    camera: CAMERA, frames: args.frames, ticks: args.ticks, hovers: args.hovers,
    settleMs: args.timeoutMs,
  };
  const report = await evaluate(page, `__harness.measure(${JSON.stringify(opts)})`, args.timeoutMs * 3);
  if (failures.length) report.pageErrors = failures;
  return report;
}

/** Evaluate an expression in the page and return its (awaited) value. */
async function evaluate(page, expression, timeoutMs) {
  const res = await page.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs);
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error(`page evaluation failed: ${e.exception?.description ?? e.text}`);
  }
  return res.result.value;
}

async function waitFor(page, expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, `!!(${expression})`, timeoutMs)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${timeoutMs} ms: ${what}`);
}

// ---------------------------------------------------------------------------- reporting

function print(r) {
  const d = r.drawCommands;
  console.log(`\nscene source     ${r.source}`);
  console.log(`renderer         ${r.renderer}`);
  console.log(`globe tiles      ${r.tilesLoaded ? "loaded" : "STILL LOADING — draw counts are not settled"}`);
  console.log(`primitives       ${r.scene.primitives} (${r.scene.billboards} billboards, ` +
    `${r.scene.polylines} polylines, ${r.scene.groundPrimitives} ground)`);
  console.log(`draw commands    median ${d.median}  (min ${d.min}, max ${d.max}, n=${d.samples})`);
  console.log(`tick ms          median ${r.tickMs.median}  p95 ${r.tickMs.p95}  (n=${r.tickMs.samples})`);
  console.log(`pick ms          median ${r.pickMs.median}  p95 ${r.pickMs.p95}  (n=${r.pickMs.samples})`);
  for (const p of r.wireBytes.payloads) console.log(`payload          ${p.bytes} B  ${p.url}`);
  for (const [m, e] of Object.entries(r.wireBytes.inboundByMethod)) {
    console.log(`inbound          ${m}: ${e.count} msg, ${e.bytes} B total, ${e.maxBytes} B largest`);
  }
  for (const [m, e] of Object.entries(r.roundTripMs)) {
    console.log(`round trip       ${m}: median ${e.median} ms, p95 ${e.p95} ms (n=${e.samples})`);
  }
  if (Object.keys(r.roundTripMs).length === 0) {
    console.log(`round trip       none — no request crossed a transport in this run`);
  }
  console.log(`\n${r.caveat}`);
}

/**
 * The part of a baseline file this run is compared against. Every host reports into one file under
 * its own key, so `--key` says which host this run is. A file with no key is the whole report, for a
 * `--url` pointed at a server the caller started.
 */
function baselineFor(file) {
  if (!args.key) return file;
  const base = file[args.key];
  if (!base) throw new Error(`${args.check} records no baseline for the ${args.key} host`);
  return base;
}

/** Diff a fresh run against a stored baseline. Non-zero exit means the renderer regressed. */
function compare(base, now) {
  console.log(`\n--- against ${args.check} (captured ${base.capturedAt}) ---`);
  let failed = 0;
  const line = (ok, text) => {
    console.log(`${ok ? "  ok  " : "FAIL  "}${text}`);
    if (!ok) failed += 1;
  };

  const ratio = now.drawCommands.median / base.drawCommands.median;
  line(ratio <= DRAW_COMMAND_TOLERANCE,
    `draw commands ${base.drawCommands.median} → ${now.drawCommands.median} ` +
    `(${ratio.toFixed(2)}×, budget ${DRAW_COMMAND_TOLERANCE}×)`);

  // The collection counts describe how the scene is built, not what it contains: which Cesium class
  // holds an entity is a renderer's choice, and one batch per (family, style) splits a collection
  // without changing a pixel. A renderer swap moves these legitimately, so they are reported for
  // reading and never asserted on — the scene the run measured is checked from the payload, in
  // tools/harness.jl, where the entity counts are known.
  const fp = (r) => JSON.stringify(r.scene);
  console.log(`  --  collections ${fp(base)} → ${fp(now)} (informational)`);

  // Informational for the same reason as ever: SwiftShader makes absolute JS timings soft, and
  // payload size is a Julia-side choice this harness reports rather than polices.
  const bytes = (r) => r.wireBytes.payloads.reduce((n, p) => n + p.bytes, 0) + r.wireBytes.inboundTotal;
  console.log(`  --  wire bytes ${bytes(base)} → ${bytes(now)} (informational)`);
  console.log(`  --  tick ms median ${base.tickMs.median} → ${now.tickMs.median} (informational)`);

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------- plumbing

function parseArgs(argv) {
  const out = { url: null, out: null, check: null, key: null,
    frames: 30, ticks: 60, hovers: 20, timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in out)) throw new Error(`unknown option ${argv[i]} (expected one of ${Object.keys(out).map((k) => `--${k}`).join(", ")})`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    out[key] = typeof out[key] === "number" ? Number(value) : value;
  }
  return out;
}

/**
 * Serve a directory of the repository on a free port, using the dev server the repo already has.
 * `dir` is relative to `lib/`, where that server lives, and defaults to the built viewer.
 */
export async function startViewerServer(dir = "dist") {
  const port = await freePort();
  const proc = spawn(process.execPath, [join(root, "lib", "serve.mjs")], {
    cwd: root, env: { ...process.env, PORT: String(port), SERVE_ROOT: dir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res, rej) => {
    proc.stdout.once("data", res);
    proc.once("exit", (c) => rej(new Error(`serve.mjs exited with ${c} — is dist/ built?`)));
    setTimeout(() => rej(new Error("serve.mjs did not start")), 10_000);
  });
  return { port, close: () => proc.kill() };
}

export const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

/** Headless Chrome over CDP. Returns a client with `send`, `session` and `dispose`. */
export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "cesium-harness-"));
  const proc = spawn("google-chrome", [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu-shader-disk-cache",
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    "about:blank",
    // `detached` makes Chrome its own process-group leader, so one signal reaches every renderer,
    // zygote and GPU process it forks. Killing the browser alone leaves those writing to the
    // profile, which puts the directory back after it is removed.
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });

  // Chrome outlives this process unless something kills it, and a run that ends anywhere other than
  // `dispose` — a launch that fails, an interrupt — never reaches the caller's `finally`. Reap from
  // the exit path as well. A SIGKILL still leaks; sweep /tmp/cesium-harness-* by hand if
  // one ever does.
  const killGroup = (signal) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Already gone, or never started a group of its own.
    }
  };
  const reap = () => {
    killGroup("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = () => process.exit(1);
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  process.once("exit", reap);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  // A registered signal listener holds the event loop open, so drop them all once Chrome is gone.
  const unwatch = () => {
    process.off("exit", reap);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };

  let stderr = "";
  let endpoint;
  try {
    endpoint = await new Promise((res, rej) => {
      proc.stderr.on("data", (d) => {
        stderr += d;
        const m = stderr.match(/ws:\/\/\S+/);
        if (m) res(m[0]);
      });
      proc.once("error", rej);
      proc.once("exit", (c) => rej(new Error(`chrome exited with ${c}:\n${stderr}`)));
      setTimeout(() => rej(new Error(`chrome did not report a debugging endpoint:\n${stderr}`)), 20_000);
    });
  } catch (err) {
    unwatch();
    reap();
    throw err;
  }

  const ws = new WebSocket(endpoint);
  try {
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
  } catch (err) {
    unwatch();
    reap();
    throw err;
  }

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result);
    } else {
      for (const fn of listeners.get(`${msg.sessionId ?? ""}:${msg.method}`) ?? []) fn(msg.params);
    }
  });

  const send = (method, params, sessionId, timeoutMs = 30_000) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
    pending.set(id, { method, res: settle(res), rej: settle(rej) });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

  return {
    send: (method, params, timeoutMs) => send(method, params, undefined, timeoutMs),
    session: (sessionId) => ({
      send: (method, params, timeoutMs) => send(method, params, sessionId, timeoutMs),
      on: (event, fn) => {
        const key = `${sessionId}:${event}`;
        listeners.set(key, [...(listeners.get(key) ?? []), fn]);
      },
    }),
    dispose: async () => {
      unwatch();
      ws.close();
      const exited = once(proc, "exit");
      killGroup("SIGTERM");
      // Chrome rewrites its profile while it shuts down, so removing the directory before it goes
      // leaves the directory behind.
      await exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

// Importable for its Chrome launcher (tools/tracks/check.mjs reuses it); only the CLI entry runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run());
}
