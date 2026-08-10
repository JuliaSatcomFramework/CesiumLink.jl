import test from "node:test";
import assert from "node:assert/strict";
import { declarationOf, parseRecording, RecordingTransport } from "./recording.ts";

// A recording of the smallest useful session: an overlay declaration and one window, both stamped
// at zero, the way `record!` writes what a server is already retaining.
const HEADER = {
  recording: 2,
  modules: [{ id: "primitives", path: "/somewhere/dist/modules/primitives/primitives.js", apiVersion: 2 }],
};
const WINDOW = { t: 0, msg: { method: "window", params: { startFrame: 0, count: 4 } }, blobs: "" };
const COMMANDS = { t: 0, msg: { method: "commands", params: { commands: [] } } };
const FILE = [HEADER, COMMANDS, WINDOW].map((o) => JSON.stringify(o)).join("\n") + "\n";

const parsed = () => parseRecording(FILE);

test("parses a version 2 recording into its header and its frames", () => {
  const { header, lines } = parsed();
  assert.equal(header.modules[0].id, "primitives");
  assert.equal(lines.length, 2);
});

test("refuses a version 1 recording rather than drawing it wrong", () => {
  const v1 = JSON.stringify({ recording: 1, modules: [] }) + "\n";
  assert.throws(() => parseRecording(v1), /version 1 recording carries its arrays/);
});

test("drops a partial trailing line instead of failing the session", () => {
  const warned: string[] = [];
  const { lines } = parseRecording(FILE + '{"t":9,"msg":{"meth', (m) => warned.push(m));
  assert.equal(lines.length, 2);
  assert.equal(warned.length, 1);
});

test("declares the scene the recording states, so a replay needs no query string", () => {
  const d = declarationOf({
    ...HEADER,
    ellipsoid: { a: 1737400, b: 1737400 },
    imagery: { url: "https://tiles.test/{z}/{x}/{y}.png", layout: "xyz" },
    lighting: true,
    stars: true,
    furniture: { items: { timeline: false } },
  });
  assert.deepEqual(d.ellipsoid, { a: 1737400, b: 1737400 });
  assert.equal((d.imagery as { url: string }).url, "https://tiles.test/{z}/{x}/{y}.png");
  assert.equal(d.lighting, true);
  assert.equal(d.stars, true);
  // The player builds this set before the first paint, so the page never shows the default one.
  assert.deepEqual(d.furniture, { items: { timeline: false } });
});

test("a recording that states no scene declares none, as it did before the header carried one", () => {
  const d = declarationOf(HEADER);
  assert.equal(d.ellipsoid, undefined);
  assert.equal(d.imagery, undefined);
  assert.equal(d.lighting, undefined);
  assert.equal(d.stars, undefined);
});

test("an option beats the header, which is how relocated tiles are named again", () => {
  const header = {
    ...HEADER,
    ellipsoid: { a: 1737400, b: 1737400 },
    imagery: false as const,
  };
  const d = declarationOf(header, {
    imagery: { url: "copied/{z}/{x}/{y}.png", layout: "xyz" },
    ellipsoid: { a: 6378137, b: 6356752 },
  });
  assert.equal((d.imagery as { url: string }).url, "copied/{z}/{x}/{y}.png");
  assert.deepEqual(d.ellipsoid, { a: 6378137, b: 6356752 });
});

test("a recorded `false` imagery declares a globe with no base layer, not an absent field", () => {
  const d = declarationOf({ ...HEADER, imagery: false });
  assert.equal(d.imagery, false, "absent is the bundled texture, and `false` is no texture at all");
});

test("rebuilds a module URL the way the server built it", () => {
  const d = declarationOf(HEADER, { modulesBase: "https://example.test/viewer/modules" });
  assert.equal(
    (d.modules[0] as { url: string }).url,
    "https://example.test/viewer/modules/primitives/primitives.js",
  );
});

test("delivers frames to a handler registered after construction", async () => {
  const t = new RecordingTransport(parsed());
  const got: string[] = [];
  t.on("window", () => got.push("window"));
  t.on("commands", () => got.push("commands"));
  // The queue drains on a microtask, so the held frames replay in arrival order.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(got, ["commands", "window"]);
  t.close();
});

test("answers a request for keyframes out of the recorded windows", async () => {
  const t = new RecordingTransport(parsed());
  let windows = 0;
  t.on("window", () => windows++);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(windows, 1);
  t.notify("event", { module: "core", topic: "need", payload: { startFrame: 1, count: 2 } });
  assert.equal(windows, 2, "the recorded window covering those frames is sent again");
  t.close();
});

test("warns rather than answers when nothing recorded covers the request", () => {
  const warned: string[] = [];
  const t = new RecordingTransport(parsed(), { onWarn: (m) => warned.push(m) });
  t.on("window", () => {});
  t.notify("event", { module: "core", topic: "need", payload: { startFrame: 99, count: 2 } });
  assert.match(warned.join(" "), /nothing recorded covers frames 99/);
  t.close();
});

test("drops an event no recording can answer", async () => {
  const t = new RecordingTransport(parsed());
  let windows = 0;
  t.on("window", () => windows++);
  await Promise.resolve();
  await Promise.resolve();
  t.notify("event", { module: "ui", topic: "control", payload: { id: "band", value: false } });
  assert.equal(windows, 1, "a control reaches nobody, so the scene does not change");
  t.close();
});

test("close stops a paced recording from delivering anything more", async () => {
  const paced = JSON.stringify(HEADER) + "\n" +
    JSON.stringify({ t: 0.05, msg: { method: "window", params: { startFrame: 0, count: 1 } } }) + "\n";
  const t = new RecordingTransport(parseRecording(paced));
  let windows = 0;
  t.on("window", () => windows++);
  t.close();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(windows, 0);
});
