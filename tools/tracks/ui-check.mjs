#!/usr/bin/env node
// Headless check that the overlay and the tooltip are Julia's to declare: run the tracks tracer
// scene, and assert that what `tools/tracks/serve.jl` declares is what the page shows, that an
// alt-click answered by a Julia listener reaches the screen as a float anchored to the entity
// clicked, and that operating a widget changes the scene only by way of the window the server pushes
// back.
//
//   PORT=50008 node tools/tracks/ui-check.mjs
//
// Nothing in the page is written for this check. The commands are Julia's, the widgets are the
// vendored `ui` module's, and the windows are read off the socket.

import { spawn } from "node:child_process";
import { launchChrome } from "../harness.mjs";

// The port comes from the environment rather than a flag: tools/harness.mjs parses process.argv at
// import time and rejects anything it does not recognise.
const port = Number(process.env.PORT ?? 50008);
const root = new URL("../../", import.meta.url).pathname;

const MODULE_URL = "/modules/primitives/primitives.js";

// Installed before any of the page's own script runs, so it sees the opening window too.
const TEE_WINDOWS = `
  globalThis.__windows = [];
  const Native = WebSocket;
  globalThis.WebSocket = function (...args) {
    const ws = new Native(...args);
    globalThis.__ws = ws;
    ws.addEventListener("message", (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.method === "window") globalThis.__windows.push({ mode: m.params.mode, id: m.params.window });
      } catch { /* not a frame this check reads */ }
    });
    return ws;
  };
  globalThis.WebSocket.prototype = Native.prototype;
`;

// What the overlay shows, as a reader of the page sees it: the declared widgets, the tooltip and
// every float, each read out of the shadow root its content is mounted in.
const OVERLAY = `(() => {
  const app = document.getElementById("app");
  // Only the fragments: a float's other child is its close affordance, which holds no content.
  const content = (box) => box && box.style.display !== "none"
    ? [...box.children].filter((f) => f.shadowRoot).map((f) => f.shadowRoot.textContent) : null;
  const box = app.querySelector('input[type=checkbox]');
  return {
    text: app.innerText,
    toggle: box ? box.checked : null,
    gradient: [...app.querySelectorAll("div")]
      .map((d) => d.style.backgroundImage).find((b) => b && b.includes("gradient")) ?? null,
    hover: content(app.querySelector('[data-ui="tooltip"]')),
    floats: Object.fromEntries([...app.querySelectorAll("[data-float]")]
      .map((f) => [f.dataset.float, content(f)])),
  };
})()`;

// The group the legend and the toggle are declared in: the innermost box holding both of them, so
// what is asserted is what a reader of the page sees rather than a structure this check assumed.
const GROUP = `(() => {
  const app = document.getElementById("app");
  const painted = (el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)";
  const box = [...app.querySelectorAll("div")].filter((d) =>
    d.querySelector('input[type=checkbox]') &&
    [...d.querySelectorAll("div")].some((x) => (x.style.backgroundImage || "").includes("gradient"))
  ).at(-1);
  if (!box) return null;
  return {
    children: box.children.length,
    direction: getComputedStyle(box).flexDirection,
    chrome: painted(box),
    childChrome: painted(box.querySelector('input[type=checkbox]').closest("label")),
  };
})()`;

