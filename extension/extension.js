// The CesiumLink extension: one webview panel, one relayed WebSocket, one picker.
//
// The extension holds the socket, and the page does not. Two things follow. A workspace extension
// runs beside the Julia process and reaches it over localhost, so no port needs a forward, and a
// scene on a fresh ephemeral port needs no new one. And the page reaches the socket through the
// webview channel, which is the transport the VSCode host builds on.
//
// The extension relays bytes and never reads the wire, so it carries no version of its own. The
// page, the modules and `vscode.js` all come out of the tree the server records, so that tree
// decides what the protocol is. The one contract here is the layout of the tree: it holds
// `vscode.js`, `vscode.css`, `cesium/`, `modules/`, and the `chunk-<hash>.js` that `vscode.js`
// imports. The chunk is named by content, so copy the tree rather than a list of names.
//
// Install a rebuilt VSIX with `--force`. VSCode skips an install of a version it already holds and
// says nothing, and the version here does not move for every edit, so without the flag the editor
// keeps running the old file. Install from inside a Remote-SSH window: `code --install-extension`
// writes `~/.vscode/extensions`, and a remote window reads `~/.vscode-server/extensions`.

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { scenePort } = require('./uri.js');

// Every failure inside a webview reads as an empty globe, and nothing in one reaches a terminal.
// So the socket lifecycle and everything the page reports go to one channel the reader can open.
let log;

function activate(context) {
  log = vscode.window.createOutputChannel('CesiumLink');
  context.subscriptions.push(log);
  announce(context);
  context.subscriptions.push(vscode.commands.registerCommand(
    'cesiumLink.pickScene', () => pickScene(context)));
  context.subscriptions.push(vscode.window.registerUriHandler(
    { handleUri: (uri) => openPushed(context, uri) }));
}

// Which build this window is running, written before anything else can happen.
//
// The version does not move for every edit, and VSCode loads an extension once and keeps it — so a
// window whose host started before an install is still running the older file, with the same version
// number and the newer file sitting on disk beside it. The install time is what tells two builds of
// one version apart, and it is the answer to "am I looking at the code I just installed".
// It reports and never decides: a line about the build must not be what stops the extension loading.
function announce(context) {
  try {
    const entry = path.join(context.extensionPath, 'extension.js');
    const installed = fs.statSync(entry).mtime.toISOString();
    log.appendLine(`CesiumLink ${context.extension.packageJSON.version}, installed ${installed}`);
    log.appendLine(`  running ${entry}`);
  } catch (e) {
    log.appendLine(`could not read this extension's own build: ${e.message}`);
  }
}

// --- the push -------------------------------------------------------------------------------

// A scene that starts in an editor terminal announces itself once, and this answers. The server
// writes its discovery file before it pushes, so the port always names a file this can read.
async function openPushed(context, uri) {
  const port = scenePort(uri.path);
  if (port === null) {
    log.appendLine(`no port in ${uri}`);
    return;
  }
  const picked = (await liveScenes()).find((s) => s.port === port);
  if (!picked) {
    // Never fall back to the picker. A push that names a port nobody serves must not open a
    // different scene, which the reader would take for the one they started.
    const where = discoveryDir();
    vscode.window.showErrorMessage(`CesiumLink: no scene runs on port ${port}. Looked in ${where}.`);
    log.appendLine(`no scene on port ${port} in ${where}`);
    return;
  }
  open(context, picked);
}

// --- the picker ---------------------------------------------------------------------------

// The server resolves this directory the same way, and the two must agree.
function discoveryDir() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, 'cesiumlink');
  const localApp = process.platform === 'win32' ? process.env.LOCALAPPDATA : '';
  if (localApp) return path.join(localApp, 'cesiumlink');
  return path.join(os.homedir(), '.cache', 'cesiumlink');
}

