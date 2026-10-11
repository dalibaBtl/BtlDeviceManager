import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { validateLayout } from '../displays/config.js';
import type {
  ClientMessage,
  DisplayLayout,
  DisplayOutput,
  Printer,
  ServerMessage,
  TerminalAction,
} from '../shared/types.js';
import { CliSource, parseList, runCli, watchCups, watchSwayOutputs } from './cli-source.js';
import {
  cacheDir,
  displaysCliPath,
  layoutsDir,
  printersCliPath,
  printersCommand,
} from './paths.js';
import { Terminal, shellQuote } from './terminal.js';

/** Options accepted by {@link startServer}. */
export interface ServerOptions {
  /** Port to listen on; `0` picks a free one. */
  port: number;
  /** Keep running when the last browser window disconnects. */
  keepAlive: boolean;
  /** Directory of the built front-end (`index.html`, `main.js`, `main.css`). */
  webDir: string;
}

/** What a started server exposes to the launcher. */
export interface RunningServer {
  url: string;
  close(): void;
}

/** Milliseconds between background rescans; printers wake up and fall asleep on their own. */
const REFRESH_INTERVAL = 60_000;
/** Grace period before exiting once the last client is gone. */
const IDLE_EXIT_MS = 10_000;

/**
 * Starts the local HTTP + WebSocket server.
 *
 * Binds to `127.0.0.1` only and requires a per-launch random token on every
 * request, so other local web pages cannot drive it. The token holder can run
 * shell commands through the terminal, which is the same trust model as a
 * local IDE. State lives in memory and is replayed to each new client.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = randomBytes(24).toString('base64url');
  const app = new App({
    printersCli: printersCliPath(),
    printersCommand: printersCommand(),
    displaysCli: displaysCliPath(),
  });
  const server = http.createServer((req, res) => {
    handleHttp(app, token, opts.webDir, req, res).catch((e: unknown) => {
      sendJson(res, 500, { error: errorText(e) });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('t') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => app.attach(ws));
  });

  let idleTimer: NodeJS.Timeout | null = null;
  app.onClientCountChange = (n) => {
    if (opts.keepAlive) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (n === 0) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  app.start();
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () => {
      app.stop();
      wss.close();
      server.close();
    },
  };
}

/** Per-connection state. */
interface Client {
  ws: WebSocket;
  terminal: Terminal | null;
}

/** Snapshot of one feature's list as pushed to clients. */
interface Listing<T> {
  items: T[];
  scannedAt: number | null;
  error: string | null;
}

/** Which CLIs the server drives, and how the printers one is spelled in the terminal. */
interface AppPaths {
  printersCli: string;
  /** `btl-printers` or the absolute script path; see {@link printersCommand}. */
  printersCommand: string;
  displaysCli: string;
}

/**
 * In-memory model shared by all clients: the printer and display lists and
 * the background jobs that refresh them. Everything that changes the system
 * goes through {@link buildSteps} into the client's terminal, never through
 * this class.
 */
class App {
  private clients = new Set<Client>();
  private printers: Listing<Printer> = { items: [], scannedAt: null, error: null };
  private displays: Listing<DisplayOutput> = { items: [], scannedAt: null, error: null };
  private scanning = false;
  private readonly printerSource: CliSource<Printer>;
  private readonly displaySource: CliSource<DisplayOutput>;
  private refreshTimer: NodeJS.Timeout | null = null;

  onClientCountChange: (n: number) => void = () => undefined;

  constructor(private readonly paths: AppPaths) {
    this.printerSource = new CliSource(
      paths.printersCli,
      parseList('printers', (v): v is Printer => typeof (v as Printer)?.id === 'string'),
    );
    this.printerSource.onUpdate = (items, scannedAt, error) => {
      this.printers = { items, scannedAt, error };
      this.broadcast({ type: 'printers', ...this.printers });
    };
    this.printerSource.onScanning = (on) => this.setScanning(on);

    this.displaySource = new CliSource(
      paths.displaysCli,
      parseList(
        'outputs',
        (v): v is DisplayOutput => typeof (v as DisplayOutput)?.identifier === 'string',
      ),
    );
    this.displaySource.onUpdate = (items, scannedAt, error) => {
      this.displays = { items, scannedAt, error };
      this.broadcast({ type: 'displays', ...this.displays });
    };
  }

