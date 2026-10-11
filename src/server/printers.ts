import { execFile } from 'node:child_process';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { Printer, PrinterList } from '../shared/types.js';

/** Upper bound for one `btl-printers list` run; mDNS browsing alone takes a few seconds. */
const LIST_TIMEOUT_MS = 20_000;
/** CUPS rewrites `printers.conf` on every queue change; events for one change arrive in a burst. */
const CUPS_DEBOUNCE_MS = 1500;

/**
 * The server's only view of printers: it runs `btl-printers list --json` and
 * parses the result. No CUPS or mDNS knowledge lives here, so what the UI
 * shows is exactly what the user would get from the CLI over SSH.
 */
export class PrinterSource {
  /** Called with every fresh list, or with the error when the CLI failed. */
  onUpdate: (items: Printer[], scannedAt: number | null, error: string | null) => void = () =>
    undefined;
  onScanning: (scanning: boolean) => void = () => undefined;

  private running: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(private readonly cliPath: string) {}

  /** Watches CUPS's configuration directory so queues created in the terminal show up on their own. */
  startWatching(): void {
    try {
      this.watcher = fsWatch('/etc/cups', { persistent: false }, (_event, file) => {
        if (file && !/printers\.conf/.test(String(file))) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.refresh(), CUPS_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
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
      const out = await this.runCli(['list', '--json']);
      const parsed = parsePrinterList(out);
      this.onUpdate(parsed.printers, parsed.scannedAt, null);
    } catch (e) {
      this.onUpdate([], null, e instanceof Error ? e.message : String(e));
    }
  }

  private runCli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [this.cliPath, ...args],
        { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout);
        },
      );
    });
  }
}

/** Validates the CLI's JSON just enough to not crash the UI on a half-written line. */
export function parsePrinterList(text: string): PrinterList {
  const data = JSON.parse(text) as Partial<PrinterList>;
  if (!Array.isArray(data.printers)) throw new Error('btl-printers returned no printer list');
  return {
    printers: data.printers.filter((p): p is Printer => typeof p?.id === 'string'),
    scannedAt: typeof data.scannedAt === 'number' ? data.scannedAt : Date.now(),
  };
}
