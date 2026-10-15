import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { validateLayout } from '../displays/config.js';
import { MAX_IMAGE_BYTES, isColor, isFit } from '../wallpaper/config.js';
import type {
  ClientMessage,
  DisplayLayout,
  DisplayOutput,
  FailedUnit,
  KeyboardState,
  PerfSample,
  Printer,
  ServerMessage,
  SystemStatus,
  TerminalAction,
  UpdateState,
  VirtualMachine,
  VmSettings,
  VmStats,
  WallpaperState,
  WatchTopic,
} from '../shared/types.js';
import { checkUpdate, printCheck, runUpdate } from '../update/cli.js';
import { isDown, isUp } from '../vm/virsh.js';
import {
  CliSource,
  LiveSource,
  parseKeyboard,
  parseList,
  parseStatus,
  parseWallpaper,
  runCli,
  watchCups,
  watchDist,
  watchNetwork,
  watchSwayInputs,
  watchSwayOutputs,
  watchVirshEvents,
  type ListResult,
} from './cli-source.js';
import {
  appCommand,
  cacheDir,
  displaysCliPath,
  keyboardCliPath,
  layoutsDir,
  printersCliPath,
  printersCommand,
  repoRoot,
  statusCliPath,
  uploadsDir,
  vmCliPath,
  wallpaperCliPath,
} from './paths.js';

/** The launcher's `update` subcommand lives in this bundle too; one build, one import. */
export { checkUpdate, printCheck, runUpdate, repoRoot };
import { Terminal, shellQuote } from './terminal.js';

/** Options accepted by {@link startServer}. */
export interface ServerOptions {
  /** Port to listen on; `0` picks a free one. */
  port: number;
  /** Keep running when the last browser window disconnects. */
  keepAlive: boolean;
  /** Directory of the built front-end (`index.html`, `main.js`, `main.css`). */
  webDir: string;
  /**
   * Token to accept instead of a fresh random one. Only an in-place restart
   * passes it (through the environment, never argv), so the windows that hold
   * the old URL reconnect to the new process.
   */
  token?: string;
}

/** What a started server exposes to the launcher. */
export interface RunningServer {
  url: string;
  close(): void;
}

/** Milliseconds between background rescans; printers wake up and fall asleep on their own, disks fill up. */
const REFRESH_INTERVAL = 60_000;
/** How often the clone is compared with `origin/main`; a fetch per hour is cheap and the check is also on demand. */
const UPDATE_CHECK_INTERVAL = 3_600_000;
/**
 * Rescan pause while the printer list is expected to change: a queue has jobs,
 * or a printer command was just typed. CUPS keeps its job list under
 * `/var/spool/cups` and `/var/cache/cups`, both unreadable to a plain user, and
 * rewrites `printers.conf` only after its `DirtyCleanInterval` (30 s by
 * default), so the `/etc/cups` watcher fires half a minute after `lpadmin`
 * and never for a job. Polling briefly is the only way the table follows.
 */
