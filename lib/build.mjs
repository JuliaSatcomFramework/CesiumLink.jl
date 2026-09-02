// Build: bundle the browser host (which pulls in lib/core) and assemble the
// offline Cesium asset tree that CESIUM_BASE_URL points at.
//
// The VSCode host additionally needs each Workers/*.js bundled self-contained into WorkersBundled/,
// for the cross-origin worker shim. That step is at the end of this file.
import esbuild from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const engine = join(root, "node_modules/@cesium/engine");
const widgets = join(root, "node_modules/@cesium/widgets");
const watch = process.argv.includes("--watch");

// One engine, for both @cesium/engine and @cesium/widgets.
//
// A version range here that @cesium/widgets cannot satisfy makes npm install a second engine of its
// own below it. Nothing downstream notices: the build succeeds, the tests pass and the harness holds
// its draw-command count, while the bundle carries two of every class and an `instanceof` across the
// two answers no for the same kind of object. Loud here instead.
if (existsSync(join(widgets, "node_modules/@cesium/engine"))) {
  throw new Error(
    "@cesium/widgets has an @cesium/engine of its own: the two no longer agree on a version. " +
    "Widen the @cesium/engine range in lib/package.json until `npm ls @cesium/engine` reports one.",
  );
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Offline Cesium runtime tree (Assets + Workers + ThirdParty) served under dist/cesium/.
cpSync(join(engine, "Source/Assets"), join(dist, "cesium/Assets"), { recursive: true });
cpSync(join(engine, "Build/Workers"), join(dist, "cesium/Workers"), { recursive: true });
cpSync(join(engine, "Build/ThirdParty"), join(dist, "cesium/ThirdParty"), { recursive: true });
// The Cesium tree above is Apache-2.0 and the release artifact redistributes it. Section 4 of that
// license asks for the license text to travel with the files it covers.
cpSync(join(engine, "LICENSE.md"), join(dist, "cesium/LICENSE-engine.md"));
cpSync(join(widgets, "LICENSE.md"), join(dist, "cesium/LICENSE-widgets.md"));

// The Core's own assets, served under dist/annotations/: the place names and country boundaries the
// label overlay draws. `tools/make-annotation-data.mjs` writes them, by hand, and they are
// committed, so this copy is the only thing between them and the browser.
cpSync(join(root, "core/assets"), dist, { recursive: true });

// Drop the worker files no worker reaches.
//
// A published `Build/Workers` may hold files left behind by an earlier release build, which nothing
// imports. Copying the directory whole carries them into the release artifact, which ships as a
// Julia artifact and is downloaded. 26.2.0 is the release that made this worth doing; the count the
// step prints says what a given release left behind, and a clean one leaves it with nothing to do.
//
// The roots are the `.js` files not named `chunk-*.js`. Cesium asks for a worker by name at run
// time, through `TaskProcessor`, so an entry point is a run-time root that no import graph points
// at — which is also why a bundler cannot do this and the tree has to be walked here.
//
// Reachability is any mention of a file's name in another file's text, not an import statement
// specifically. Coarser than parsing, and deliberately so: it keeps a file that is named in a form
// the parse would miss, and the cost of being coarse is at worst a file kept that could have gone.
//
// The names searched for are the ones the directory holds, rather than a pattern that describes
// them. A pattern can read a name short and drop a live worker; a literal cannot.
{
  const dir = join(dist, "cesium/Workers");
  const present = new Set(readdirSync(dir).filter((f) => f.endsWith(".js")));
  const chunkName = new RegExp(
    [...present].filter((f) => f.startsWith("chunk-")).map((f) => f.replaceAll(".", "\\.")).join("|"),
    "g",
  );
  const reached = new Set();
  const pending = [...present].filter((f) => !f.startsWith("chunk-"));
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const named of readFileSync(join(dir, file), "utf8").matchAll(chunkName)) {
      if (present.has(named[0])) pending.push(named[0]);
    }
  }
  const dropped = [...present].filter((f) => !reached.has(f));
  for (const file of dropped) rmSync(join(dir, file));
  if (dropped.length > 0) {
    console.log(`pruned ${dropped.length} unreachable Cesium worker files of ${present.size}`);
  }
}

// A host is a directory here with a `main.ts` in it. The list is scanned rather than written down,
// so a new host is a directory and nothing else to remember.
const hosts = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "main.ts")))
  .map((d) => d.name)
  .sort();

// A host's bundle is named for its directory, and its page is `<host>/index.html` copied to the
// root of `dist/`. Two names are older than that rule and are named in the pages that load them, so
// they are stated here: the browser host is the site's own `index.html` and its bundle is `app.js`.
// A host absent from PAGE ships no page of its own — the extension gives the VSCode host one.
const BUNDLE = { browser: "app" };
const PAGE = { browser: "index.html", player: "player.html" };
for (const host of hosts) {
  if (PAGE[host]) cpSync(join(root, host, "index.html"), join(dist, PAGE[host]));
}
// The regression harness measures the VSCode host from this page: headless Chrome cannot open a
// webview, so the page loads the same bundle behind a stub of the webview channel.
cpSync(join(root, "../tools/vscode-harness.html"), join(dist, "vscode-harness.html"));
// The mount point of the Slate host. Slate puts the text of this module into the notebook page, so
// the build copies the module and does not bundle it. The Julia extension reads it from here, which
// keeps the module and the bundle that it imports in one build.
cpSync(join(root, "slate/component.js"), join(dist, "slate-component.js"));

