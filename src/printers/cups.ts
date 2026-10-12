/**
 * Parsers for CUPS command output and builders for the commands the CLI runs.
 *
 * Reads go through `lpstat`, which any user may run. Queue changes go through
 * `lpadmin`, which needs the `lpadmin` group or root; the CLI is run under
 * `sudo` for those, typed into the terminal by the app so the user sees it.
 */
import type { PrintJob, PrintQueue, QueueState } from '../shared/types.js';

/** Absolute path: `/usr/sbin` is not on a regular user's PATH on Debian. */
export const LPADMIN = '/usr/sbin/lpadmin';
/** The cups-filters PPD generator; also lists reachable IPP Everywhere printers. */
export const DRIVERLESS = '/usr/lib/cups/driver/driverless';
/** Test page shipped with CUPS. */
export const TEST_PAGE = '/usr/share/cups/data/testprint';

/**
 * Parses `lpstat -v` (device URIs), `lpstat -l -p` (states and alerts),
 * `lpstat -d` (default destination) and `lpstat -l -o` (unfinished jobs) into
 * queues. All outputs are as printed with `LC_ALL=C`; the plain `-p` form is
 * accepted too, it simply has no `Alerts:` lines. Queues without a device
 * line are skipped because `lpstat -p` alone cannot tell where they print.
 */
export function parseLpstat(
  devices: string,
  printers: string,
  defaultDest: string,
  jobs = '',
): PrintQueue[] {
  const def = /system default destination:\s*(\S+)/.exec(defaultDest)?.[1] ?? null;
  const states = new Map<string, QueueState>();
  const reasons = new Map<string, string[]>();
  let current = '';
  for (const line of printers.split('\n')) {
    const m = /^printer (\S+) (?:is|disabled|now)\s*(.*)$/.exec(line.trim());
    if (m) {
      current = m[1] ?? '';
      states.set(current, queueState(line));
      continue;
    }
    const a = /^\s+Alerts:\s*(.*)$/.exec(line);
    if (a && current) reasons.set(current, parseAlerts(a[1] ?? ''));
  }
  const byQueue = parseLpstatJobs(jobs);
  const queues: PrintQueue[] = [];
  for (const line of devices.split('\n')) {
    const m = /^device for (\S+): (.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1] ?? '';
    queues.push({
      name,
      uri: (m[2] ?? '').trim(),
      state: states.get(name) ?? 'unknown',
      isDefault: name === def,
      reasons: reasons.get(name) ?? [],
      jobs: byQueue.get(name) ?? [],
    });
  }
  return queues.sort((a, b) => a.name.localeCompare(b.name));
}

/** `Alerts: none` means no reasons; otherwise the reasons are space-separated. */
function parseAlerts(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length === 1 && words[0] === 'none' ? [] : words;
}

/**
 * Parses `lpstat -l -o`, grouped by queue. Each job is one header line
 *
 *     Office-12    alice    1024   Mon Oct 12 13:04:04 2026
 *
 * followed by indented detail lines, of which `Alerts:` carries the job state
 * reasons. The queue name is everything before the last `-<number>`, since
 * queue names may themselves contain dashes. Dates are local time in the C
 * locale, which is how `Date` parses them too.
 */
export function parseLpstatJobs(output: string): Map<string, PrintJob[]> {
  const out = new Map<string, PrintJob[]>();
  let last: PrintJob | null = null;
  for (const line of output.split('\n')) {
    const h = /^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (h) {
      const at = new Date((h[5] ?? '').trim()).getTime();
      last = {
        id: Number(h[2]),
        user: h[3] ?? '',
        sizeBytes: Number(h[4]),
        submittedAt: Number.isNaN(at) ? null : at,
        reasons: [],
      };
      const queue = h[1] ?? '';
      out.set(queue, [...(out.get(queue) ?? []), last]);
      continue;
    }
    const a = /^\s+Alerts:\s*(.*)$/.exec(line);
    if (a && last) last.reasons = parseAlerts(a[1] ?? '');
  }
  for (const jobs of out.values()) jobs.sort((x, y) => x.id - y.id);
  return out;
}

