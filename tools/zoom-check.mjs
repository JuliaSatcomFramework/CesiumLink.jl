#!/usr/bin/env node
// A globe on a declared basemap must fetch sharper tiles as the camera comes in. This is the one
// check that asserts it: the Julia tests mount a tile directory, and `scene.test.mjs` builds a
// provider, but neither watches a globe ask for a deeper level.
//
//   node tools/zoom-check.mjs                 # the fixture's full depth: level 2 must arrive
//   MAXLEVEL=0 node tools/zoom-check.mjs      # pinned flat: the same check must fail
//
// It serves the repository root and opens `lib/dist/index.html` on the fixture pyramid, with no
// server behind it. It counts the tiles the page asks for, zooms the camera in, and waits for a
// level-2 request. Options come from the environment: `harness.mjs` parses `process.argv` when it
// is imported, and it rejects an argument it does not know.
//
// This is not the draw-command harness and does not belong inside it: that one gates how the
// renderer batches a fixed scene, and this one asks whether the globe fetches what it needs.
// `npm run build` first — the page it drives is the built one.
import { launchChrome, startViewerServer } from "./harness.mjs";

const FIXTURE = "/tools/fixtures/basemap/xyz/{z}/{x}/{y}.png";
const DEEPEST = 2;
const maxLevel = Number(process.env.MAXLEVEL ?? DEEPEST);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 30_000);
// A tile of the fixture, and the level it is at.
const TILE = /\/tools\/fixtures\/basemap\/xyz\/(\d+)\/\d+\/\d+\.png/;

async function run() {
  const server = await startViewerServer("..");
  const chrome = await launchChrome();
  const levels = [];
  try {
    const url = `http://127.0.0.1:${server.port}/lib/dist/index.html` +
      `?imagery=${encodeURIComponent(FIXTURE)}&maxlevel=${maxLevel}`;
    console.log(`zoom check: ${url}`);
    const page = await open(chrome, url, levels);

    await waitFor(() => levels.length > 0,
      `the globe asked for no tile of the fixture at all — is ${FIXTURE} served, and is dist/ built?`);
    console.log(`  the globe wears the fixture: level ${Math.min(...levels)} first`);

    const height = await evaluate(page, `(() => {
      const camera = viewer.widget.scene.camera;
      camera.zoomIn(camera.positionCartographic.height * 0.98);
      return camera.positionCartographic.height;
    })()`);
    console.log(`  zoomed to ${Math.round(height / 1000)} km`);

    await waitFor(() => levels.includes(DEEPEST),
      `the camera zoomed in and no level-${DEEPEST} tile was ever requested`);
    console.log(`\nPASS: the zoom fetched level ${DEEPEST} (${histogram(levels)})`);
    return 0;
  } catch (err) {
    console.error(`\nFAIL: ${err.message}`);
    console.error(`  tiles requested: ${histogram(levels) || "none"}`);
    return 1;
  } finally {
    await chrome.dispose();
    server.close();
  }
}

/** Open the page with the tile requests recorded, and wait for the viewer to exist. */
async function open(cdp, url, levels) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  // Requests, not what is drawn: `scene.pick` and anything else that reads a rendered pixel is
  // unreliable on this host, which has no GPU and rasterises in software.
  page.on("Network.requestWillBeSent", (p) => {
    const m = TILE.exec(p.request.url);
    if (m) levels.push(Number(m[1]));
  });
  const failures = [];
  page.on("Runtime.exceptionThrown", (p) =>
    failures.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));

  await page.send("Page.navigate", { url });
  await waitFor(async () => await evaluate(page, "!!globalThis.viewer"), "the page built no viewer");
  if (failures.length) throw new Error(`the page threw:\n  ${failures.join("\n  ")}`);
  return page;
}

async function evaluate(page, expression) {
  const res = await page.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs);
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error(`page evaluation failed: ${e.exception?.description ?? e.text}`);
  }
  return res.result.value;
}

/** Poll until `holds`, or fail loudly with what was seen instead. */
async function waitFor(holds, what) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await holds()) return;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  throw new Error(`${what} (waited ${timeoutMs} ms)`);
}

const histogram = (levels) => [...new Set(levels)].sort()
  .map((z) => `level ${z}: ${levels.filter((l) => l === z).length}`).join(", ");

process.exit(await run());
