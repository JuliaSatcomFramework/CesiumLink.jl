// Cesium's workers, made to run inside a webview.
//
// Do not remove this. Without it the globe never draws: even ellipsoid terrain tessellates through
// `createVerticesFromHeightmap`, and every asynchronous primitive goes through `createGeometry`.
//
// The wall: the page's origin is not the origin the assets are served from, `new Worker()` on a
// cross-origin URL throws SecurityError, and a worker-context fetch or import bypasses the webview's
// resource interception and hangs. Cesium's own `TaskProcessor` wraps a cross-origin worker URL in a
// blob whose body is `import "https://…/Workers/name.js";`, which hangs for the same reason.
//
// The way through: the build bundles every worker self-contained into `cesium/WorkersBundled/`, the
// source is fetched on the MAIN thread, and it runs as a same-origin blob module worker. Messages
// and listeners queue until the real worker exists.

/**
 * The Cesium worker a blob body imports, or null when the body is not one of Cesium's wrappers.
 *
 * A page may build a blob worker of its own, and that one runs untouched.
 */
export function workerUrlInBlob(body: string): string | null {
  return body.match(/import\s*"([^"]+\/Workers\/[^"]+)"/)?.[1] ?? null;
}

/**
 * The name of the bundled worker `url` asks for, or null when `url` names none of Cesium's.
 *
 * The name keeps whatever the URL puts after `/Workers/`, so a query string travels with it.
 */
export function bundledWorkerName(url: string): string | null {
  return url.split("/Workers/")[1] ?? null;
}

/**
 * Replace `window.Worker` so a cross-origin Cesium worker runs from `assetBase`. `assetBase` ends
 * with a slash and holds the `cesium/` tree. Call it before Cesium builds anything.
 */
export function installWorkerShim(assetBase: string): void {
  const Native = window.Worker;

  const resolve = async (url: string): Promise<string> => {
    let u = url;
    if (u.startsWith("blob:")) {
      const inner = workerUrlInBlob(await (await fetch(u)).text());
      if (inner === null) return u;           // an unrelated blob worker — run it as it is
      u = inner;
    }
    const name = bundledWorkerName(u);
    if (name === null) return u;              // not one of Cesium's — leave it alone
    const bundled = `${assetBase}cesium/WorkersBundled/${name}`;
    const r = await fetch(bundled);
    if (!r.ok) throw new Error(`worker shim: HTTP ${r.status} for ${bundled}`);
    return URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" }));
  };

  class ShimWorker implements Worker {
    onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
    onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;
    onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
    private inner: Worker | null = null;
    private dead = false;
    private sends: unknown[][] = [];
    private listeners: [string, EventListenerOrEventListenerObject][] = [];

    constructor(url: string | URL) {
      void resolve(String(url)).then((resolved) => {
        if (this.dead) return;
        const w = new Native(resolved, { type: "module" });
        w.onmessage = (ev) => this.onmessage?.call(w, ev);
        w.onerror = (ev) => this.onerror?.call(w, ev);
        w.onmessageerror = (ev) => this.onmessageerror?.call(w, ev);
        for (const [type, fn] of this.listeners) w.addEventListener(type, fn);
        for (const args of this.sends) (w.postMessage as (...a: unknown[]) => void)(...args);
        this.listeners = [];
        this.sends = [];
        this.inner = w;
      }).catch((e) => {
        console.error("worker shim: could not start a worker", url, e);
        this.onerror?.call(this as unknown as AbstractWorker, e as ErrorEvent);
      });
    }

    postMessage(...args: unknown[]): void {
      this.inner
        ? (this.inner.postMessage as (...a: unknown[]) => void)(...args)
        : this.sends.push(args);
    }
    addEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
      this.inner ? this.inner.addEventListener(type, fn) : this.listeners.push([type, fn]);
    }
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
      this.inner?.removeEventListener(type, fn);
    }
    dispatchEvent(ev: Event): boolean {
      return this.inner ? this.inner.dispatchEvent(ev) : false;
    }
    terminate(): void {
      this.dead = true;
      this.inner?.terminate();
    }
  }

  // Only the URLs the sandbox refuses are rerouted; a same-origin worker still gets the real one.
  window.Worker = function (url: string | URL, opts?: WorkerOptions) {
    const u = String(url);
    return /^https?:/.test(u) || u.startsWith("blob:")
      ? (new ShimWorker(url) as unknown as Worker)
      : new Native(url, opts);
  } as unknown as typeof Worker;
}