const FAST_REFRESH_INTERVAL = 5_000;
/** How long after a typed printer command the fast rescan keeps going: sudo prompt plus CUPS's delay. */
const SETTLE_MS = 90_000;
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
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const app = new App({
    printersCli: printersCliPath(),
    printersCommand: printersCommand(),
    displaysCli: displaysCliPath(),
    vmCli: vmCliPath(),
    statusCli: statusCliPath(),
    keyboardCli: keyboardCliPath(),
    wallpaperCli: wallpaperCliPath(),
    appCommand: appCommand(),
    root: repoRoot(),
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

  await listen(server, opts.port);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const close = () => {
    app.stop();
    wss.close();
    server.close();
    server.closeAllConnections();
  };
  app.onRestart = () => {
    close();
    restartInPlace(port, token, opts.keepAlive);
  };
  app.start();
  return { url: `http://127.0.0.1:${port}/?t=${token}`, close };
}

/**
 * Binds the port. A fixed port is retried for a few seconds: after an in-place
 * restart the previous process may still be letting go of it.
 */
async function listen(server: http.Server, port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (e) {
      const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || port === 0 || attempt >= 25) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Starts a fresh server process on the same port with the same token and
 * exits this one. The launcher is re-run as it was started (`process.argv`),
 * with `--reuse` so it neither opens another window nor invents a token; the
 * token travels in the environment, which the launcher clears before anything
 * else (the terminal's shell) inherits it. The process's initial environment
 * stays readable to the same user in `/proc`, as is the URL in `server.log`;
 * other users see neither. The windows keep their URL and reconnect on their
 * own; their terminals start a new shell.
 */
function restartInPlace(port: number, token: string, keepAlive: boolean): void {
  const [script, ...rest] = process.argv.slice(1);
  if (!script) throw new Error('cannot restart: launcher path unknown');
  const args = rest.filter((a, i, all) => a !== '--port' && all[i - 1] !== '--port');
  if (!args.includes('--reuse')) args.push('--reuse');
  if (keepAlive && !args.includes('--keep-alive')) args.push('--keep-alive');
  mkdirSync(cacheDir(), { recursive: true });
  const log = openSync(path.join(cacheDir(), 'server.log'), 'a');
  const child = spawn(process.execPath, [script, ...args, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, BTLDM_TOKEN: token },
  });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}

/** Per-connection state. */
interface Client {
  ws: WebSocket;
  terminal: Terminal | null;
  /** Live feeds this window asked for; released when it leaves. */
  watching: Set<WatchTopic>;
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
  vmCli: string;
  statusCli: string;
  keyboardCli: string;
  wallpaperCli: string;
  /** `btl-device-manager` or the launcher's absolute path; see {@link appCommand}. */
  appCommand: string;
  /** The clone the server runs from; what `update` works on and whose `dist/` is watched. */
  root: string;
}

/** Snapshot of the status read as pushed to clients. */
interface StatusState {
  status: SystemStatus | null;
  error: string | null;
}

/** Snapshot of the keyboard read as pushed to clients. */
interface KeyboardSnapshot {
  keyboard: KeyboardState | null;
  error: string | null;
}

/** Snapshot of the wallpaper read as pushed to clients. */
interface WallpaperSnapshot {
  wallpaper: WallpaperState | null;
  error: string | null;
}

const NO_VM_SETTINGS: VmSettings = { workspaces: [] };

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
  private vms: Listing<VirtualMachine> & { settings: VmSettings } = {
    items: [],
    scannedAt: null,
    error: null,
    settings: NO_VM_SETTINGS,
  };
  private status: StatusState = { status: null, error: null };
  private keyboard: KeyboardSnapshot = { keyboard: null, error: null };
  private wallpaper: WallpaperSnapshot = { wallpaper: null, error: null };
  private scanning = false;
  private readonly printerSource: CliSource<ListResult<Printer>>;
  private readonly displaySource: CliSource<ListResult<DisplayOutput>>;
  private readonly vmSource: CliSource<ListResult<VirtualMachine>>;
  private readonly statusSource: CliSource<SystemStatus>;
  private readonly keyboardSource: CliSource<KeyboardState>;
  private readonly wallpaperSource: CliSource<WallpaperState>;
  private readonly perfLive: LiveSource<PerfSample>;
  private readonly vmStatsLive: LiveSource<VmStats[]>;
  private lastPerf: PerfSample | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private stopDistWatch: (() => void) | null = null;
  private update: UpdateState | null = null;
  /** `dist/server.js` changed since this process loaded it. */
  private built = false;
  /** Set by {@link startServer}; restarts this process in place. */
  onRestart: () => void = () => undefined;
  private fastTimer: NodeJS.Timeout | null = null;
  /** Epoch milliseconds until which printer rescans stay fast after a typed command. */
  private settleUntil = 0;

  onClientCountChange: (n: number) => void = () => undefined;

  constructor(private readonly paths: AppPaths) {
    this.printerSource = new CliSource(
      paths.printersCli,
      parseList('printers', (v): v is Printer => typeof (v as Printer)?.id === 'string'),
    );
    this.printerSource.onUpdate = (r, error) => {
      this.printers = listing(r, error);
      this.broadcast({ type: 'printers', ...this.printers });
      this.scheduleFastRefresh();
    };
    this.printerSource.onScanning = (on) => this.setScanning(on);

    this.displaySource = new CliSource(
      paths.displaysCli,
      parseList(
        'outputs',
        (v): v is DisplayOutput => typeof (v as DisplayOutput)?.identifier === 'string',
      ),
    );
    this.displaySource.onUpdate = (r, error) => {
      this.displays = listing(r, error);
      this.broadcast({ type: 'displays', ...this.displays });
    };

    this.vmSource = new CliSource(
      paths.vmCli,
      parseList('vms', (v): v is VirtualMachine => typeof (v as VirtualMachine)?.name === 'string'),
    );
    this.vmSource.onUpdate = (r, error) => {
      this.vms = { ...listing(r, error), settings: vmSettings(r?.data.settings) };
      this.broadcast({ type: 'vms', ...this.vms });
    };

    this.statusSource = new CliSource(paths.statusCli, parseStatus);
    this.statusSource.onUpdate = (status, error) => {
      this.status = { status, error };
      this.broadcast({ type: 'status', ...this.status });
    };

    this.keyboardSource = new CliSource(paths.keyboardCli, parseKeyboard);
    this.keyboardSource.onUpdate = (keyboard, error) => {
      this.keyboard = { keyboard, error };
      this.broadcast({ type: 'keyboard', ...this.keyboard });
    };

    this.wallpaperSource = new CliSource(paths.wallpaperCli, parseWallpaper);
    this.wallpaperSource.onUpdate = (wallpaper, error) => {
      this.wallpaper = { wallpaper, error };
      this.broadcast({ type: 'wallpaper', ...this.wallpaper });
    };

    this.perfLive = new LiveSource(paths.statusCli, ['perf', '--json'], parsePerf);
    this.perfLive.onSample = (sample) => {
      this.lastPerf = sample;
      this.broadcastTo('perf', { type: 'perf', sample });
    };
    this.perfLive.onError = (text) =>
      this.broadcastTo('perf', { type: 'notice', level: 'error', text });
    this.vmStatsLive = new LiveSource(
      paths.vmCli,
      ['stats', '--json'],
      (text) =>
        parseList('items', (v): v is VmStats => typeof (v as VmStats)?.name === 'string')(text)
          .items,
    );
    this.vmStatsLive.onSample = (items) =>
      this.broadcastTo('vm-stats', { type: 'vm-stats', items });
    this.vmStatsLive.onError = (text) =>
      this.broadcastTo('vm-stats', { type: 'notice', level: 'error', text });
  }

  /** The feed behind a topic, reduced to what watching needs. */
  private live(topic: WatchTopic): { watch(on: boolean): void } {
    return topic === 'perf' ? this.perfLive : this.vmStatsLive;
  }

  /** Only the printer scan is slow enough to show; display reads take milliseconds. */
  private setScanning(on: boolean): void {
    this.scanning = on;
    this.broadcast({ type: 'scanning', scanning: on });
  }

  start(): void {
    void this.printerSource.refresh();
    void this.displaySource.refresh();
    void this.vmSource.refresh();
    void this.statusSource.refresh();
    void this.keyboardSource.refresh();
    void this.wallpaperSource.refresh();
    this.printerSource.watch(watchCups);
    this.displaySource.watch(watchSwayOutputs);
    this.vmSource.watch(watchVirshEvents);
    this.statusSource.watch(watchNetwork);
    this.keyboardSource.watch(watchSwayInputs);
    this.refreshTimer = setInterval(() => {
      void this.printerSource.refresh();
      void this.statusSource.refresh();
    }, REFRESH_INTERVAL);
    void this.checkForUpdate();
    this.updateTimer = setInterval(() => void this.checkForUpdate(), UPDATE_CHECK_INTERVAL);
    this.stopDistWatch = watchDist(path.join(this.paths.root, 'dist'), () => {
      this.built = true;
      this.broadcast(this.updateSnapshot());
    });
  }

  /** Compares the clone with `origin/main` and tells every window; failures leave the last state. */
  async checkForUpdate(): Promise<void> {
    this.update = await checkUpdate(this.paths.root);
    this.broadcast(this.updateSnapshot());
  }

  updateSnapshot(): Extract<ServerMessage, { type: 'update' }> {
    return { type: 'update', state: this.update, built: this.built };
  }

  /**
   * Rescans sooner while any queue has unfinished jobs or a printer command
   * was typed within {@link SETTLE_MS}; one timer, re-armed after each listing.
   */
  private scheduleFastRefresh(): void {
    if (this.fastTimer) clearTimeout(this.fastTimer);
    this.fastTimer = null;
    const jobs = this.printers.items.some((p) => (p.queue?.jobs.length ?? 0) > 0);
    if (!jobs && Date.now() >= this.settleUntil) return;
    this.fastTimer = setTimeout(() => void this.printerSource.refresh(), FAST_REFRESH_INTERVAL);
  }

  /** Called when a printer command goes into the terminal; the list will change, but only CUPS knows when. */
  private expectPrinterChange(): void {
    this.settleUntil = Date.now() + SETTLE_MS;
    this.scheduleFastRefresh();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.fastTimer) clearTimeout(this.fastTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.stopDistWatch?.();
    this.printerSource.stop();
    this.displaySource.stop();
    this.vmSource.stop();
    this.statusSource.stop();
    this.keyboardSource.stop();
    this.wallpaperSource.stop();
    this.perfLive.stop();
    this.vmStatsLive.stop();
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

  refreshVms(): Promise<void> {
    return this.vmSource.refresh();
  }

  vmsSnapshot(): Listing<VirtualMachine> & { settings: VmSettings } {
    return this.vms;
  }

  refreshStatus(): Promise<void> {
    return this.statusSource.refresh();
  }

  statusSnapshot(): StatusState {
    return this.status;
  }

  refreshKeyboard(): Promise<void> {
    return this.keyboardSource.refresh();
  }

  keyboardSnapshot(): KeyboardSnapshot {
    return this.keyboard;
  }

  /**
   * Switches the keyboard layout. Direct, like {@link setConsoleWorkspace}:
   * two lines in the user's own sway config and a `swaymsg` that cannot need
   * root. The variant must be one the last listing offered.
   */
  async setKeyboardLayout(variant: string): Promise<void> {
    const offered = this.keyboard.keyboard?.offered ?? [];
    if (!offered.some((l) => l.variant === variant)) {
      throw new Error(`no keyboard layout called ${variant}; refresh and try again`);
    }
    await runCli(this.paths.keyboardCli, ['set', variant]);
    await this.keyboardSource.refresh();
  }

  refreshWallpaper(): Promise<void> {
    return this.wallpaperSource.refresh();
  }

  wallpaperSnapshot(): WallpaperSnapshot {
    return this.wallpaper;
  }

  /**
   * The picture on screen now: `wallpaper.conf`'s, else the main config's.
   * The only file the image endpoint serves, so the token cannot be used to
   * read anything but a path the user's own sway config already names.
   */
  wallpaperImage(): string | null {
    const w = this.wallpaper.wallpaper;
    const s = w?.current ?? w?.fallback ?? null;
    return s?.kind === 'image' && !w?.imageMissing ? s.path : null;
  }

  /**
   * The wallpaper actions. Direct, like {@link setKeyboardLayout}: one line in
   * the user's own sway config and a `swaymsg`, no root, a one-line failure.
   * The CLI checks colour, fit and picture again; the server only refuses
   * what it can see is wrong before starting a process.
   */
  async setWallpaperColor(color: string): Promise<void> {
    if (!isColor(color)) throw new Error(`expected a colour like #1d2330, got ${color}`);
    await this.runWallpaper(['set-color', color]);
  }

  /** Changes how the current picture is laid out without choosing it again. */
  async setWallpaperFit(fit: string, color: string | null): Promise<void> {
    const path = this.wallpaperImage();
    if (!path) throw new Error('no picture is set; choose one first');
    await this.runWallpaper(imageArgs(path, fit, color));
  }

  /** Hands an uploaded picture to the CLI, which copies it; the upload is removed either way. */
  async setWallpaperImage(file: string, fit: string, color: string | null): Promise<void> {
    try {
      await this.runWallpaper(imageArgs(file, fit, color));
    } finally {
      await rm(file, { force: true });
    }
  }

  async resetWallpaper(): Promise<void> {
    await this.runWallpaper(['reset']);
  }

  private async runWallpaper(args: string[]): Promise<void> {
    await runCli(this.paths.wallpaperCli, args);
    await this.wallpaperSource.refresh();
  }

  /**
   * Switches the power profile. Direct, like {@link moveWorkspace}:
   * power-profiles-daemon lets the user at the keyboard do it without root
   * and remembers it. The name must be one the last sample offered.
   */
  async setPowerProfile(name: string): Promise<void> {
    const offered = this.lastPerf?.powerProfile?.available ?? [];
    if (!offered.includes(name)) throw new Error(`no power profile called ${name}`);
    await runCli(this.paths.statusCli, ['set-profile', name]);
  }

  /**
   * Stores where one machine's console window goes. Direct, like
   * {@link moveWorkspace}: it writes one line into the user's own sway config
   * and cannot need root. Both names must come from the current listing.
   */
  async setConsoleWorkspace(name: string, workspace: string | null): Promise<void> {
    if (!this.vms.items.some((v) => v.name === name)) {
      throw new Error('unknown virtual machine; refresh and try again');
    }
    if (workspace !== null && !this.vms.settings.workspaces.includes(workspace)) {
      throw new Error(`no workspace called ${workspace}; refresh and try again`);
    }
    await runCli(this.paths.vmCli, ['console-workspace', name, workspace ?? '--none']);
    await this.vmSource.refresh();
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
    const client: Client = { ws, terminal: null, watching: new Set() };
    this.clients.add(client);
    this.onClientCountChange(this.clients.size);
    this.send(client, { type: 'printers', ...this.printers });
    this.send(client, { type: 'displays', ...this.displays });
    this.send(client, { type: 'vms', ...this.vms });
    this.send(client, { type: 'status', ...this.status });
    this.send(client, { type: 'keyboard', ...this.keyboard });
    this.send(client, { type: 'wallpaper', ...this.wallpaper });
    this.send(client, { type: 'scanning', scanning: this.scanning });
    this.send(client, this.updateSnapshot());

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
      for (const topic of client.watching) this.live(topic).watch(false);
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

  /** Sends only to the windows that asked for a live feed. */
  private broadcastTo(topic: WatchTopic, msg: ServerMessage): void {
    for (const c of this.clients) if (c.watching.has(topic)) this.send(c, msg);
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
      case 'watch': {
        if (msg.topic !== 'perf' && msg.topic !== 'vm-stats') throw new Error('unknown feed');
        const had = client.watching.has(msg.topic);
        if (msg.on && !had) {
          client.watching.add(msg.topic);
          this.live(msg.topic).watch(true);
          if (msg.topic === 'perf' && this.lastPerf) {
            this.send(client, { type: 'perf', sample: this.lastPerf });
          }
        } else if (!msg.on && had) {
          client.watching.delete(msg.topic);
          this.live(msg.topic).watch(false);
        }
        break;
      }
      case 'term-run':
        if (!client.terminal) throw new Error('terminal is not open');
        client.terminal.runChain(
          buildSteps(
            msg.run,
            {
              printers: this.printers.items,
              vms: this.vms.items,
              failedUnits: this.status.status?.failedUnits ?? [],
            },
            {
              printers: this.paths.printersCommand,
              displays: this.paths.displaysCli,
              vm: this.paths.vmCli,
              layouts: layoutsDir(),
              user: userInfo().username,
              app: this.paths.appCommand,
            },
          ),
        );
        if (msg.run.action.startsWith('printer-')) this.expectPrinterChange();
        break;
    }
  }
}

/** How the CLIs are spelled in the terminal and where layout files may come from. */
export interface StepContext {
  printers: string;
  displays: string;
  vm: string;
  layouts: string;
  /** Account the server runs as; its own print jobs can be cancelled without root. */
  user: string;
  /** How the launcher is spelled in the terminal, for `update`. */
  app: string;
}

/** The last listings, which every typed action is checked against. */
export interface Known {
  printers: Printer[];
  vms: VirtualMachine[];
  failedUnits: FailedUnit[];
}

/** Turns a CLI result (or its absence) into the listing pushed to clients. */
function listing<T>(r: ListResult<T> | null, error: string | null): Listing<T> {
  return { items: r?.items ?? [], scannedAt: r?.scannedAt ?? null, error };
}

/**
 * Translates a terminal action into the shell line the user will see. A
 * printer or machine name must come from the current list and a layout file
 * from the server's own directory, so the terminal only ever runs the CLIs on
 * something the server has produced or reported, never on client-supplied text.
 */
export function buildSteps(run: TerminalAction, known: Known, ctx: StepContext): string[] {
  if (run.action === 'display-apply') {
    const file = path.resolve(run.file);
    if (path.dirname(file) !== path.resolve(ctx.layouts) || !existsSync(file)) {
      throw new Error('layout was not prepared by this server');
    }
    return [`${ctx.displays} apply ${shellQuote(file)}`];
  }
  if (run.action === 'app-update') return [`${ctx.app} update`];
  // passwd is setuid and asks for the current password itself: no sudo, and
  // the password never passes through the app as anything but keystrokes.
  if (run.action === 'passwd') return ['passwd'];
  if (run.action === 'status-log') {
    const unit = known.failedUnits.find((u) => u.unit === run.unit && u.scope === run.scope);
    if (!unit) throw new Error('unknown unit; refresh the status and try again');
    // The journal is readable only by root and the adm group; user units are the user's own.
    const prefix = unit.scope === 'user' ? 'journalctl --user' : 'sudo journalctl';
    return [`${prefix} -u ${shellQuote(unit.unit)} -n 50 --no-pager`];
  }
  if ('name' in run) return vmSteps(run, known.vms, ctx.vm);
  const printer = known.printers.find((p) => p.id === run.id);
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
    case 'printer-cancel': {
      requireQueue(printer);
      const jobs = printer.queue?.jobs ?? [];
      if (run.job === null) return [`sudo ${cli} cancel ${id}`];
      const job = jobs.find((j) => j.id === run.job);
      if (!job) throw new Error(`job ${run.job} is no longer waiting; refresh the list`);
      // One's own job can be cancelled without root; purging a queue or
      // someone else's job cannot, so only those ask for the sudo password.
      const prefix = job.user === ctx.user ? '' : 'sudo ';
      return [`${prefix}${cli} cancel ${id} ${job.id}`];
    }
  }
}

function requireQueue(printer: Printer): void {
  if (!printer.queue) throw new Error(`${printer.name} has no queue yet`);
}

type VmAction = Extract<TerminalAction, { name: string }>;

/**
 * The VM actions; none needs root, each is typed so a guest that refuses says
 * why in view. Start goes straight on to the console: a machine is started to
 * be used, and the console is where that happens.
 */
function vmSteps(run: VmAction, known: VirtualMachine[], cli: string): string[] {
  const vm = known.find((v) => v.name === run.name);
  if (!vm) throw new Error('unknown virtual machine; refresh the list and try again');
  const name = shellQuote(vm.name);
  switch (run.action) {
    case 'vm-start':
      if (!isDown(vm)) throw new Error(`${vm.name} is ${vm.state}`);
      return [`${cli} start ${name}`, `${cli} console ${name}`];
    case 'vm-shutdown':
      if (!isUp(vm)) throw new Error(`${vm.name} is ${vm.state}`);
      return [`${cli} shutdown ${name}`];
    case 'vm-poweroff':
      if (!isUp(vm)) throw new Error(`${vm.name} is ${vm.state}`);
      return [`${cli} poweroff ${name}`];
    case 'vm-console':
      if (!isUp(vm)) throw new Error(`${vm.name} is ${vm.state}; start it first`);
      return [`${cli} console ${name}`];
  }
}

/** `set-image` arguments, refusing a fit or colour the CLI would refuse anyway. */
function imageArgs(file: string, fit: string, color: string | null): string[] {
  if (!isFit(fit)) throw new Error(`unknown fit ${fit}`);
  if (color !== null && !isColor(color))
    throw new Error(`expected a colour like #1d2330, got ${color}`);
  return ['set-image', file, fit, ...(color ? [color] : [])];
}

/** Validates `btl-status perf --json` just enough: an object with a `cpuPercent`. */
function parsePerf(text: string): PerfSample {
  const data = JSON.parse(text) as Partial<PerfSample>;
  if (!data || typeof data.cpuPercent !== 'number') throw new Error('CLI returned no sample');
  return data as PerfSample;
}

/** Validates the `settings` object of `btl-vm list --json`; a malformed one yields the defaults. */
function vmSettings(v: unknown): VmSettings {
  const s = v as Partial<VmSettings> | undefined;
  return {
    workspaces: Array.isArray(s?.workspaces)
      ? s.workspaces.filter((w): w is string => typeof w === 'string')
      : [],
  };
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
    case 'GET /api/vms':
      sendJson(res, 200, app.vmsSnapshot());
      return;
    case 'GET /api/status':
      sendJson(res, 200, app.statusSnapshot());
      return;
    case 'POST /api/status/refresh':
      await app.refreshStatus();
      sendJson(res, 200, app.statusSnapshot());
      return;
    case 'POST /api/status/profile': {
      const body = await readJson(req);
      if (typeof body.profile !== 'string') throw new Error('missing profile');
      await app.setPowerProfile(body.profile);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'GET /api/keyboard':
      sendJson(res, 200, app.keyboardSnapshot());
      return;
    case 'POST /api/keyboard/refresh':
      await app.refreshKeyboard();
      sendJson(res, 200, app.keyboardSnapshot());
      return;
    case 'POST /api/keyboard/layout': {
      const body = await readJson(req);
      if (typeof body.variant !== 'string') throw new Error('missing variant');
      await app.setKeyboardLayout(body.variant);
      sendJson(res, 200, app.keyboardSnapshot());
      return;
    }
    case 'GET /api/wallpaper':
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    case 'POST /api/wallpaper/refresh':
      await app.refreshWallpaper();
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    case 'GET /api/wallpaper/image': {
      const file = app.wallpaperImage();
      if (!file || !existsSync(file)) {
        sendJson(res, 404, { error: 'no picture is set' });
        return;
      }
      res.writeHead(200, {
        'content-type': IMAGE_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      createReadStream(file).pipe(res);
      return;
    }
    case 'POST /api/wallpaper/color': {
      const body = await readJson(req);
      if (typeof body.color !== 'string') throw new Error('missing color');
      await app.setWallpaperColor(body.color);
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    }
    case 'POST /api/wallpaper/fit': {
      const body = await readJson(req);
      if (typeof body.fit !== 'string') throw new Error('missing fit');
      if (body.color !== null && typeof body.color !== 'string')
        throw new Error('color must be a string or null');
      await app.setWallpaperFit(body.fit, body.color);
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    }
    case 'POST /api/wallpaper/image': {
      // The picture is the raw body; fit and colour travel in the query.
      const file = await receiveFile(req, uploadsDir(), MAX_IMAGE_BYTES);
      await app.setWallpaperImage(
        file,
        url.searchParams.get('fit') ?? 'fill',
        url.searchParams.get('color'),
      );
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    }
    case 'POST /api/wallpaper/reset':
      await app.resetWallpaper();
      sendJson(res, 200, app.wallpaperSnapshot());
      return;
    case 'POST /api/vms/refresh':
      await app.refreshVms();
      sendJson(res, 200, app.vmsSnapshot());
      return;
    case 'POST /api/vms/console-workspace': {
      const body = await readJson(req);
      if (typeof body.name !== 'string') throw new Error('missing name');
      if (body.workspace !== null && typeof body.workspace !== 'string') {
        throw new Error('workspace must be a string or null');
      }
      await app.setConsoleWorkspace(body.name, body.workspace);
      sendJson(res, 200, app.vmsSnapshot());
      return;
    }
    case 'GET /api/update':
      sendJson(res, 200, app.updateSnapshot());
      return;
    case 'POST /api/update/check':
      await app.checkForUpdate();
      sendJson(res, 200, app.updateSnapshot());
      return;
    case 'POST /api/restart':
      sendJson(res, 200, { ok: true });
      // Answer first: the socket is gone the moment the listener closes.
      setTimeout(() => app.onRestart(), 100);
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

/** Content types for the wallpaper preview; the CLI only ever copies PNG and JPEG. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Streams a request body into a fresh file under `dir` and returns its path.
 * A body over `limit` bytes is cut off and its partial file removed, so a
 * runaway upload cannot fill the disk.
 */
async function receiveFile(req: http.IncomingMessage, dir: string, limit: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `upload-${randomBytes(8).toString('hex')}`);
  const out = createWriteStream(file);
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          req.destroy();
          reject(new Error(`the picture is larger than ${limit >> 20} MiB`));
          return;
        }
        out.write(c);
      });
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
      out.on('error', reject);
    });
  } catch (e) {
    out.destroy();
    await rm(file, { force: true });
    throw e;
  }
  if (size === 0) {
    await rm(file, { force: true });
    throw new Error('empty upload');
  }
  return file;
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
