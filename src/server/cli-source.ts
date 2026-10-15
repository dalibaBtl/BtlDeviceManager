import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';
import type { KeyboardState, SystemStatus, WallpaperState } from '../shared/types.js';

/** Upper bound for one `list --json` run; mDNS browsing alone takes a few seconds. */
const LIST_TIMEOUT_MS = 20_000;

/**
 * The server's only view of a feature: it runs `<cli> list --json` and parses
 * the result. No CUPS, sway or libvirt knowledge lives in the server, so what
 * the UI shows is exactly what the user would get from the CLI over SSH.
 */
export class CliSource<R> {
  /** Called with every fresh result, or with `null` and the error when the CLI failed. */
  onUpdate: (result: R | null, error: string | null) => void = () => undefined;
  onScanning: (scanning: boolean) => void = () => undefined;

  private running: Promise<void> | null = null;
  private stops: (() => void)[] = [];

  constructor(
    private readonly cliPath: string,
    private readonly parse: (json: string) => R,
  ) {}

  /** Registers an external trigger (file watch, event stream) that calls {@link refresh}. */
  watch(start: (onChange: () => void) => () => void): void {
    this.stops.push(start(() => void this.refresh()));
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  /** Runs one scan; concurrent calls share the run in progress. */
  refresh(): Promise<void> {
    if (!this.running) {
      this.onScanning(true);
      this.running = this.scan().finally(() => {
        this.running = null;
        this.onScanning(false);
      });
    }
    return this.running;
  }

  private async scan(): Promise<void> {
    try {
      this.onUpdate(this.parse(await runCli(this.cliPath, ['list', '--json'])), null);
    } catch (e) {
      this.onUpdate(null, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Pause between the end of one live sample and the start of the next. */
const LIVE_GAP_MS = 1000;
/** Pause after a failed live sample, so a broken CLI does not spin. */
const LIVE_RETRY_MS = 5000;

/**
 * A feed that costs something to produce (each `btl-status perf` run takes a
 * second of sampling), so it runs only while at least one window watches it:
 * the CLI is run, its result pushed, a short pause taken, and again, until
 * the last watcher leaves. A failure is pushed as an error and retried later.
 */
export class LiveSource<R> {
  onSample: (result: R) => void = () => undefined;
  onError: (error: string) => void = () => undefined;

  private watchers = 0;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly cliPath: string,
    private readonly args: string[],
    private readonly parse: (json: string) => R,
    private readonly run: (cliPath: string, args: string[]) => Promise<string> = runCli,
  ) {}

  /** Adds or removes one watcher; the loop starts with the first and stops after the last. */
  watch(on: boolean): void {
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
    if (this.watchers > 0 && !this.loop) this.loop = this.spin();
  }

  get watching(): number {
    return this.watchers;
  }

  stop(): void {
    this.watchers = 0;
  }

  private async spin(): Promise<void> {
    try {
      while (this.watchers > 0) {
        let wait = LIVE_GAP_MS;
        try {
          const result = this.parse(await this.run(this.cliPath, this.args));
          if (this.watchers > 0) this.onSample(result);
        } catch (e) {
          this.onError(e instanceof Error ? e.message : String(e));
          wait = LIVE_RETRY_MS;
        }
        if (this.watchers > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      this.loop = null;
    }
  }
}

/** Runs one of this clone's CLIs with the same Node binary and returns stdout. */
export function runCli(cliPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

/** A parsed `list --json` result: the items plus whatever else the CLI printed. */
export interface ListResult<T> {
  items: T[];
  scannedAt: number;
  data: Record<string, unknown>;
}

/** Validates the CLI's JSON just enough to not crash the UI on a half-written line. */
export function parseList<T>(key: string, isItem: (v: unknown) => v is T) {
  return (text: string): ListResult<T> => {
    const data = JSON.parse(text) as Record<string, unknown>;
    const list = data[key];
    if (!Array.isArray(list)) throw new Error(`CLI returned no "${key}" list`);
    return {
      items: list.filter(isItem),
      scannedAt: typeof data.scannedAt === 'number' ? data.scannedAt : Date.now(),
      data,
    };
  };
}

/** Validates `btl-status list --json` just enough: an object with a `host`. */
export function parseStatus(text: string): SystemStatus {
  const data = JSON.parse(text) as Partial<SystemStatus>;
  if (!data || typeof data !== 'object' || typeof data.host?.name !== 'string') {
    throw new Error('CLI returned no status');
  }
  return data as SystemStatus;
}

/** Validates `btl-keyboard list --json` just enough: an object with an `offered` list. */
export function parseKeyboard(text: string): KeyboardState {
  const data = JSON.parse(text) as Partial<KeyboardState>;
  if (!data || typeof data !== 'object' || !Array.isArray(data.offered)) {
    throw new Error('CLI returned no keyboard state');
  }
  return data as KeyboardState;
}

/** Validates `btl-wallpaper list --json` just enough: an object with a `fits` list. */
export function parseWallpaper(text: string): WallpaperState {
  const data = JSON.parse(text) as Partial<WallpaperState>;
  if (!data || typeof data !== 'object' || !Array.isArray(data.fits)) {
    throw new Error('CLI returned no wallpaper state');
  }
  return data as WallpaperState;
}

/**
 * Watches CUPS's configuration directory so queues created in the terminal
 * show up on their own. CUPS rewrites `printers.conf` on every queue change;
 * events for one change arrive in a burst, hence the debounce.
 */
export function watchCups(onChange: () => void): () => void {
  return debounced(1500, onChange, (fire) => {
    try {
      const w = fsWatch('/etc/cups', { persistent: false }, (_event, file) => {
        if (!file || /printers\.conf/.test(String(file))) fire();
      });
      w.on('error', () => undefined);
      return () => w.close();
    } catch {
      return () => undefined;
    }
  });
}

/**
 * Watches the built server bundle. `npm run build` (by hand or through
 * `btl-device-manager update`) replaces `dist/server.js` while the old code
 * keeps running; the server tells its windows a restart is worth it instead
 * of restarting on its own, because a restart ends the terminal's shell.
 */
export function watchDist(distDir: string, onChange: () => void): () => void {
  return debounced(2000, onChange, (fire) => {
    try {
      const w = fsWatch(distDir, { persistent: false }, (_event, file) => {
        if (!file || /^server\.js$/.test(String(file))) fire();
      });
      w.on('error', () => undefined);
      return () => w.close();
    } catch {
      return () => undefined;
    }
  });
}

/**
 * Follows sway's output events (`swaymsg -t subscribe '["output"]' -m`), one
 * JSON object per line, so a plugged or unplugged monitor redraws the panel
 * without a Refresh click. The stream is restarted when sway closes it
 * (reload) and given up when `swaymsg` is not there at all.
 */
export function watchSwayOutputs(onChange: () => void): () => void {
  return followStream('swaymsg', ['-t', 'subscribe', '["output"]', '-m'], 500, onChange);
}

/**
 * Follows sway's input events, which fire when a keyboard is plugged in or its
 * keymap changes, so a layout switched from the terminal or a sway reload shows
 * up without a Refresh click.
 */
export function watchSwayInputs(onChange: () => void): () => void {
  return followStream('swaymsg', ['-t', 'subscribe', '["input"]', '-m'], 500, onChange);
}

/**
 * Follows libvirt's lifecycle events (`virsh event --all --loop`), one line per
 * event, so a guest started or stopped elsewhere (the terminal, a timer, the
 * guest itself) is reflected without a Refresh click. The content of the line
 * does not matter; any event means the list may have changed.
 */
export function watchVirshEvents(onChange: () => void): () => void {
  return followStream('virsh', ['-c', 'qemu:///system', 'event', '--all', '--loop'], 500, onChange);
}

/** Follows NetworkManager (`nmcli monitor`) so a cable or Wi-Fi change updates the status at once. */
export function watchNetwork(onChange: () => void): () => void {
  return followStream('nmcli', ['monitor'], 1000, onChange);
}

/**
 * Keeps a long-lived event stream running: any output fires (debounced), the
 * process is restarted when it ends (sway reload, libvirtd restart) and given
 * up when the program is not there at all.
 */
function followStream(cmd: string, args: string[], ms: number, onChange: () => void): () => void {
  return debounced(ms, onChange, (fire) => {
    let child: ChildProcess | null = null;
    let stopped = false;
    const start = () => {
      if (stopped) return;
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout?.on('data', () => fire());
      child.on('error', () => {
        stopped = true;
      });
      child.on('exit', () => {
        child = null;
        if (!stopped) setTimeout(start, 2000);
      });
    };
    start();
    return () => {
      stopped = true;
      child?.kill();
    };
  });
}

function debounced(
  ms: number,
  onChange: () => void,
  start: (fire: () => void) => () => void,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const stop = start(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, ms);
  });
  return () => {
    if (timer) clearTimeout(timer);
    stop();
  };
}
