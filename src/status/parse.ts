/**
 * Parsers for the commands and files `btl-status` reads. Pure functions over
 * text, so the odd formats (nmcli's terse mode, findmnt's nested JSON, sysfs
 * one-liners) are covered by tests with captured, anonymised fixtures.
 */
import type {
  DiskUsage,
  FailedUnit,
  NetworkDevice,
  PlaybookRun,
  UnitScope,
  WifiLink,
} from '../shared/types.js';

/** `systemctl list-units --state=failed -o json` → units, tagged with their scope. */
export function parseFailedUnits(json: string, scope: UnitScope): FailedUnit[] {
  const list = JSON.parse(json) as { unit?: string; description?: string; sub?: string }[];
  if (!Array.isArray(list)) return [];
  return list
    .filter((u) => typeof u.unit === 'string')
    .map((u) => ({
      unit: u.unit as string,
      description: u.description ?? '',
      sub: u.sub ?? 'failed',
      scope,
    }));
}

interface Mount {
  target?: string;
  source?: string;
  fstype?: string;
  size?: number;
  used?: number;
  avail?: number;
  children?: Mount[];
}

/** `findmnt -J -b --real -o TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL` → flat list in tree order. */
export function parseMounts(json: string): DiskUsage[] {
  const root = JSON.parse(json) as { filesystems?: Mount[] };
  const out: DiskUsage[] = [];
  const walk = (m: Mount) => {
    if (m.target && typeof m.size === 'number' && m.size > 0) {
      out.push({
        target: m.target,
        source: m.source ?? '',
        fstype: m.fstype ?? '',
        size: m.size,
        used: m.used ?? 0,
        avail: m.avail ?? 0,
      });
    }
    for (const c of m.children ?? []) walk(c);
  };
  for (const m of root.filesystems ?? []) walk(m);
  return out;
}

/**
 * Splits one line of `nmcli -t` output on the colons that are not escaped;
 * values such as MAC addresses and SSIDs carry `\:`.
 */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      i++;
    } else if (ch === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** `nmcli -t -f STATE,CONNECTIVITY general` → `{ state, connectivity }`. */
export function parseNmGeneral(text: string): {
  state: string | null;
  connectivity: string | null;
} {
  const [state, connectivity] = splitTerse(text.trim().split('\n')[0] ?? '');
  return { state: state || null, connectivity: connectivity || null };
}

/**
 * `nmcli -t -f GENERAL.DEVICE,GENERAL.TYPE,GENERAL.HWADDR,GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,IP6.ADDRESS device show`
 * for all devices: blocks of `KEY:value` separated by blank lines. Loopback
 * and Wi-Fi P2P devices are dropped; nobody asks about them.
 */
export function parseNmDevices(text: string): NetworkDevice[] {
  const devices: NetworkDevice[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const fields = new Map<string, string[]>();
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).replace(/\[\d+\]$/, '');
      const value = splitTerse(line.slice(i + 1)).join(':');
      if (value === '') continue;
      fields.set(key, [...(fields.get(key) ?? []), value]);
    }
    const device = fields.get('GENERAL.DEVICE')?.[0];
    const type = fields.get('GENERAL.TYPE')?.[0] ?? '';
    if (!device || type === 'loopback' || type === 'wifi-p2p') continue;
    const stateText = fields.get('GENERAL.STATE')?.[0] ?? '';
    devices.push({
      device,
      type,
      state: /\((.*)\)/.exec(stateText)?.[1]?.replace(/ \(externally\)$/, '') ?? stateText,
      connection: fields.get('GENERAL.CONNECTION')?.[0] ?? null,
      mac: fields.get('GENERAL.HWADDR')?.[0] ?? null,
      ipv4: fields.get('IP4.ADDRESS') ?? [],
      ipv6: (fields.get('IP6.ADDRESS') ?? []).filter((a) => !a.startsWith('fe80:')),
      gateway: fields.get('IP4.GATEWAY')?.[0] ?? null,
      dns: fields.get('IP4.DNS') ?? [],
      speedMbit: null,
      wifi: null,
    });
  }
  return devices;
}