const DREW_THE_SCENE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  return !!mod.positionOf("sat", 0);
})()`;

// The first satellite that both projects inside the canvas and is actually picked there.
const PICK_A_SATELLITE = `(async () => {
  const mod = await import(${JSON.stringify(MODULE_URL)});
  const scene = globalThis.viewer.widget.scene;
  for (let i = 0; ; i++) {
    const p = mod.positionOf("sat", i);
    if (!p) return null;
    const w = scene.cartesianToCanvasCoordinates(p);
    if (!w || !Number.isFinite(w.x)) continue;
    const hit = scene.pick(w);
    if (hit && hit.id && typeof hit.id.kind === "string") {
      return { kind: hit.id.kind, idx: hit.id.idx, x: Math.round(w.x), y: Math.round(w.y) };
    }
  }
})()`;

// A fragment carrying a script, arriving as a command batch on the socket the page already holds —
// the one path anything reaches a module by. Assigning innerHTML mounts the markup without ever
// running it, so the marker must still be undefined with the text on screen.
const SCRIPT_PROBE = `(() => {
  globalThis.__ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    method: "commands",
    params: { commands: [{ module: "ui", topic: "tooltip",
      payload: { html: ["<script>globalThis.__ran = true;<\\/script>inert"] } }] },
  })}));
  const box = document.getElementById("app").querySelector('[data-ui="tooltip"]');
  return { ran: globalThis.__ran === true, text: box.children[0].shadowRoot.textContent };
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
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: TEE_WINDOWS });

  await page.send("Page.navigate", { url: `http://localhost:${port}/?ws=auto` });
  await until(async () => await evaluate(page, DREW_THE_SCENE),
              30_000, "the primitives module never drew the tracks scene");

  // --- the declared overlay ---------------------------------------------------------------------
  const first = await until(async () => {
    const o = await evaluate(page, OVERLAY);
    return /Keyframe \d+ of 240/.test(o.text) ? o : null;
  }, 30_000, "the declared overlay never rendered");
  console.log(`  overlay   ${first.text.match(/Keyframe \d+ of 240/)[0]}, toggle=${first.toggle}`);
  if (!first.text.includes("Satellites in view")) problems.push("the declared legend is missing");
  if (!first.gradient) problems.push("the legend drew no colorbar gradient");
  if (first.toggle !== true) problems.push(`the toggle opened at ${first.toggle}, not its declared true`);

  // --- the declared group is one box ------------------------------------------------------------
  const group = await evaluate(page, GROUP);
  if (!group) {
    problems.push("the legend and the toggle are not inside one box");
  } else {
    console.log(`  group     ${group.children} controls, flex-direction:${group.direction}`);
    if (group.children !== 2) problems.push(`the group holds ${group.children} controls, not 2`);
    if (group.direction !== "row") {
      problems.push(`the group's declared style did not reach it (flex-direction:${group.direction})`);
    }
    if (!group.chrome) problems.push("the group drew no panel of its own");
    if (group.childChrome) problems.push("a control inside the group kept a panel of its own");
  }

  // The per-keyframe title is selected locally, on the crossing, with no round trip.
  const captionOf = (o) => o.text.match(/Keyframe \d+ of 240/)[0];
  const moved = await until(async () => {
    const o = await evaluate(page, OVERLAY);
    return captionOf(o) !== captionOf(first) ? o : null;
  }, 60_000, "the per-keyframe title never tracked the clock");
  console.log(`  title     ${captionOf(first)} → ${captionOf(moved)}`);

  // --- a pointer event answered by Julia reaches the screen -------------------------------------
  // Hold the clock: a satellite crosses several of its own glyph widths in the time three CDP round
  // trips take, so a moving scene is picked at one instant and clicked at another.
  await evaluate(page, "globalThis.viewer.widget.clock.shouldAnimate = false");
  const target = await until(() => evaluate(page, PICK_A_SATELLITE), 30_000,
                             "no satellite was pickable on the visible side of the globe");
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent",
      { type, x: target.x, y: target.y, button: "left", clickCount: 1, modifiers: 1 });
  }
  // The float is declared under the entity's own id, which the Julia API numbers 1-based while the
  // wire is 0-based — so it names the viewer's index + 1.
  const id = `sat-${target.idx + 1}`;
  const floats = await until(async () => {
    const o = await evaluate(page, OVERLAY);
    return o.floats[id] ? o.floats : null;
  }, 15_000, "the click was never answered on screen");
  console.log(`  float     ${id} ${JSON.stringify(floats[id])}`);
  if (!floats[id].some((f) => f && f.includes(`Pinned sat ${target.idx + 1}`))) {
    problems.push(`the float says ${JSON.stringify(floats[id])}, not the entity clicked`);
  }
  // The float's content is keyframed, and it was declared after every buffered window was built, so
  // it reads its declared placeholder until a window carrying its track arrives. The clock is held
  // here, so nothing but the window the click pushes back can fill it in.
  const tracked = await until(async () => {
    const f = (await evaluate(page, OVERLAY)).floats[id];
    return f && f.some((c) => c && /at keyframe \d+/.test(c)) ? f : null;
  }, 15_000, "the pinned float still reads its declared placeholder");
  console.log(`  float     ${id} took its content from a window: ${JSON.stringify(tracked)}`);
  // Hovering an entity fills the tooltip, which is a separate box the float does not share.
  const hovered = await until(async () => (await evaluate(page, OVERLAY)).hover,
                              15_000, "hovering an entity produced no tooltip");
  if (!hovered.some((f) => f && f.includes("Satellite"))) {
    problems.push(`the hover tooltip says ${JSON.stringify(hovered)}`);
  }
  if (!(await evaluate(page, OVERLAY)).floats[id]) {
    problems.push("the hover tooltip replaced the float; the two boxes are not independent");
  }

  const script = await evaluate(page, SCRIPT_PROBE);
  if (script.ran) problems.push("a script inside a tooltip fragment executed");
  if (!script.text.includes("inert")) problems.push("the fragment carrying a script did not render");

  // --- a control changes the scene only through the server --------------------------------------
  // Answering the control re-declares the whole overlay, of which only the toggle's row differs.
  // The caption is marked first: applying a declaration must leave an unchanged row's element
  // exactly where it is, which is what lets a widget hold state the declaration does not describe.
  await evaluate(page, `(() => {
    const app = document.getElementById("app");
    const caption = [...app.querySelectorAll("div")]
      .find((d) => /Keyframe \\d+ of 240/.test(d.textContent) && !d.querySelector("div"));
    caption.dataset.probe = "kept";
  })()`);
  const before = await evaluate(page, "globalThis.__windows.length");
  await evaluate(page, `(() => {
    const box = document.getElementById("app").querySelector('input[type=checkbox]');
    box.checked = false;
    box.dispatchEvent(new Event("change"));
  })()`);
  const after = await until(async () => {
    const o = await evaluate(page, OVERLAY);
    const windows = await evaluate(page, "globalThis.__windows.length");
    return windows > before && o.toggle === false ? o : null;
  }, 30_000, "operating the toggle produced no window and no re-declaration");
  console.log(`  control   toggle=${after.toggle} after a replacement window`);
  if (!/^control /m.test(log)) problems.push("the control never reached the Julia listener");

  const kept = await evaluate(page, `(() => {
    const el = document.getElementById("app").querySelector('[data-probe="kept"]');
    return el ? el.textContent : null;
  })()`);
  console.log(`  reconcile caption element survived the re-declaration: ${JSON.stringify(kept)}`);
  if (!kept) problems.push("the re-declaration rebuilt a row it did not change");
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
console.log("  ok    Julia declares the overlay, and its answers reach the screen");
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
