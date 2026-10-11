import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { watch as fsWatch } from 'node:fs';

/** Upper bound for one `list --json` run; mDNS browsing alone takes a few seconds. */
const LIST_TIMEOUT_MS = 20_000;

/**
 * The server's only view of a feature: it runs `<cli> list --json` and parses
 * the result. No CUPS or sway knowledge lives in the server, so what the UI
 * shows is exactly what the user would get from the CLI over SSH.
 */
export class CliSource<T> {
  /**
   * Called with every fresh list, or with the error when the CLI failed.
   * `data` is the whole JSON object the CLI printed, for the few fields that
   * are not list items (the VM console setting); empty on failure.
   */
  onUpdate: (
    items: T[],
    scannedAt: number | null,
    error: string | null,
    data: Record<string, unknown>,
  ) => void = () => undefined;
  onScanning: (scanning: boolean) => void = () => undefined;

  private running: Promise<void> | null = null;
  private stops: (() => void)[] = [];

  constructor(
    private readonly cliPath: string,
    private readonly parse: (json: string) => {
      items: T[];
      scannedAt: number;
      data: Record<string, unknown>;
    },
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
      const parsed = this.parse(await runCli(this.cliPath, ['list', '--json']));
      this.onUpdate(parsed.items, parsed.scannedAt, null, parsed.data);
    } catch (e) {
      this.onUpdate([], null, e instanceof Error ? e.message : String(e), {});
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

/** Validates the CLI's JSON just enough to not crash the UI on a half-written line. */
export function parseList<T>(key: string, isItem: (v: unknown) => v is T) {
  return (text: string): { items: T[]; scannedAt: number; data: Record<string, unknown> } => {
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
 * Follows sway's output events (`swaymsg -t subscribe '["output"]' -m`), one
 * JSON object per line, so a plugged or unplugged monitor redraws the panel
 * without a Refresh click. The stream is restarted when sway closes it
 * (reload) and given up when `swaymsg` is not there at all.
 */
export function watchSwayOutputs(onChange: () => void): () => void {
  return followStream('swaymsg', ['-t', 'subscribe', '["output"]', '-m'], 500, onChange);
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
