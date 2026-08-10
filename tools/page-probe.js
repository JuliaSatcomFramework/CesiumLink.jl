// Page-side half of the regression harness (tools/harness.mjs). Injected before the app's own
// script runs, so the WebSocket and fetch wrappers see the very first byte the viewer receives.
//
// Everything here is measured from outside the viewer's own code: the only entry points used are
// `globalThis.viewer` (the ViewerHandle the browser host publishes) and Cesium's scene/clock. That
// is what lets the same probe measure a build whose internals have been replaced.
(() => {
  const H = {
    /** Every WebSocket frame in either direction: {dir, bytes, method, t}. */
    wire: [],
    /** Round trips that carried a JSON-RPC id: {method, ms}. */
    rpc: [],
    /** Same-origin fetches outside the Cesium asset tree: {url, bytes}. */
    fetches: [],
  };
  globalThis.__harness = H;

  const byteLength = (d) =>
    typeof d === "string" ? new TextEncoder().encode(d).length
    : d instanceof ArrayBuffer ? d.byteLength
    : d && typeof d.byteLength === "number" ? d.byteLength
    : d && typeof d.size === "number" ? d.size
    : 0;

  // The method names what a message carries: `modules`, `window` and `commands` are each their own
  // kind, so a row per method is a row per kind of traffic.
  const label = (msg) => (msg && msg.method ? String(msg.method) : "?");

  const parse = (data) => {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  const NativeWebSocket = globalThis.WebSocket;
  const inFlight = new Map();
  // An event and the command batch answering it are two notifications, paired by the sequence number
  // the batch echoes. That pairing is the only thing that makes a round trip observable from here:
  // nothing on this transport carries a JSON-RPC id any more.
  const inFlightSeq = new Map();
  const seqOf = (msg, method) =>
    msg && msg.method === method && msg.params && msg.params.seq != null ? msg.params.seq : null;
  const WrappedWebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    ws.addEventListener("message", (ev) => {
      const msg = parse(ev.data);
      H.wire.push({ dir: "in", bytes: byteLength(ev.data), method: label(msg), t: performance.now() });
      const pending = msg && msg.id != null ? inFlight.get(msg.id) : undefined;
      if (pending) {
        inFlight.delete(msg.id);
        H.rpc.push({ method: pending.method, ms: performance.now() - pending.t });
      }
      const seq = seqOf(msg, "commands");
      const answered = seq == null ? undefined : inFlightSeq.get(seq);
      if (answered) {
        inFlightSeq.delete(seq);
        H.rpc.push({ method: answered.method, ms: performance.now() - answered.t });
      }
    });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data) => {
      const msg = parse(data);
      const t = performance.now();
      H.wire.push({ dir: "out", bytes: byteLength(data), method: label(msg), t });
      if (msg && msg.id != null) inFlight.set(msg.id, { method: label(msg), t });
      const seq = seqOf(msg, "event");
      if (seq != null) inFlightSeq.set(seq, { method: `${msg.params.module}/${msg.params.topic}`, t });
      nativeSend(data);
    };
    return ws;
  };
  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(WrappedWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  globalThis.WebSocket = WrappedWebSocket;

  // The offline Cesium tree is served from the same origin and dwarfs everything else, so it is
  // excluded: what matters here is the scene payload the viewer was handed.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    const url = String(typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "");
    if (!url.includes("/cesium/") && !url.includes("Assets/")) {
      try {
        H.fetches.push({
          url: new URL(url, location.href).pathname,
          bytes: (await res.clone().arrayBuffer()).byteLength,
        });
      } catch {
        /* body not clonable — size unknown, not worth failing the run over */
      }
    }
    return res;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /** WGS84 geodetic → ECEF, so a fixed camera can be named in degrees without reaching into Cesium. */
  const ecef = (lonDeg, latDeg, height) => {
    const a = 6378137.0;
    const e2 = 6.694379990141316e-3;
    const lon = (lonDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const s = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * s * s);
    return {
      x: (N + height) * Math.cos(lat) * Math.cos(lon),
      y: (N + height) * Math.cos(lat) * Math.sin(lon),
      z: (N * (1 - e2) + height) * s,
    };
  };

  const quantile = (xs, q) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  // Standing primitives, not just a live widget: `globalThis.viewer` is published before anything is
  // delivered to it, so waiting on the handle alone would race the scene's arrival and report on a
  // build that was about to be fed over its transport.
  H.ready = () => {
    const scene = globalThis.viewer && globalThis.viewer.widget && globalThis.viewer.widget.scene;
    return !!scene && (scene.primitives.length > 0 || scene.groundPrimitives.length > 0);
  };

  /**
   * Render the fixed view and report what a renderer regression would move.
   *
   * @param {{camera: {lon: number, lat: number, height: number}, frames: number, ticks: number,
   *          hovers: number, settleMs: number}} opts
   */
  H.measure = async (opts) => {
    const handle = globalThis.viewer;
    const scene = handle.widget.scene;
    const clock = handle.widget.clock;

    const { lon, lat, height } = opts.camera;
    scene.camera.setView({
      destination: ecef(lon, lat, height),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });

    // Frame 0 of the declared range, held still: a command count taken while the clock is running
    // would fold link membership changes at a keyframe crossing into the number.
    clock.shouldAnimate = false;
    clock.currentTime = clock.startTime;

    // Imagery tiles carry draw commands of their own, so the count is only stable once the globe has
    // finished loading the fixed view.
    const deadline = performance.now() + opts.settleMs;
    while (performance.now() < deadline) {
      await nextFrame();
      if (scene.globe.tilesLoaded) break;
    }
    const tilesLoaded = scene.globe.tilesLoaded;
    for (let i = 0; i < 10; i++) await nextFrame();

    // `frameState` is outside Cesium's published typings; its command list is the only place the
    // per-frame draw-call count is observable from outside the renderer. Read on postRender, which
    // fires after the frame's commands have been collected and executed.
    const commands = [];
    const offPostRender = scene.postRender.addEventListener(() => {
      const list = scene.frameState && scene.frameState.commandList;
      if (list) commands.push(list.length);
    });
    while (commands.length < opts.frames) await nextFrame();
    offPostRender();

    // `clock.tick()` is where every onTick listener runs, and the interpolation that moves entities
    // between keyframes is one of them. Shadowing the instance method times the whole tick, which is
    // the figure that matters: what the viewer spends on the main thread before each frame is drawn.
    const ticks = [];
    const nativeTick = clock.tick.bind(clock);
    clock.tick = () => {
      const t0 = performance.now();
      const out = nativeTick();
      ticks.push(performance.now() - t0);
      return out;
    };
    clock.shouldAnimate = true;
    const tickDeadline = performance.now() + opts.settleMs;
    while (ticks.length < opts.ticks && performance.now() < tickDeadline) await nextFrame();
    clock.shouldAnimate = false;
    delete clock.tick;

    // What every pointer event pays before anything else happens. It renders a pick pass, so on a
    // host without a GPU this number carries the rasteriser with it and is only comparable against
    // another run on the same host — reported, never gated on.
    const picks = [];
    const { clientWidth: w, clientHeight: h } = scene.canvas;
    for (let i = 0; i < 20; i++) {
      const p = { x: Math.round(w * (0.35 + 0.015 * i)), y: Math.round(h * (0.35 + 0.015 * i)) };
      const t0 = performance.now();
      scene.pick(p);
      picks.push(performance.now() - t0);
    }

    // A hover that lands on an entity the viewer has not just hovered is its ordinary question to the
    // server, so moving the pointer is how the harness provokes a round trip without knowing what
    // the server answers with. Same host, so the recorded time is server work plus loopback, and the
    // network term of a real deployment is absent from it by construction.
    //
    // The render loop is stopped for this pass. A reply is delivered on the main thread, so leaving
    // it running would fold "how long the rasteriser was holding the thread" into every round trip —
    // on this host that term dominates and says nothing about the server.
    const canvas = scene.canvas;
    const rect = canvas.getBoundingClientRect();
    handle.widget.useDefaultRenderLoop = false;
    for (let i = 0; i < opts.hovers; i++) {
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        clientX: rect.left + w * (0.3 + 0.02 * i),
        clientY: rect.top + h * (0.3 + 0.02 * i),
        bubbles: true,
        pointerType: "mouse",
      }));
      await sleep(60); // past the hover debounce, so each move is dispatched rather than coalesced
    }
    await sleep(500); // let the last reply land before the RPCs are totalled
    handle.widget.useDefaultRenderLoop = true;

    const inbound = H.wire.filter((w) => w.dir === "in");
    const byMethod = {};
    for (const w of inbound) {
      const e = (byMethod[w.method] ??= { count: 0, bytes: 0, maxBytes: 0 });
      e.count += 1;
      e.bytes += w.bytes;
      e.maxBytes = Math.max(e.maxBytes, w.bytes);
    }
    const rpcByMethod = {};
    for (const r of H.rpc) {
      const e = (rpcByMethod[r.method] ??= []);
      e.push(r.ms);
    }

    return {
      source: H.wire.length ? "websocket" : "unknown",
      renderer: rendererString(scene),
      tilesLoaded,
      scene: sceneFingerprint(scene),
      drawCommands: {
        samples: commands.length,
        min: Math.min(...commands),
        median: quantile(commands, 0.5),
        max: Math.max(...commands),
      },
      tickMs: {
        samples: ticks.length,
        median: round(quantile(ticks, 0.5)),
        p95: round(quantile(ticks, 0.95)),
        max: round(Math.max(...ticks)),
      },
      pickMs: {
        samples: picks.length,
        median: round(quantile(picks, 0.5)),
        p95: round(quantile(picks, 0.95)),
      },
      wireBytes: {
        // Anything the page fetched over HTTP outside the Cesium tree, reported the same way a
        // window is: one payload, its size on the wire.
        payloads: H.fetches.map((f) => ({ url: f.url, bytes: f.bytes })),
        inboundByMethod: byMethod,
        inboundTotal: inbound.reduce((n, w) => n + w.bytes, 0),
      },
      roundTripNote:
        "Measured with the render loop stopped, so this is the server's work plus loopback and " +
        "nothing else. Perceived latency in a running viewer additionally waits for the main " +
        "thread, which this host's software rasteriser holds far longer than a real one would.",
      roundTripMs: Object.fromEntries(
        Object.entries(rpcByMethod).map(([m, xs]) => [
          m,
          { samples: xs.length, median: round(quantile(xs, 0.5)), p95: round(quantile(xs, 0.95)) },
        ]),
      ),
    };
  };

  const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

  const rendererString = (scene) => {
    try {
      const gl = scene.context._gl;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    } catch {
      return "unknown";
    }
  };

  // What the scene is made of, so a baseline diff cannot silently compare two different scenes.
  //
  // A collection is identified by its public properties, never by `child.constructor.name`. The
  // host bundles are minified, and esbuild's `minify` renames identifiers, so a class binding reads
  // here as a short name that matches nothing. Property names survive minification, because
  // `mangleProps` is opt-in and this build does not use it.
  const sceneFingerprint = (scene) => {
    const p = scene.primitives;
    let billboards = 0;
    let polylines = 0;
    let primitives = 0;
    for (let i = 0; i < p.length; i++) {
      const child = p.get(i);
      // `textureAtlas` belongs to BillboardCollection alone. PolylineCollection exposes no property
      // of its own, so its first member answers for it: only a Polyline carries `loop`.
      const member = child && typeof child.get === "function" && child.length > 0 ? child.get(0) : null;
      if (child && "textureAtlas" in child) billboards += child.length;
      else if (member && "loop" in member) polylines += child.length;
      primitives += 1;
    }
    return { primitives, billboards, polylines, groundPrimitives: scene.groundPrimitives.length };
  };
})();
