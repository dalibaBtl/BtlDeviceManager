#!/usr/bin/env node
// Launcher: starts the local server detached in the background, prints its URL
// and opens the UI as a chromeless browser app window. The terminal is free
// again immediately; the server exits on its own after the last window closes.
//
// Flags:
//   --no-open      start the server only and print the URL
//   --keep-alive   do not exit when the last window closes
//   --foreground   run the server in this process (logs to the terminal); used by the
//                  background child, handy for debugging
//   --port <n>     fixed port (default: a free one)
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { startServer, cacheDir } = await import(path.join(here, '..', 'dist', 'server.js'));
const { ensureDesktopEntry } = await import(
  path.join(here, '..', 'scripts', 'install-desktop.mjs')
);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(value('--port') ?? 0);

if (flag('--foreground')) {
  await runServer();
} else {
  // Self-service: the first start registers the app with the launcher (Mod+D),
  // and a moved clone or a new Node re-registers it. Cheap and idempotent.
  if (ensureDesktopEntry() === 'wrote')
    console.error('registered BTL Manager with the app launcher');
  detach();
}

/** Runs the server in this process, prints the URL and opens the window. */
async function runServer() {
  const server = await startServer({
    port,
    keepAlive: flag('--keep-alive') || flag('--no-open'),
    webDir: path.join(here, '..', 'dist', 'web'),
  });
  console.log(server.url);
  if (!flag('--no-open')) openAppWindow(server.url);
}

/**
 * Re-runs this script as a detached background process, waits for it to print
 * the URL, echoes it and exits. The child's output goes to a log file in the
 * cache dir, so nothing is tied to this terminal and a launcher (`.desktop`
 * entry, Mod+D) never needs a console window.
 */
function detach() {
  mkdirSync(cacheDir(), { recursive: true });
  const log = openSync(path.join(cacheDir(), 'server.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--foreground', ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', log],
  });
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    const nl = buffered.indexOf('\n');
    if (nl < 0) return;
    process.stdout.write(buffered.slice(0, nl + 1));
    // The child prints only the URL to stdout; later diagnostics go to stderr (the log file).
    child.stdout.destroy();
    child.unref();
    process.exit(0);
  });
  child.on('exit', (code) => {
    console.error(
      `server exited early with code ${code}; see ${path.join(cacheDir(), 'server.log')}`,
    );
    process.exit(code ?? 1);
  });
}

/**
 * Opens the URL in a Chromium-family browser's app mode when one is available,
 * because that yields a plain window with no tabs or address bar, which tiles
 * cleanly in sway. A dedicated profile keeps it a separate process from the
 * user's browsing session, so closing the app never touches it, and
 * extensions are not loaded, which keeps memory low. Falls back to xdg-open.
 */
function openAppWindow(url) {
  const profile = path.join(cacheDir(), 'browser-profile');
  mkdirSync(profile, { recursive: true });
  const chromeArgs = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    '--class=btl-manager',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1200,800',
  ];
  const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  tryNext(0);

  function tryNext(i) {
    if (i >= candidates.length) {
      fallback();
      return;
    }
    const child = spawn(candidates[i], chromeArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => tryNext(i + 1));
    child.on('spawn', () => child.unref());
  }

  function fallback() {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.error(`open this URL manually: ${url}`));
    child.unref();
  }
}