// `.icon.png` is the basemap picker's thumbnails (lib/core/src/basemap-icons.ts), inlined into the
// bundle. esbuild reads the longest extension first, so this one is `dataurl` while every other
// `.png` stays a file. They are inlined because a served icon would need a second rebasing path
// beside `lib/vscode/imagery.ts`: the four hosts each resolve `baseUrl` differently, and a `data:`
// URI is identical in all of them.
const loader = {
  ".css": "css", ".png": "file", ".icon.png": "dataurl", ".jpg": "file", ".gif": "file",
  ".svg": "file",
};

// Every host, in ONE build. Each is the same Core reached through a different transport: the
// browser host over a socket, the player from a recording file, the VSCode host through the
// extension's channel, the Slate host over the page socket of a notebook. They are separate entries
// rather than one with a flag, so a page carries only the transport that it uses.
//
// One build, because esbuild shares a chunk only between the entry points of one build. A separate
// build for each host compiles the whole of Cesium again each time, and saves nothing. The object form of
// `entryPoints` names the outputs — `dist/app.js`, `dist/player.js`, `dist/vscode.js`,
// `dist/slate.js` and their `.css` siblings — which the pages, `extension.js` and the Slate
// component all name. An array with `outdir` cannot: every host's source is called `main.ts`.
//
// `splitting` needs `format: "esm"`, so the pages load these with `<script type="module">`. A
// module script is deferred, and a `file://` page can no longer load one.
//
// The shared chunk lands in the root of `dist/` as `chunk-<hash>.js`. Keep it there: the worker
// step below reads `dist/cesium/Workers` and filters that directory's own `chunk-*.js` files out
// of its entry list by name.
const hostOpts = {
  entryPoints: Object.fromEntries(
    hosts.map((host) => [BUNDLE[host] ?? host, join(root, host, "main.ts")])),
  bundle: true,
  format: "esm",
  splitting: true,
  // No source maps, and minified: this is the whole of Cesium. The maps of these three entries are
  // 21 MB, which is more than the rest of `dist/` together. The tree ships as a release artifact
  // and deploys to the documentation site, so those 21 MB are paid on every download. Pass
  // `--sourcemap` to get them back for a debugging session.
  sourcemap: process.argv.includes("--sourcemap"),
  outdir: dist,
  // The vendored modules below keep their maps: they are what someone reads to learn how to write
  // one, and all four together are under 60 KB.
  minify: true,
  loader,
  logLevel: "info",
};

// The vendored modules ship inside the core dist, one directory each. They load only when the
// Julia server declares them by path — nothing here names them to the viewer. Each carries no
// @cesium/engine of its own (only type-only imports, erased): it uses the Core's single instance
// via its context, so there is one Cesium, not two (the dual-package hazard).
const primitivesModuleOpts = {
  entryPoints: [join(root, "primitives/src/index.ts")],
  bundle: true,
  format: "esm",
  sourcemap: true,
  outfile: join(dist, "modules/primitives/primitives.js"),
  logLevel: "info",
};

const uiModuleOpts = {
  entryPoints: [join(root, "ui/src/index.ts")],
  bundle: true,
  format: "esm",
  sourcemap: true,
  outfile: join(dist, "modules/ui/ui.js"),
  logLevel: "info",
};

const heatmapModuleOpts = {
  entryPoints: [join(root, "heatmap/src/index.ts")],
  bundle: true,
  format: "esm",
  sourcemap: true,
  outfile: join(dist, "modules/heatmap/heatmap.js"),
  logLevel: "info",
};

const modelsModuleOpts = {
  entryPoints: [join(root, "models/src/index.ts")],
  bundle: true,
  format: "esm",
  sourcemap: true,
  outfile: join(dist, "modules/models/models.js"),
  logLevel: "info",
};

const modules = [primitivesModuleOpts, uiModuleOpts, heatmapModuleOpts, modelsModuleOpts];

const entries = [hostOpts, ...modules];

// Every Cesium worker, bundled self-contained for the VSCode host. A webview cannot construct a
// cross-origin worker, and a worker-context import inside one hangs, so the host fetches these on
// the main thread and runs them as same-origin blobs (lib/vscode/workers.ts).
//
// The `chunk-*.js` files are shared pieces the others import; esbuild inlines them, so only the
// named workers are entry points. Which ones a scene reaches depends on what it draws, so all of
// them are built, always. A flag here would make the output depend on how the build was invoked,
// and a dist tree that silently lacks these reads as an empty globe.
const workerSrc = join(dist, "cesium/Workers");
const workerEntries = readdirSync(workerSrc)
  .filter((f) => f.endsWith(".js") && !f.startsWith("chunk-"))
  .map((f) => join(workerSrc, f));
const workersOpts = {
  entryPoints: workerEntries,
  bundle: true,
  format: "esm",
  outdir: join(dist, "cesium/WorkersBundled"),
  // Minified: this is vendored generated code that nobody steps through, and each file inlines the
  // shared chunks, so the tree is several times the size of the one it is built from.
  minify: true,
  logLevel: "error",
};

// The chunk is named by content, and only a full build clears `dist/` first, so a long watch leaves
// the chunk of every rebuild behind. They are dead files, not wrong ones — each page names the one
// it was built with — but a tree meant for a release wants a full build.
if (watch) {
  const ctxs = await Promise.all(entries.map((opts) => esbuild.context(opts)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("esbuild watching…");
} else {
  await Promise.all(entries.map((opts) => esbuild.build(opts)));
}

// After the entries, because it reads the Cesium tree the copy above puts in place. Not watched:
// the sources are vendored and do not change between builds.
await esbuild.build(workersOpts);
console.log(`bundled ${workerEntries.length} Cesium workers for the VSCode host`);
