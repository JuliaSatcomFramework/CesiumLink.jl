// Runnable check for the notebook transport.
// Run: node lib/slate/transport.test.mjs
// The check needs no notebook. A stand-in for the two page functions of Slate is the full
// environment.
import assert from "node:assert/strict";

// The Slate side of the page socket. `slateOnStream` holds one handler for each channel, and
// `slateCall` records what the page sends up. They are set before the import of the module, so the
// transport uses them.
const streams = new Map();
const calls = [];
globalThis.slateOnStream = (channel, fn) => {
  streams.set(channel, fn);
  return () => streams.delete(channel);
};
globalThis.slateOffStream = (channel) => streams.delete(channel);
globalThis.slateCall = (channel, args, onProgress, buffers) => {
  calls.push({ channel, args, buffers });
  return Promise.resolve(null);
};

const { SlateTransport } = await import("./transport.ts");
const { packFrame, splitFrame } = await import("../core/src/transport.ts");

const CHANNEL = "cesiumlink/1234/1";
/** One frame as Slate gives it: a new buffer, with the payload under `d`. */
const down = (method, params, region = new Uint8Array(0)) => {
  const packed = new Uint8Array(packFrame(JSON.stringify({ method, params }), region));
  streams.get(CHANNEL)({ d: packed });
};

// --- a notification arriving before its handler is held, and replayed in arrival order ---
{
  const t = new SlateTransport(CHANNEL);
  await t.ready;

  // What a server sends after its declaration, while the host still builds the viewer that must
  // receive it. If the transport drops one of these frames, the scene loses state, and it cannot
  // ask for the state again.
  down("commands", { commands: [{ module: "ui", topic: "declare" }] });
  down("window", { startFrame: 0 }, new Uint8Array([1, 2, 3]));
  down("commands", { commands: [{ module: "ui", topic: "tooltip" }] });

  const seen = [];
  t.on("window", (p, bytes) => seen.push(["window", p, [...bytes]]));
  t.on("commands", (p) => seen.push(["commands", p.commands[0].topic]));
  assert.deepEqual(seen, [], "the queue holds while the host registers the handlers");

  await Promise.resolve();
  assert.deepEqual(
    seen,
    [["commands", "declare"], ["window", { startFrame: 0 }, [1, 2, 3]], ["commands", "tooltip"]],
    "the held frames arrive one time, in the order that the server sent them",
  );
}

// --- the bytes survive both directions with their length ---
{
  const t = new SlateTransport(CHANNEL);
  calls.length = 0;

  // Up: one event, packed into the same frame that a socket carries, and sent as a buffer and not
  // in the JSON arguments.
  t.notify("event", { module: "core", topic: "need" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, `${CHANNEL}/up`, "the uplink is a channel of its own");
  assert.equal(calls[0].buffers.length, 1);
  const sent = splitFrame(calls[0].buffers[0].buffer);
  assert.deepEqual(JSON.parse(sent.header), {
    method: "event",
    params: { module: "core", topic: "need" },
  });

  // Down: a window and the region behind it, of the size that the server packed. The reader takes
  // the region as a `Float64Array`, so the region must stay on a multiple of 8. That is why the
  // transport copies the frame into its own buffer before the split.
  const region = new Uint8Array(64).fill(7);
  let got = null;
  t.on("window", (p, bytes) => (got = bytes));
  down("window", { startFrame: 0 }, region);
  await Promise.resolve();
  assert.equal(got.byteLength, 64, "the region keeps its length across the notebook socket");
  assert.equal(got.byteOffset % 8, 0, "the region stays aligned for a Float64Array view");
  assert.deepEqual([...got.subarray(0, 4)], [7, 7, 7, 7]);
}

// --- a frame that arrives as a view inside a larger buffer is still read from where it starts ---
{
  const t = new SlateTransport(CHANNEL);
  const packed = new Uint8Array(packFrame(JSON.stringify({ method: "event", params: { seq: 3 } }),
                                          new Uint8Array(0)));
  const held = new Uint8Array(8 + packed.byteLength);
  held.set(packed, 8);
  let late = null;
  t.on("event", (p) => (late = p));
  streams.get(CHANNEL)({ d: held.subarray(8) });
  await Promise.resolve();
  assert.deepEqual(late, { seq: 3 }, "a frame is read from where it starts");
}

// --- close releases the channel, so a cell that renders again leaves no handler ---
{
  const t = new SlateTransport(CHANNEL);
  assert.ok(streams.has(CHANNEL));
  t.close();
  assert.equal(streams.has(CHANNEL), false, "the stream handler goes with the transport");
}

console.log("slate transport: ok");
