// Runnable check for the webview transport, and for the scene URI its extension answers on.
// Run: node lib/vscode/transport.test.mjs
// (a stand-in for the webview channel is the whole environment it needs — no editor, no framework.)
import assert from "node:assert/strict";

// The channel the extension is on the other end of: it records what the page posts, and delivers
// what the extension sends down. Registered before the module is imported, so the transport takes
// this one.
const posted = [];
const listeners = [];
globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === "message") listeners.push(fn);
  },
};
/** What the extension posts down. The channel uses structured clone, so bytes stay bytes. */
const down = (data) => {
  for (const fn of listeners) fn({ data });
};

const { VsCodeTransport } = await import("./transport.ts");
const { packFrame, splitFrame } = await import("../core/src/transport.ts");

/** One frame as the extension relays it off the socket. */
const frame = (method, params, region = new Uint8Array(0)) => ({
  type: "frame",
  payload: new Uint8Array(packFrame(JSON.stringify({ method, params }), region)),
});

// --- the page speaks first, and says it once ---
{
  const t = new VsCodeTransport(50);
  // A webview drops a message posted before the page listens. The extension holds every frame
  // until this, so a page that never says it reads as an empty globe.
  assert.deepEqual(posted, [{ type: "hello" }], "the page announces its listener, before anything else");

  down({ type: "open" });
  await t.ready;
  down({ type: "open" });
  down(frame("window", { startFrame: 0 }));
  assert.equal(
    posted.filter((m) => m.type === "hello").length,
    1,
    "the greeting goes out once, whatever else arrives",
  );
}

// --- a notification arriving before its handler is held, and replayed in arrival order ---
{
  posted.length = 0;
  const t = new VsCodeTransport(50);
  down({ type: "open" });
  await t.ready;

  // What a server sends behind its declaration while the host is still building the viewer that
  // will receive it: dropping any of it leaves a scene that is missing its state and cannot ask
  // for it again.
  down(frame("commands", { commands: [{ module: "ui", topic: "declare" }] }));
  down(frame("window", { startFrame: 0 }, new Uint8Array([1, 2, 3])));
  down(frame("commands", { commands: [{ module: "ui", topic: "tooltip" }] }));

  const seen = [];
  // The region travels with its message: a window queued before its handler exists would
  // otherwise arrive with every array it carries pointing into nothing.
  t.on("window", (p, bytes) => seen.push(["window", p, [...bytes]]));
  t.on("commands", (p) => seen.push(["commands", p.commands[0].topic]));
  assert.deepEqual(seen, [], "nothing is replayed while handlers are still being registered");

  await Promise.resolve();
  assert.deepEqual(
    seen,
    [["commands", "declare"], ["window", { startFrame: 0 }, [1, 2, 3]], ["commands", "tooltip"]],
    "the held frames arrive once, in the order the server sent them",
  );

  // Once a handler exists, delivery is immediate again.
  down(frame("window", { startFrame: 4 }, new Uint8Array([9])));
  assert.equal(seen.length, 4, "a frame with a handler is not queued");
  assert.deepEqual(seen[3], ["window", { startFrame: 4 }, [9]]);
}

// --- the bytes survive both directions with their length ---
{
  const t = new VsCodeTransport(50);
  down({ type: "open" });
  await t.ready;
  posted.length = 0;

  // Upward: one event, packed into the same frame a socket would carry.
  t.notify("event", { module: "core", topic: "need" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "frame");
  assert.ok(posted[0].payload instanceof Uint8Array, "the channel is given bytes, not text");
  const sent = splitFrame(posted[0].payload.buffer);
  assert.deepEqual(JSON.parse(sent.header), {
    method: "event",
    params: { module: "core", topic: "need" },
  });

  // Downward: a window and the region behind it, of the size the server packed.
  const region = new Uint8Array(64).fill(7);
  let got = null;
  t.on("window", (p, bytes) => (got = bytes));
  down(frame("window", { startFrame: 0 }, region));
  await Promise.resolve();
  assert.equal(got.byteLength, 64, "the region keeps its length across the channel");
  assert.deepEqual([...got.subarray(0, 4)], [7, 7, 7, 7]);

  // The extension may hand down a view inside a larger buffer, and a frame is read from offset 0.
  const held = new Uint8Array(8 + posted[0].payload.byteLength);
  held.set(posted[0].payload, 8);
  let late = null;
  t.on("event", (p) => (late = p));
  down({ type: "frame", payload: held.subarray(8) });
  await Promise.resolve();
  assert.deepEqual(late, { module: "core", topic: "need" }, "a frame is read from where it starts");
}

// --- a closed socket reaches the host exactly once ---
{
  const t = new VsCodeTransport(50);
  down({ type: "open" });
  await t.ready;

  let closes = 0;
  t.onClose = () => closes++;
  down({ type: "closed", reason: "the server stopped" });
  assert.equal(closes, 1, "the host learns the server is gone");

  // A transport with no listener must not throw on the way out: the page that never asks about the
  // connection is the one that carries on drawing.
  const t2 = new VsCodeTransport(50);
  down({ type: "closed" });
  await assert.rejects(t2.ready);
}

// --- the port of a pushed scene ---
{
  const { default: uri } = await import("../../extension/uri.js");

  assert.equal(uri.scenePort("/open/50005"), 50005, "the port the Julia server pushes");
  assert.equal(uri.scenePort("/open/1"), 1);

  // A handler that finds no port opens nothing, and says so. These are the shapes that reach it
  // and must not read as a port.
  assert.equal(uri.scenePort("/open"), null);
  assert.equal(uri.scenePort("/open/"), null);
  assert.equal(uri.scenePort("/open/50005/6"), null);
  assert.equal(uri.scenePort("/other/50005"), null);
  assert.equal(uri.scenePort(""), null);
  assert.equal(uri.scenePort(undefined), null);
  // The command line percent-encodes a query on its way here, so a query carries no port at all:
  // `?port=50005` arrives as the path `/open` and the query `port%3D50005`.
  assert.equal(uri.scenePort("/open?port=50005"), null);
}

console.log("vscode transport: ok");
