// Minimal static server for dist/ (dev only). Node's own http, and no dependency.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// SERVE_ROOT names another directory to serve, relative to this file. `tools/zoom-check.mjs` passes
// `..` to serve the repository root: it loads the built page and a fixture pyramid that the build
// does not hold, and one origin is what keeps the browser from calling those tiles cross-origin.
const served = join(root, process.env.SERVE_ROOT ?? "dist");
const port = Number(process.env.PORT) || 5173;
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".wasm": "application/wasm", ".xml": "application/xml",
  ".map": "application/json",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = join(served, normalize(path));
  if (!file.startsWith(served)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`serving ${served} on http://localhost:${port}`));