/** `nmcli -t -f ACTIVE,DEVICE,SSID,SIGNAL,FREQ,RATE,SECURITY dev wifi list` → the active link per device. */
export function parseWifiList(text: string): Map<string, WifiLink> {
  const out = new Map<string, WifiLink>();
  for (const line of text.split('\n')) {
    const [active, device, ssid, signal, freq, rate, security] = splitTerse(line);
    if (active !== 'yes' || !device) continue;
    out.set(device, {
      ssid: ssid ?? '',
      signal: Number(signal) || 0,
      frequencyMHz: leadingNumber(freq),
      rateMbit: leadingNumber(rate),
      security: security ?? '',
    });
  }
  return out;
}

function leadingNumber(s: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(s ?? '');
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** `ip -j route show default` → the first default route. */
export function parseDefaultRoute(json: string): { device: string; gateway: string } | null {
  const routes = JSON.parse(json) as { dev?: string; gateway?: string }[];
  const r = routes.find((x) => x.dev && x.gateway);
  return r ? { device: r.dev as string, gateway: r.gateway as string } : null;
}

interface IpLink {
  ifname?: string;
  linkinfo?: { info_kind?: string };
  addr_info?: { family?: string; local?: string; prefixlen?: number; scope?: string }[];
}

/** `ip -j -d addr` → WireGuard interfaces with their global addresses. */
export function parseWireguardLinks(json: string): { ifname: string; addresses: string[] }[] {
  const links = JSON.parse(json) as IpLink[];
  return links
    .filter((l) => l.ifname && l.linkinfo?.info_kind === 'wireguard')
    .map((l) => ({
      ifname: l.ifname as string,
      addresses: (l.addr_info ?? [])
        .filter((a) => a.local && a.scope === 'global')
        .map((a) => `${a.local}/${a.prefixlen}`),
    }));
}

/** `systemctl list-units --all 'wg-quick@*' -o json` → instances with their state. */
export function parseWgUnits(json: string): { unit: string; active: string; sub: string }[] {
  const list = JSON.parse(json) as { unit?: string; active?: string; sub?: string }[];
  return list
    .filter((u) => typeof u.unit === 'string')
    .map((u) => ({ unit: u.unit as string, active: u.active ?? '', sub: u.sub ?? '' }));
}

/**
 * `/etc/ansible/facts.d/btl.fact`, written by the playbook at the end of a
 * run: `{"playbook_run_at": "<ISO 8601>", "playbook": "site.yml", "check_mode": false}`.
 * Anything without a usable timestamp counts as no record.
 */
export function parsePlaybookFact(text: string): PlaybookRun | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const runAt = data.playbook_run_at;
  if (typeof runAt !== 'string' || Number.isNaN(Date.parse(runAt))) return null;
  return {
    runAt,
    playbook: typeof data.playbook === 'string' ? data.playbook : null,
    checkMode: data.check_mode === true,
  };
}

/** `/proc/meminfo` → total and available in MiB. */
export function parseMeminfo(text: string): {
  totalMiB: number | null;
  availableMiB: number | null;
} {
  const get = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m && m[1] !== undefined ? Math.round(Number(m[1]) / 1024) : null;
  };
  return { totalMiB: get('MemTotal'), availableMiB: get('MemAvailable') };
}

/** `/proc/cpuinfo` → the model name of the first CPU. */
export function parseCpuModel(text: string): string | null {
  const m = /^model name\s*:\s*(.+)$/m.exec(text);
  return m && m[1] !== undefined ? m[1].trim() : null;
}

/** `lspci -mm` → the first display controller as `vendor model`. */
export function parseGpu(text: string): string | null {
  for (const line of text.split('\n')) {
    const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
    const cls = cols[0] ?? '';
    if (/VGA|3D|Display/i.test(cls) && cols[1] !== undefined && cols[2] !== undefined) {
      return `${cols[1].replace(/\s*\[.*\]$/, '')} ${cols[2]}`.trim();
    }
  }
  return null;
}

/** `PRETTY_NAME` from os-release. */
export function parseOsRelease(text: string): string | null {
  const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
}
