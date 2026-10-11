import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, Printer, ServerMessage, TerminalAction } from '../shared/types.js';
import { cacheDir, printersCliPath, printersCommand } from './paths.js';
import { PrinterSource } from './printers.js';
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
  const app = new App(printersCliPath(), printersCommand());
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

/**
 * In-memory model shared by all clients: the printer list and the background
 * jobs that refresh it. Everything that changes the system goes through
 * {@link buildSteps} into the client's terminal, never through this class.
 */
class App {
  private clients = new Set<Client>();
  private printers: Printer[] = [];
  private scannedAt: number | null = null;
  private error: string | null = null;
  private scanning = false;
  private readonly source: PrinterSource;
  private refreshTimer: NodeJS.Timeout | null = null;

  onClientCountChange: (n: number) => void = () => undefined;

  constructor(
    cliPath: string,
    private readonly cliCommand: string,
  ) {
    this.source = new PrinterSource(cliPath);
    this.source.onUpdate = (items, scannedAt, error) => {
      this.printers = items;
      this.scannedAt = scannedAt;
      this.error = error;
      this.broadcast(this.printersMessage());
    };
    this.source.onScanning = (scanning) => {
      this.scanning = scanning;
      this.broadcast({ type: 'scanning', scanning });
    };
  }

  start(): void {
    void this.source.refresh();
    this.source.startWatching();
    this.refreshTimer = setInterval(() => void this.source.refresh(), REFRESH_INTERVAL);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.source.stop();
    for (const c of this.clients) {
      c.terminal?.kill();
      c.ws.close();
    }
  }

  refresh(): Promise<void> {
    return this.source.refresh();
  }

  snapshot(): { items: Printer[]; scannedAt: number | null; error: string | null } {
    return { items: this.printers, scannedAt: this.scannedAt, error: this.error };
  }

  private printersMessage(): ServerMessage {
    return { type: 'printers', ...this.snapshot() };
  }

  // ---- clients -------------------------------------------------------------

  attach(ws: WebSocket): void {
    const client: Client = { ws, terminal: null };
    this.clients.add(client);
    this.onClientCountChange(this.clients.size);
    this.send(client, this.printersMessage());
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
        client.terminal.runChain(buildSteps(msg.run, this.printers, this.cliCommand));
        break;
    }
  }
}

/**
 * Translates a terminal action into the shell line the user will see. The
 * printer id must come from the current list, so the terminal only ever runs
 * the CLI on something the server has reported, never on client-supplied text.
 */
export function buildSteps(run: TerminalAction, known: Printer[], cli: string): string[] {
  const printer = known.find((p) => p.id === run.id);
  if (!printer) throw new Error('unknown printer; refresh the list and try again');
  const id = shellQuote(printer.id);
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
  if (url.searchParams.get('t') !== token && req.headers['x-btlm-token'] !== token) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/printers':
      sendJson(res, 200, app.snapshot());
      return;
    case 'POST /api/printers/refresh':
      await app.refresh();
      sendJson(res, 200, app.snapshot());
      return;
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