  /** Only the printer scan is slow enough to show; display reads take milliseconds. */
  private setScanning(on: boolean): void {
    this.scanning = on;
    this.broadcast({ type: 'scanning', scanning: on });
  }

  start(): void {
    void this.printerSource.refresh();
    void this.displaySource.refresh();
    this.printerSource.watch(watchCups);
    this.displaySource.watch(watchSwayOutputs);
    this.refreshTimer = setInterval(() => void this.printerSource.refresh(), REFRESH_INTERVAL);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.printerSource.stop();
    this.displaySource.stop();
    for (const c of this.clients) {
      c.terminal?.kill();
      c.ws.close();
    }
  }

  refreshPrinters(): Promise<void> {
    return this.printerSource.refresh();
  }

  refreshDisplays(): Promise<void> {
    return this.displaySource.refresh();
  }

  printersSnapshot(): Listing<Printer> {
    return this.printers;
  }

  displaysSnapshot(): Listing<DisplayOutput> {
    return this.displays;
  }

  /**
   * Checks a layout against the current outputs, stores it for the CLI and
   * returns what `apply` would write next to what is there now, so the user
   * confirms a visible diff rather than a blind overwrite.
   */
  async prepareLayout(
    layout: DisplayLayout,
  ): Promise<{ file: string; preview: string; current: string }> {
    const problems = validateLayout(layout, this.displays.items);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    await mkdir(layoutsDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const file = path.join(layoutsDir(), `layout-${stamp}.json`);
    await writeFile(file, JSON.stringify(layout, null, 2) + '\n', 'utf8');
    const [preview, current] = await Promise.all([
      runCli(this.paths.displaysCli, ['preview', file]),
      runCli(this.paths.displaysCli, ['config']),
    ]);
    return { file, preview, current };
  }

  /**
   * Moves a workspace to another output right away. A direct call, not a
   * terminal line: it needs no root, fails only with a one-line reason, and
   * the drag that triggers it would otherwise fill the terminal with noise.
   * Both names must come from the current listing.
   */
  async moveWorkspace(name: string, identifier: string): Promise<void> {
    const target = this.displays.items.find((o) => o.identifier === identifier);
    if (!target) throw new Error('unknown output; refresh and try again');
    if (!this.displays.items.some((o) => o.workspaces.some((w) => w.name === name))) {
      throw new Error(`no workspace called ${name}`);
    }
    await runCli(this.paths.displaysCli, ['move-workspace', name, identifier]);
    await this.displaySource.refresh();
  }

  // ---- clients -------------------------------------------------------------

  attach(ws: WebSocket): void {
    const client: Client = { ws, terminal: null };
    this.clients.add(client);
    this.onClientCountChange(this.clients.size);
    this.send(client, { type: 'printers', ...this.printers });
    this.send(client, { type: 'displays', ...this.displays });
    this.send(client, { type: 'scanning', scanning: this.scanning });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      try {
        this.handleClientMessage(client, msg);
      } catch (e) {
        this.send(client, { type: 'notice', level: 'error', text: errorText(e) });
      }
    });
    ws.on('close', () => {
      client.terminal?.kill();
      this.clients.delete(client);
      this.onClientCountChange(this.clients.size);
    });
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients) this.send(c, msg);
  }

  private handleClientMessage(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'term-open':
        client.terminal?.kill();
        client.terminal = new Terminal(
          homedir(),
          msg.cols,
          msg.rows,
          (data) => this.send(client, { type: 'term-data', data }),
          (code) => {
            client.terminal = null;
            this.send(client, { type: 'term-exit', code });
          },
        );
        break;
      case 'term-input':
        client.terminal?.write(msg.data);
        break;
      case 'term-resize':
        client.terminal?.resize(msg.cols, msg.rows);
        break;
      case 'term-run':
        if (!client.terminal) throw new Error('terminal is not open');
        client.terminal.runChain(
          buildSteps(msg.run, this.printers.items, {
            printers: this.paths.printersCommand,
            displays: this.paths.displaysCli,
            layouts: layoutsDir(),
          }),
        );
        break;
    }
  }
}