// Nothing removes the file of a server that stopped, so the reader asks whether the process still
// runs. Signal 0 sends no signal. `EPERM` reports a process of that id under another user, which
// this reader can neither use nor prove stale, so it stays in the list.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A process that still runs is no proof that the server inside it runs: a REPL reset takes the
// server away and leaves the process, and the two look identical on disk. Only the port tells them
// apart, so ask it. One connection, no bytes — a port that accepts has answered. `localhost` is the
// address the relay dials, so a port this cannot reach is one the panel could not have used either.
const PROBE_TIMEOUT_MS = 500;

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

// The picker waits for every probe before it draws a row. They run at once, so the wait is one
// timeout however many stale files there are — and the list stands still under the pointer, which
// rows that appear and are then taken back would not.
async function liveScenes() {
  const dir = discoveryDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    log.appendLine(`no scenes: ${e.message}`);
    return [];
  }
  // `isRunning` first: it costs nothing and it drops most stale files before any socket work.
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (isRunning(s.pid)) candidates.push(scene(s));
    } catch (e) {
      log.appendLine(`skipped ${name}: ${e.message}`);
    }
  }
  const answered = await Promise.all(candidates.map((s) => answers(s.port)));
  for (const [i, s] of candidates.entries()) {
    if (!answered[i]) log.appendLine(`port ${s.port} answers nothing; its server stopped`);
  }
  return candidates.filter((_, i) => answered[i]);
}

// Titles collide by design: a server takes its title from the directory it starts in, so three
// scenes of one session are all called the same thing. The port and the start time tell them
// apart, which is why the detail line is not optional.
function scene(s) {
  return {
    label: s.title || 'CesiumLink',
    port: s.port,
    detail: `port ${s.port} — started ${s.started}`,
    url: `ws://localhost:${s.port}/ws`,
    dist: s.dist,
    imagery: s.imagery,
    // Every directory the server serves, by mount name; every registered module's own directory, by
    // module id; and every origin the page may reach. The panel needs all three before it is
    // created: a webview is given its resource roots and its policy then, and neither can be
    // changed afterwards without dropping the scene and the socket.
    assets: s.assets || {},
    modules: s.modules || {},
    trustedOrigins: s.trustedOrigins || [],
  };
}

const MANUAL = { label: '$(edit) Enter a host and port', detail: 'For a scene that writes no file' };
const STOP_BUTTON = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Stop this scene' };

// A row's button is drawn only by a quick pick this code builds and holds, which is why this is not
// `showQuickPick`. The picker stays open across a stop, and re-reads the directory afterwards.
//
// Every scene gets a row, including the only one: the button lives on the row, so a shortcut past
// the list would leave a lone scene with no way to stop it.
async function pickScene(context) {
  const picker = vscode.window.createQuickPick();
  picker.title = 'CesiumLink';
  // The confirmation is a modal, and a modal takes the focus a quick pick closes on. Without this
  // the picker is gone by the time the reader answers it. Escape still closes the picker.
  picker.ignoreFocusOut = true;
  // A stop asks first and then waits on a socket, so it can settle after the reader gave up on the
  // list. Every write below is to a picker that is disposed by then.
  let alive = true;
  const fill = async () => {
    if (!alive) return;
    picker.busy = true;
    const scenes = await liveScenes();
    if (!alive) return;
    picker.placeholder = scenes.length ? 'Pick a scene' : 'No scene of yours runs';
    picker.items = [...scenes.map((s) => ({ ...s, buttons: [STOP_BUTTON] })), MANUAL];
    picker.busy = false;
  };
  picker.onDidTriggerItemButton(async (ev) => {
    await stopScene(ev.item);
    await fill();
  });
  let picked = await new Promise((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
    fill();
  });
  alive = false;
  picker.dispose();
  if (picked === MANUAL) picked = await askForScene();
  if (picked) open(context, picked);
}

// Ask before a stop. It is not reversible, and the button sits on the row that opens the scene.
async function stopScene(item) {
  const stop = 'Stop the scene';
  const answer = await vscode.window.showWarningMessage(
    `Stop "${item.label}" on port ${item.port}?`, {
      modal: true,
      detail: 'The server stops and the scene goes. The Julia session that started it keeps running.',
    }, stop);
  if (answer !== stop) return;
  if (await askToStop(item.port)) {
    log.appendLine(`stopped the scene on port ${item.port}`);
    return;
  }
  const line = `the scene on port ${item.port} did not stop, and its file is still there`;
  log.appendLine(line);
  vscode.window.showErrorMessage(`CesiumLink: ${line}`);
}