function queueState(line: string): QueueState {
  if (/ disabled /.test(line)) return 'stopped';
  if (/ is idle/.test(line)) return 'idle';
  if (/ now printing /.test(line)) return 'printing';
  return 'unknown';
}

/** One printer for which cups-filters can generate a PPD, from `driverless list`. */
export interface DriverlessEntry {
  /** CUPS model name to pass to `lpadmin -m`, e.g. `driverless:ipp://host:631/ipp/print`. */
  model: string;
  /** The IPP URI inside `model`. */
  uri: string;
  /** Manufacturer as reported in the IEEE 1284 device ID. */
  make: string;
  /** Model description, e.g. `Example L1234 Series, driverless, cups-filters 2.0.1`. */
  description: string;
}

/**
 * Parses `driverless list`, whose lines mirror `lpinfo -m --device-id` output:
 *
 *     "driverless:ipp://host:631/ipp/print" en "MFG" "Model, driverless, cups-filters 2.x" "MFG:…;MDL:…;"
 *
 * Newer cups-filters print a DNS-SD URI instead of a host, with the service
 * name URL-encoded: `driverless:ipps://Example%20L1234._ipps._tcp.local/`.
 * {@link driverlessServiceName} gets the name back out of that form.
 * Unlike `lpinfo`, `driverless` runs as a regular user, which is why the CLI
 * uses it for discovery of PPD-capable printers.
 */
export function parseDriverlessList(output: string): DriverlessEntry[] {
  const out: DriverlessEntry[] = [];
  for (const line of output.split('\n')) {
    const m = /^"(driverless:(\S+))"\s+\S+\s+"([^"]*)"\s+"([^"]*)"/.exec(line.trim());
    if (!m) continue;
    out.push({ model: m[1] ?? '', uri: m[2] ?? '', make: m[3] ?? '', description: m[4] ?? '' });
  }
  return out;
}

/**
 * Arguments for creating a queue. `-m everywhere` is deliberately not used:
 * on Debian 13 (CUPS 2.5) it creates the queue without a PPD, printing then
 * "succeeds" while the printer emits the PDF source as text. The
 * `driverless:<uri>` model makes cups-filters generate a real PPD.
 *
 * `-E` must follow `-p`: before it, it means "encrypt the connection".
 */
export function lpadminAddArgs(name: string, uri: string, model: string): string[] {
  return ['-p', name, '-E', '-v', uri, '-m', model];
}

export function lpadminDefaultArgs(name: string): string[] {
  return ['-d', name];
}

export function lpadminRemoveArgs(name: string): string[] {
  return ['-x', name];
}

export function lpTestPageArgs(name: string): string[] {
  return ['-d', name, TEST_PAGE];
}

/**
 * Arguments for `cancel`: one job by its `<queue>-<id>` request id, or every
 * job on the queue. `-a` needs root even for the caller's own jobs (it is the
 * IPP purge-jobs operation), so the app types that form with `sudo`.
 */
export function cancelArgs(name: string, job: number | null): string[] {
  return job === null ? ['-a', name] : [`${name}-${job}`];
}

/**
 * Whether a device URI points at this host. Compares the host part
 * case-insensitively because mDNS names are case-preserving but not
 * case-sensitive, and printers themselves vary the case.
 */
/**
 * The mDNS service name inside a DNS-SD style URI
 * (`ipps://Example%20L1234._ipps._tcp.local/` → `Example L1234`), or `null`
 * for a plain host URI.
 */
export function driverlessServiceName(uri: string): string | null {
  const m = /^[a-z]+:\/\/([^/]+?)\.?_ipps?\._tcp\.local\.?(?:[/:]|$)/i.exec(uri);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function uriHost(uri: string): string | null {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(uri);
  return m ? (m[1] ?? '').toLowerCase() : null;
}
