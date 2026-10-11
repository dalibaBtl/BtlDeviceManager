/**
 * Parsers for CUPS command output and builders for the commands the CLI runs.
 *
 * Reads go through `lpstat`, which any user may run. Queue changes go through
 * `lpadmin`, which needs the `lpadmin` group or root; the CLI is run under
 * `sudo` for those, typed into the terminal by the app so the user sees it.
 */
import type { PrintQueue, QueueState } from '../shared/types.js';

/** Absolute path: `/usr/sbin` is not on a regular user's PATH on Debian. */
export const LPADMIN = '/usr/sbin/lpadmin';
/** The cups-filters PPD generator; also lists reachable IPP Everywhere printers. */
export const DRIVERLESS = '/usr/lib/cups/driver/driverless';
/** Test page shipped with CUPS. */
export const TEST_PAGE = '/usr/share/cups/data/testprint';

/**
 * Parses `lpstat -v` (device URIs), `lpstat -p` (states) and `lpstat -d`
 * (default destination) into queues. All three outputs can be passed as
 * printed with `LC_ALL=C`; queues without a device line are skipped because
 * `lpstat -p` alone cannot tell where they print.
 */
export function parseLpstat(devices: string, printers: string, defaultDest: string): PrintQueue[] {
  const def = /system default destination:\s*(\S+)/.exec(defaultDest)?.[1] ?? null;
  const states = new Map<string, QueueState>();
  for (const line of printers.split('\n')) {
    const m = /^printer (\S+) (?:is|disabled|now)\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    states.set(m[1] ?? '', queueState(line));
  }
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
    });
  }
  return queues.sort((a, b) => a.name.localeCompare(b.name));
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
 * Whether a device URI points at this host. Compares the host part
 * case-insensitively because mDNS names are case-preserving but not
 * case-sensitive, and printers themselves vary the case.
 */
export function uriHost(uri: string): string | null {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(uri);
  return m ? (m[1] ?? '').toLowerCase() : null;
}