// The stop is one frame, so it needs no WebSocket client of its own: the extension host provides
// the global one the relay already dials. Do not add `ws` to package.json for this.
//
// Send no `ready`. It makes the server declare its modules and replay the whole retained scene to a
// client that is about to close.
//
// A server that stops drops every client, so the socket closing under this one is the answer that
// the stop ran. Nothing else reports it: the message expects no reply.
//
// 10 s, and it covers the upgrade as well as the stop. A server that has never taken a WebSocket
// compiles that path on the first one, which measured 3.6 s to open and 4.6 s to the close. A port
// that nobody holds fails at once with an error and never waits for this.
const STOP_TIMEOUT_MS = 10000;

function askToStop(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const timer = setTimeout(() => { ws.close(); resolve(false); }, STOP_TIMEOUT_MS);
    const done = (ok) => { clearTimeout(timer); resolve(ok); };
    ws.addEventListener('open', () => ws.send(JSON.stringify(
      { method: 'event', params: { module: 'core', topic: 'stop', payload: {} } })));
    ws.addEventListener('close', () => done(true));
    ws.addEventListener('error', () => done(false));
  });
}

// A scene entered by hand names no basemap. The discovery file is what carries one, and this asks
// only for what a scene that writes no file cannot state.
async function askForScene() {
  const address = await vscode.window.showInputBox(
    { title: 'CesiumLink', prompt: 'Host and port of the scene', value: 'localhost:50004' });
  if (!address) return null;
  const setting = vscode.workspace.getConfiguration('cesiumLink').get('distDir');
  const dist = setting || await vscode.window.showInputBox(
    { title: 'CesiumLink', prompt: 'Path of the built viewer tree (dist)' });
  if (!dist) return null;
  return { label: address, url: `ws://${address}/ws`, dist };
}

// --- the panel ----------------------------------------------------------------------------