/** How the CLIs are spelled in the terminal and where layout files may come from. */
export interface StepContext {
  printers: string;
  displays: string;
  layouts: string;
}

/**
 * Translates a terminal action into the shell line the user will see. A
 * printer id must come from the current list and a layout file from the
 * server's own directory, so the terminal only ever runs the CLIs on something
 * the server has produced or reported, never on client-supplied text.
 */
export function buildSteps(run: TerminalAction, known: Printer[], ctx: StepContext): string[] {
  if (run.action === 'display-apply') {
    const file = path.resolve(run.file);
    if (path.dirname(file) !== path.resolve(ctx.layouts) || !existsSync(file)) {
      throw new Error('layout was not prepared by this server');
    }
    return [`${ctx.displays} apply ${shellQuote(file)}`];
  }
  const printer = known.find((p) => p.id === run.id);
  if (!printer) throw new Error('unknown printer; refresh the list and try again');
  const id = shellQuote(printer.id);
  const cli = ctx.printers;
  switch (run.action) {
    case 'printer-add':
      if (printer.queue) throw new Error(`${printer.name} already has a queue`);
      if (!printer.discovered) throw new Error(`${printer.name} is not seen on the network`);
      return [`sudo ${cli} add ${id}`];
    case 'printer-default':
      requireQueue(printer);
      return [`sudo ${cli} default ${id}`];
    case 'printer-remove':
      requireQueue(printer);
      return [`sudo ${cli} remove ${id}`];
    case 'printer-test':
      requireQueue(printer);
      return [`${cli} test ${id}`];
  }
}

function requireQueue(printer: Printer): void {
  if (!printer.queue) throw new Error(`${printer.name} has no queue yet`);
}

// ---- HTTP ------------------------------------------------------------------

async function handleHttp(
  app: App,
  token: string,
  webDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) {
    serveStatic(webDir, url.pathname, res);
    return;
  }
  if (url.searchParams.get('t') !== token && req.headers['x-btldm-token'] !== token) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/printers':
      sendJson(res, 200, app.printersSnapshot());
      return;
    case 'POST /api/printers/refresh':
      await app.refreshPrinters();
      sendJson(res, 200, app.printersSnapshot());
      return;
    case 'GET /api/displays':
      sendJson(res, 200, app.displaysSnapshot());
      return;
    case 'POST /api/displays/refresh':
      await app.refreshDisplays();
      sendJson(res, 200, app.displaysSnapshot());
      return;
    case 'POST /api/displays/move-workspace': {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || typeof body.identifier !== 'string') {
        throw new Error('missing name or identifier');
      }
      await app.moveWorkspace(body.name, body.identifier);
      sendJson(res, 200, app.displaysSnapshot());
      return;
    }
    case 'POST /api/displays/prepare': {
      const body = await readJson(req);
      sendJson(res, 200, await app.prepareLayout(body.layout as DisplayLayout));
      return;
    }
    default:
      sendJson(res, 404, { error: 'not found' });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
        );
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { cacheDir } from './paths.js';

/** Running as a script (not imported by the launcher): start on a fixed port and print the URL. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'web');
  startServer({ port: Number(process.env.PORT ?? 0), keepAlive: true, webDir }).then((s) => {
    console.log(s.url);
  });
}
