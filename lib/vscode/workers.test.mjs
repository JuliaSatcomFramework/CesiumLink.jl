// Runnable check for the worker shim's two decisions: which blob is Cesium's wrapper, and which
// bundled file a worker URL asks for. Run: node lib/vscode/workers.test.mjs
//
// The shim itself needs a browser — a Worker constructor, a fetch and a blob URL — so what is
// checked here is the pair of pure functions that decide where it goes. A mismatch either sends an
// unrelated worker through the shim or leaves a Cesium worker on a URL a webview refuses, and both
// read as a globe that never draws.
import assert from "node:assert/strict";
import { bundledWorkerName, workerUrlInBlob } from "./workers.ts";

// --- the body Cesium's TaskProcessor emits for a cross-origin worker ---
{
  // `createWorker` in @cesium/engine builds exactly this, with no space and one trailing semicolon:
  //   const script = `import "${crossOriginUrl}";`;
  const url = "https://cdn.example/dist/cesium/Workers/createVerticesFromHeightmap.js";
  assert.equal(workerUrlInBlob(`import "${url}";`), url);
  assert.equal(bundledWorkerName(url), "createVerticesFromHeightmap.js");

  // The same wrapper, written by a Cesium version that spaces or breaks it differently.
  assert.equal(workerUrlInBlob(`import"${url}"`), url);
  assert.equal(workerUrlInBlob(`\nimport  "${url}";\n`), url);

  // The name keeps everything after `/Workers/`, so a cache-busting query travels with it.
  assert.equal(bundledWorkerName(`${url}?v=26.1.0`), "createVerticesFromHeightmap.js?v=26.1.0");
}

// --- a blob that is not Cesium's runs untouched ---
{
  // A page may build a worker of its own. The shim must hand it to the native constructor as it is:
  // rewriting it would point it at a file that does not exist.
  assert.equal(workerUrlInBlob("self.onmessage = (e) => postMessage(e.data);"), null);
  // An import, but of something that is not a Cesium worker.
  assert.equal(workerUrlInBlob('import "https://cdn.example/lib/my-worker.js";'), null);
  // A same-origin worker the sandbox already allows.
  assert.equal(bundledWorkerName("worker.js"), null);
  assert.equal(bundledWorkerName("https://cdn.example/dist/cesium/Assets/approximateTerrainHeights.json"), null);
}

console.log("vscode worker shim: ok");
