// The one handle on the webview channel. `acquireVsCodeApi` may be called only once per page, so
// everything that talks to the extension goes through here.

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | null = null;

export function vsApi(): VsCodeApi {
  return (api ??= acquireVsCodeApi());
}