// The origin of a basemap the server declared as a URL, for the page's policy to name. A mounted
// pyramid is an entry in the `assets` map like any other, so only the URL case is read here.
function imageryOrigin(imagery) {
  if (!imagery || !/^https?:\/\//i.test(imagery)) return null;
  try {
    return new URL(imagery).origin;
  } catch (e) {
    log.appendLine(`no origin in the basemap URL ${imagery}: ${e.message}`);
    return null;
  }
}

// Every mount the panel can actually grant, as name to directory. A directory the extension host
// cannot see is dropped with a line rather than made a root: `createWebviewPanel` takes the roots it
// is given, and one that does not exist would fail later as a page that silently loads nothing.
function readableMounts(assets) {
  const mounts = {};
  for (const [name, dir] of Object.entries(assets)) {
    if (fs.existsSync(dir)) mounts[name] = dir;
    else log.appendLine(`the mount "${name}" names ${dir}, which is not on this filesystem`);
  }
  return mounts;
}

// What the panel may read, as mount name to directory: every directory the server serves, plus
// every registered module's own directory under `modules/<id>`.
//
// A module ships from its own package, so its directory is no more under the dist than an assets
// mount is. Granting it is what makes a third-party module run in the panel at all. The prefix
// cannot collide with an assets mount name, which is one path element and holds no `/`.
function sceneMounts(picked) {
  const named = { ...picked.assets };
  for (const [id, dir] of Object.entries(picked.modules)) named[`modules/${id}`] = dir;
  return readableMounts(named);
}

function open(context, picked) {
  const entry = path.join(picked.dist, 'vscode.js');
  if (!fs.existsSync(entry)) {
    // The extension host and the Julia process must share a filesystem. The page comes off the
    // disk and nothing falls back to HTTP, so a server on a third machine ends here.
    vscode.window.showErrorMessage(
      `CesiumLink: ${entry} does not exist. Build the viewer, or run the scene on this machine.`);
    log.appendLine(`no viewer at ${entry}`);
    return;
  }
  const mounts = sceneMounts(picked);
  // Each mount sits wherever the user put it, so each is a root of its own and not a path under
  // the dist.
  const roots = [vscode.Uri.file(picked.dist),
                 ...Object.values(mounts).map((dir) => vscode.Uri.file(dir))];
  const origins = [...picked.trustedOrigins];
  const declared = imageryOrigin(picked.imagery);
  if (declared && !origins.includes(declared)) origins.push(declared);
  const panel = vscode.window.createWebviewPanel(
    'cesiumLink', picked.label, vscode.ViewColumn.Active, {
      enableScripts: true,
      // Without this a hidden tab is torn down and rebuilt, which drops the scene and the socket.
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    });
  const uriOf = (p) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString() + '/';
  const bases = {};
  for (const [name, dir] of Object.entries(mounts)) bases[name] = uriOf(dir);
  panel.webview.html = pageHtml(panel.webview, uriOf(picked.dist), bases, origins);
  relay(context, panel, picked);
}

// A module the page cannot reach, because it was registered after this panel was created. The roots
// and the policy of a webview are fixed when it is created, so no message can grant the directory
// to the page that is running: the panel has to be built again from a freshly read discovery file.
//
// A scene installs its modules right after `start_server` returns, and the push that opens this
// panel goes out before that — so the panel routinely opens one moment too early, and this is what
// carries it over. Once per panel: a module that fails for any other reason must not loop.
async function reopenForModule(context, panel, picked, id) {
  const fresh = (await liveScenes()).find((s) => s.port === picked.port);
  const dir = fresh && fresh.modules[id];
  // The same test the mounts are built from. A directory the file names and this host cannot see
  // would be dropped from the roots again, and the panel it opened would ask for the same reopen.
  if (!dir || !fs.existsSync(dir)) {
    log.appendLine(`module ${id} names no directory this host can read; the panel stays as it is`);
    return;
  }
  log.appendLine(`module ${id} was registered after this panel opened; opening the scene again`);
  panel.dispose();
  open(context, fresh);
}

function relay(context, panel, picked) {
  const url = picked.url;
  // A webview drops a message posted before the page attaches its listener, and this page carries
  // the whole of Cesium. The socket opens long before the parse ends. So nothing goes down until
  // the page says hello. Without the hold the page waits for a socket it never hears about, and
  // the server waits for a `ready` that therefore never comes.
  let listening = false;
  // One reopen for a module this panel cannot reach, and no more.
  let reopened = false;
  const held = [];
  const toPage = (m) => {
    if (listening) panel.webview.postMessage(m);
    else held.push(m);
  };
  const closed = (reason) => {
    log.appendLine(`closed ${url}: ${reason}`);
    toPage({ type: 'closed', reason });
  };

  // A page that never says hello holds every message for as long as the panel is open, and says
  // nothing: it paints black, the socket stays healthy, and no line anywhere reports it. Every
  // cause reads the same from here — a CSP refusal, a bundle the host cannot parse, a worker shim
  // that failed, an extension older than the tree it serves — so this states what is known and
  // guesses no cause. The hold stays: a late hello is still honoured.
  //
  // 20 s. The whole of Cesium parses before the page can speak, and the channel costs about 60 ms
  // a message, so ten seconds is too tight on a cold start. A minute is longer than a reader waits
  // before they decide the panel is broken.
  const HELLO_TIMEOUT_MS = 20000;
  const silent = setTimeout(() => {
    const line = `the page has not started after ${HELLO_TIMEOUT_MS / 1000} s — it may need a newer`
      + ' extension, or its bundle failed to load. Open the webview developer tools to see why.';
    log.appendLine(line);
    vscode.window.showWarningMessage(`CesiumLink: ${line}`);
  }, HELLO_TIMEOUT_MS);

  log.appendLine(`dialled ${url}`);
  // Node in the extension host has a global WebSocket, so the relay needs no dependency. That global
  // sets the `engines.vscode` floor in package.json: Node has it unflagged from 22.4, and VSCode
  // reaches Node 22 at 1.102.
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    log.appendLine(`open ${url}`);
    toPage({ type: 'open' });
  });
  socket.addEventListener('message', (ev) => {
    // Bytes stay bytes across this channel: it uses structured clone, not JSON.
    toPage({ type: 'frame', payload: new Uint8Array(ev.data) });
  });
  socket.addEventListener('close', (ev) => closed(ev.reason || `code ${ev.code}`));
  socket.addEventListener('error', () => closed(`could not reach ${url}`));

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'hello') {
      clearTimeout(silent);
      listening = true;
      for (const m of held) panel.webview.postMessage(m);
      held.length = 0;
    } else if (msg.type === 'frame') {
      if (socket.readyState === WebSocket.OPEN) socket.send(msg.payload);
    } else if (msg.type === 'close') {
      socket.close();
    } else if (msg.type === 'log') {
      log.appendLine(msg.line);
    } else if (msg.type === 'moduleMissing') {
      if (reopened) log.appendLine(`module ${msg.id} is still missing after one reopen`);
      else { reopened = true; reopenForModule(context, panel, picked, msg.id); }
    } else if (msg.type === 'expand') {
      expandPanel();
    }
  }, null, context.subscriptions);

  // This closes the socket and stops no server. The scene belongs to the user's REPL. A panel the
  // reader closes before the page starts is not a failure, so the timer goes with it.
  panel.onDidDispose(() => {
    clearTimeout(silent);
    socket.close();
  }, null, context.subscriptions);
}

