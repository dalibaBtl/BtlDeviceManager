/**
 * `btl-status`: the command behind the Status panel.
 *
 *     btl-status list [--json]     everything support asks about, in one read
 *
 * Read-only by design (see docs/IDEA.md): it shows what the machine says and
 * changes nothing. Every source is optional: a missing tool or an unreadable
 * file leaves its field empty instead of failing the whole report, because a
 * half-broken machine is exactly when the report is needed.
 *
 * Exit codes: 0 success, 2 usage error.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type {
  NetworkDevice,
  NetworkStatus,
  StatusHardware,
  StatusHost,
  SystemStatus,
  VpnStatus,
} from '../shared/types.js';
import {
  parseCpuModel,
  parseDefaultRoute,
  parseFailedUnits,
  parseGpu,
  parseMeminfo,
  parseMounts,
  parseNmDevices,
  parseNmGeneral,
  parseOsRelease,
  parsePlaybookFact,
  parseWgUnits,
  parseWifiList,
  parseWireguardLinks,
} from './parse.js';
import { summaryText } from './summary.js';

const TIMEOUT_MS = 15_000;

/** Where the playbook records its last run; a standard place for local facts. */
export const PLAYBOOK_FACT = '/etc/ansible/facts.d/btl.fact';

/** Entry point used by `cli/btl-status.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'list': {
      const status = await scan();
      process.stdout.write(
        rest.includes('--json') ? JSON.stringify(status) + '\n' : summaryText(status),
      );
      return 0;
    }
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(
        `btl-status: ${command ? `unknown command: ${command}` : 'missing command'}\n${USAGE}`,
      );
      return 2;
  }
}

const USAGE = 'usage: btl-status list [--json]\n';

/** Reads every source in parallel; each one degrades to empty on its own. */
export async function scan(): Promise<SystemStatus> {
  const [host, hardware, playbook, failedSystem, failedUser, disks, network, vpn] =
    await Promise.all([
      readHost(),
      readHardware(),
      readOrNull(PLAYBOOK_FACT).then((t) => (t === null ? null : parsePlaybookFact(t))),
      runOrEmpty('systemctl', ['list-units', '--state=failed', '-o', 'json']).then((t) =>
        t ? parseFailedUnits(t, 'system') : [],
      ),
      runOrEmpty('systemctl', ['--user', 'list-units', '--state=failed', '-o', 'json']).then((t) =>
        t ? parseFailedUnits(t, 'user') : [],
      ),
      runOrEmpty('findmnt', [
        '-J',
        '-b',
        '--real',
        '-o',
        'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL',
      ]).then((t) => (t ? parseMounts(t) : [])),
      readNetwork(),
      readVpn(),
    ]);
  return {
    host,
    hardware,
    playbook,
    failedUnits: [...failedSystem, ...failedUser],
    disks,
    network,
    vpn,
    scannedAt: Date.now(),
  };
}

async function readHost(): Promise<StatusHost> {
  const [osRelease, uptime, kernel, tdc] = await Promise.all([
    readOrNull('/etc/os-release'),
    readOrNull('/proc/uptime'),
    runOrEmpty('uname', ['-r']),
    runOrEmpty('timedatectl', ['show', '-p', 'Timezone', '-p', 'NTPSynchronized']),
  ]);
  return {
    name: hostname(),
    os: (osRelease && parseOsRelease(osRelease)) ?? 'Linux',
    kernel: kernel.trim(),
    uptimeSeconds: Math.floor(Number(uptime?.split(' ')[0]) || 0),
    timezone: /^Timezone=(.+)$/m.exec(tdc)?.[1] ?? null,
    ntpSynchronized: /^NTPSynchronized=(yes|no)$/m.exec(tdc)?.[1]
      ? /^NTPSynchronized=yes$/m.test(tdc)
      : null,
  };
}

async function readHardware(): Promise<StatusHardware> {
  const dmi = (f: string) => readOrNull(`/sys/class/dmi/id/${f}`).then((t) => t?.trim() || null);
  const [vendor, model, board, biosVersion, biosDate, cpuinfo, meminfo, lspci, battery] =
    await Promise.all([
      dmi('sys_vendor'),
      dmi('product_name'),
      dmi('board_name'),
      dmi('bios_version'),
      dmi('bios_date'),
      readOrNull('/proc/cpuinfo'),
      readOrNull('/proc/meminfo'),
      runOrEmpty('lspci', ['-mm']),
      readBattery(),
    ]);
  const mem = parseMeminfo(meminfo ?? '');
  return {
    vendor,
    model,
    board,
    biosVersion,
    biosDate,
    cpu: cpuinfo ? parseCpuModel(cpuinfo) : null,
    cpuCount: cpuinfo ? (cpuinfo.match(/^processor\s*:/gm) ?? []).length : 0,
    memoryMiB: mem.totalMiB,
    memoryAvailableMiB: mem.availableMiB,
    gpu: lspci ? parseGpu(lspci) : null,
    battery,
  };
}

async function readBattery(): Promise<StatusHardware['battery']> {
  let names: string[];
  try {
    names = (await readdir('/sys/class/power_supply')).filter((n) => n.startsWith('BAT'));
  } catch {
    return null;
  }
  const bat = names[0];
  if (!bat) return null;
  const [capacity, status] = await Promise.all([
    readOrNull(`/sys/class/power_supply/${bat}/capacity`),
    readOrNull(`/sys/class/power_supply/${bat}/status`),
  ]);
  const percent = Number(capacity?.trim());
  return Number.isFinite(percent) ? { percent, status: status?.trim() ?? 'unknown' } : null;
}

async function readNetwork(): Promise<NetworkStatus> {
  const [general, devicesText, wifiText, routeJson] = await Promise.all([
    runOrEmpty('nmcli', ['-t', '-f', 'STATE,CONNECTIVITY', 'general']),
    runOrEmpty('nmcli', [
      '-t',
      '-f',
      'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.HWADDR,GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,IP6.ADDRESS',
      'device',
      'show',
    ]),
    runOrEmpty('nmcli', [
      '-t',
      '-f',
      'ACTIVE,DEVICE,SSID,SIGNAL,FREQ,RATE,SECURITY',
      'dev',
      'wifi',
      'list',
      '--rescan',
      'no',
    ]),
    runOrEmpty('ip', ['-j', 'route', 'show', 'default']),
  ]);
  const wifi = parseWifiList(wifiText);
  const devices: NetworkDevice[] = await Promise.all(
    parseNmDevices(devicesText).map(async (d) => ({
      ...d,
      wifi: wifi.get(d.device) ?? null,
      speedMbit: d.type === 'ethernet' ? await readSpeed(d.device) : null,
    })),
  );
  return {
    ...parseNmGeneral(general),
    defaultRoute: routeJson ? parseDefaultRoute(routeJson) : null,
    devices,
  };
}

/** Link speed of a wired device; sysfs says `-1` or nothing when there is no link. */
async function readSpeed(device: string): Promise<number | null> {
  const t = await readOrNull(`/sys/class/net/${device}/speed`);
  const n = Number(t?.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readVpn(): Promise<VpnStatus> {
  const [addr, units] = await Promise.all([
    runOrEmpty('ip', ['-j', '-d', 'addr']),
    runOrEmpty('systemctl', ['list-units', '--all', '-o', 'json', 'wg-quick@*']),
  ]);
  return {
    tunnels: addr ? parseWireguardLinks(addr) : [],
    units: units ? parseWgUnits(units) : [],
  };
}

// ---- helpers ----------------------------------------------------------------

/** stdout of a command, or an empty string when it is missing or fails: every source is optional. */
function runOrEmpty(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
