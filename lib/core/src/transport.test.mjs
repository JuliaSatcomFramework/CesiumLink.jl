// Runnable check for the WebSocket transport. Run: node lib/core/src/transport.test.mjs
// (a stand-in for the WebSocket global is the whole environment it needs — no server, no framework.)
import assert from "node:assert/strict";

// A socket the test drives: it opens when told to, records what was sent, and delivers frames on
// demand. Registered before the module is imported, so the transport constructs this one.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.last = this;
  }
  addEventListener(type, fn) {
    const fns = this.listeners.get(type) ?? [];
    this.listeners.set(type, fns);
    fns.push(fn);
  }
  send(frame) {
    this.sent.push(splitFrame(frame));
  }
  close() {}
  fire(type, ev) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  open() {
    this.fire("open", {});
  }
  deliver(method, params, region = new Uint8Array(0)) {
    this.fire("message", { data: packFrame(JSON.stringify({ method, params }), region) });
  }
}
globalThis.WebSocket = FakeSocket;

const { WsTransport, firstDeclaration, packFrame, splitFrame } = await import("./transport.ts");

// --- a frame splits back into what it was packed from, across one alignment cycle ---
{
  for (let n = 1; n <= 16; n++) {
    const region = new Uint8Array([7, 7, 7]);
    const { header, region: back } = splitFrame(packFrame("x".repeat(n), region));
    assert.equal(header, "x".repeat(n));
    assert.deepEqual([...back], [7, 7, 7]);
    // The region lands on a multiple of 8, so a Float64Array view over it is legal.
    assert.equal(back.byteOffset % 8, 0, `a header of ${n} bytes leaves the region 8-aligned`);
  }
  // A message with no arrays is a frame with an empty region.
  assert.equal(splitFrame(packFrame("{}", new Uint8Array(0))).region.byteLength, 0);
}

// --- a notification arriving before its handler is held, and replayed in arrival order ---
{
  const t = new WsTransport("ws://x/ws");
  const socket = FakeSocket.last;
  socket.open();
  await t.ready;

  // What a server sends behind its declaration while the host is still building the viewer that
  // will receive it: dropping any of it leaves a scene that is missing its state and cannot ask
  // for it again.
  socket.deliver("commands", { commands: [{ module: "ui", topic: "declare" }] });
  socket.deliver("window", { startFrame: 0 }, new Uint8Array([1, 2, 3]));
  socket.deliver("commands", { commands: [{ module: "ui", topic: "tooltip" }] });

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
  socket.deliver("window", { startFrame: 4 }, new Uint8Array([9]));
  assert.equal(seen.length, 4, "a frame with a handler is not queued");
  assert.deepEqual(seen[3], ["window", { startFrame: 4 }, [9]]);
}

// --- the declaration: what the server names, or nothing once the wait is up ---
{
  const t = new WsTransport("ws://x/ws");
  const socket = FakeSocket.last;
  socket.open();
  await t.ready;
  t.notify("ready", { protocol: 2 });
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0].header), { method: "ready", params: { protocol: 2 } });
  // Nothing travels upward as bytes yet, so an event's region is empty.
  assert.equal(socket.sent[0].region.byteLength, 0);

  // The answer comes back over a socket, so it lands on a later turn — the wait has to be long
  // enough to still be running when it does.
  const declaration = firstDeclaration(t, 1000);
  setTimeout(() => socket.deliver("modules", { modules: [{ id: "ui" }], ellipsoid: { a: 2, b: 1 } }), 20);
  assert.deepEqual(await declaration, { modules: [{ id: "ui" }], ellipsoid: { a: 2, b: 1 } });

  // A server that answers nothing must not hold the page: the wait ends and the caller carries on.
  const t2 = new WsTransport("ws://x/ws");
  FakeSocket.last.open();
  assert.equal(await firstDeclaration(t2, 5), null);
}

// --- a closed socket reaches the host exactly once ---
{
  const t = new WsTransport("ws://x/ws");
  const socket = FakeSocket.last;
  socket.open();
  await t.ready;

  let closes = 0;
  t.onClose = () => closes++;
  socket.fire("close", {});
  assert.equal(closes, 1, "the host learns the server is gone");

  // A transport with no listener must not throw on the way out: the page that never asks about the
  // connection is the one that carries on drawing.
  const t2 = new WsTransport("ws://x/ws");
  const socket2 = FakeSocket.last;
  socket2.open();
  await t2.ready;
  socket2.fire("close", {});
}

console.log("transport: ok");