// The panel's own full-screen button. A webview has no fullscreen API, so the page asks for this
// instead, and Zen Mode is the nearest thing the editor has: one editor group, no bars, and the
// window itself full screen. It toggles, so the same button leaves it again.
//
// Zen Mode alone is not enough, and neither gap is fixed by a toggle:
//
// - it centres the editor unless `zenMode.centerLayout` says otherwise, which leaves the globe in a
//   narrow column between two empty margins. The centring lands after the command that starts Zen
//   Mode has returned, so a toggle sent afterwards fights a layout still on its way and the reader
//   watches it move. Turning the setting off first means Zen Mode never centres at all;
// - it keeps every editor group, so a split leaves the globe with part of the width. Maximizing the
//   panel's own group hides the others, and leaving Zen Mode does not bring them back, so this puts
//   them back itself.
//
// Two flags that follow this button's own clicks, not the editor's real state — VSCode
// publishes neither, and the reader's `centerLayout` stays off for as long as the flag says Zen
// Mode is on. A reader who leaves Zen Mode another way puts them out of step, and the next click
// puts them back.
let zen = false;
let maximized = false;
// The reader's own `zenMode.centerLayout`, held while Zen Mode is on. `undefined` is a real value
// here: it stands for a settings file with no entry, which `update` restores by removing ours.
let centring;

const CENTRE_LAYOUT = 'centerLayout';
const zenConfig = () => vscode.workspace.getConfiguration('zenMode');

// A command this asks for may not exist in the reader's VSCode, and a rejected `executeCommand` in
// an event handler goes nowhere. So every step says what it did, in the channel the reader already
// opens for this extension, and a failed step never takes the steps after it down with it.
async function run(id) {
  try {
    await vscode.commands.executeCommand(id);
    log.appendLine(`expand: ${id} ok`);
    return true;
  } catch (e) {
    log.appendLine(`expand: ${id} FAILED — ${e.message}`);
    return false;
  }
}

async function expandPanel() {
  if (zen) {
    // The toggle is safe here, where the group is maximized because the entry below maximized it.
    if (maximized) {
      await run('workbench.action.toggleMaximizeEditorGroup');
      maximized = false;
    }
    await run('workbench.action.toggleZenMode');
    await zenConfig().update(CENTRE_LAYOUT, centring, vscode.ConfigurationTarget.Global);
    zen = false;
    log.appendLine(`expand: left Zen Mode, centerLayout back to ${centring}`);
    return;
  }
  centring = zenConfig().inspect(CENTRE_LAYOUT).globalValue;
  await zenConfig().update(CENTRE_LAYOUT, false, vscode.ConfigurationTarget.Global);
  await run('workbench.action.toggleZenMode');
  zen = true;
  const groups = vscode.window.tabGroups.all.length;
  log.appendLine(`expand: entered Zen Mode — ${groups} editor group(s), centerLayout was ${centring}`);
  if (groups > 1) {
    // The only maximize command is a toggle, and a group the reader already maximized still counts
    // as two groups here, so the toggle alone would un-maximize it. Nothing in the API reports the
    // maximized state either. So make the state known instead of reading it: even sizes clear the
    // maximize whether or not one was on, and the toggle then always maximizes.
    //
    // This forgets a split the reader had sized by hand — it comes back even. Drop the
    // reset if VSCode ever publishes the maximized state.
    await run('workbench.action.evenEditorWidths');
    maximized = await run('workbench.action.toggleMaximizeEditorGroup');
  }
}

// A value for a `<script>` block of the page below. `<` is escaped because a `</script>` anywhere in
// it — a directory named for one, however unlikely — would end the block early and leave the rest of
// the page as text.
function inlineJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function pageHtml(webview, assetBase, mountBases, trustedOrigins) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const offsite = trustedOrigins.length ? ' ' + trustedOrigins.join(' ') : '';
  const csp = [
    "default-src 'none'",
    // The tail of these two is every origin the session declared as trusted, and those only. It is
    // empty for a scene that names none, which is every scene whose files the extension serves off
    // the disk.
    //
    // An off-site tile needs BOTH directives. Cesium asks for one with `preferBlob`, which fetches
    // the bytes and makes an `ImageBitmap` of them, so the request is a connection and not an image
    // load; the image directive covers the paths that fall back to an `<img>` element. One list
    // feeding two directives is forced by that, not a convenience.
    `img-src ${webview.cspSource} blob: data:${offsite}`,
    // Keep 'unsafe-eval'. The clock furniture comes from @cesium/widgets, which bundles Knockout,
    // and Knockout does an indirect (0,eval)("this") as it loads. Without it the widgets throw,
    // the viewer never attaches its transport, and the failure reads as an empty globe rather
    // than as an error. To drop it is to drop those widgets.
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // blob: is the shimmed workers; the shim reads their source from cspSource first.
    `worker-src blob: ${webview.cspSource}`,
    `connect-src ${webview.cspSource} blob: data:${offsite}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  // The host bundle is a module: it imports a chunk it shares with the two web hosts. The nonce
  // authorises the entry tag only. The chunk carries no nonce and is authorised by the
  // webview.cspSource entry of script-src, since it comes off the same asset base.
  //
  // Warning: write no backtick and no dollar-brace into the template below except a value this
  // function means to substitute. Both end the template early, and the failure is a SyntaxError at
  // load that stops the extension from activating at all.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>CesiumLink</title>
  <link rel="stylesheet" href="${assetBase}vscode.css" />
  <style>
    /* VSCode pads the body of a webview. Reset it, or the canvas sits shifted right. */
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #000; }
    #app { position: absolute; inset: 0; }
  </style>
  <script nonce="${nonce}">
    globalThis.CESIUM_LINK_ASSET_BASE = "${assetBase}";
    globalThis.CESIUM_BASE_URL = "${assetBase}cesium/";
    globalThis.CESIUM_LINK_MOUNTS = ${inlineJson(mountBases)};
  </script>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${assetBase}vscode.js"></script>
</body>
</html>`;
}

// VSCode reads `activate` and `deactivate`. The rest is exported for `extension.test.mjs`: what the
// panel is given is fixed when it is created, so it is worth checking without an editor to run in.
module.exports = {
  activate, deactivate: () => {}, imageryOrigin, readableMounts, sceneMounts, pageHtml,
};
