/**
 * `btl-status`: the command behind the Status panel.
 *
 *     btl-status list [--json]       everything support asks about, in one read
 *     btl-status perf [--json]       a one-second window: CPU, memory, temperature, top processes, power profile
 *     btl-status set-profile <name>  switch the power profile through power-profiles-daemon
 *
 * Read-only by design (see docs/IDEA.md): it shows what the machine says and
 * changes nothing. Every source is optional: a missing tool or an unreadable
 * file leaves its field empty instead of failing the whole report, because a
 * half-broken machine is exactly when the report is needed.
 *
 * Exit codes: 0 success, 2 usage error.
 */
import { execFile } from 'node:child_process';
import { open, readFile, readdir } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import type {
  NetworkDevice,
  PerfSample,
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
  parsePlaybookRuns,
  parseWgUnits,
  parseWifiList,
  parseWireguardLinks,
} from './parse.js';
import {
  cpuPercent,
  parseLoadavg,
  parseMemoryUsage,
  parsePowerProfiles,
  parseProcPidStat,
  parseProcStat,
  pickTemperature,
  topProcesses,
  type ProcSnapshot,
  type Sensor,
} from './perf.js';
import { describeClock, summaryText } from './summary.js';

const TIMEOUT_MS = 15_000;

/** Where the playbook appends one line per run (the `base` role in btl-infra). */
export const PLAYBOOK_LOG = '/var/log/btl/ansible-runs.jsonl';
/** Only the tail is read; a line is about 130 bytes, so this is years of runs. */
const PLAYBOOK_LOG_TAIL = 64 * 1024;

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
    case 'perf': {
      const sample = await perf();
      process.stdout.write(
        rest.includes('--json') ? JSON.stringify(sample) + '\n' : perfText(sample),
      );
      return 0;
    }
    case 'set-profile': {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) {
        process.stderr.write(`btl-status: missing profile name\n${USAGE}`);
        return 2;
      }
      return setProfile(name);
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

const USAGE = `usage: btl-status list [--json]
       btl-status perf [--json]
       btl-status set-profile <name>
`;

/** Length of the window `perf` measures over. */
const PERF_WINDOW_MS = 1000;
const TOP_PROCESSES = 5;

/**
 * Two readings of the kernel's counters one second apart, so the numbers are
 * what is happening now rather than averages since boot (which is what `ps`
 * reports for CPU). Everything else is read once at the end of the window.
 */
export async function perf(): Promise<PerfSample> {
  const first = await Promise.all([readOrNull('/proc/stat'), readProcesses()]);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, PERF_WINDOW_MS));
  const [stat2, procs2, loadavg, meminfo, sensors, profile, clock, policy] = await Promise.all([
    readOrNull('/proc/stat'),
    readProcesses(),
    readOrNull('/proc/loadavg'),
    readOrNull('/proc/meminfo'),
    readSensors(),
    readPowerProfile(),
    readClock(),
    readPolicy(),
  ]);
  const elapsed = (Date.now() - t0) / 1000;
  const a = parseProcStat(first[0] ?? '');
  const b = parseProcStat(stat2 ?? '');
  return {
    at: Date.now(),
    cpuPercent: cpuPercent(a.total, b.total),
    cores: b.cores.map((c, i) => cpuPercent(a.cores[i] ?? c, c)),
    ...parseLoadavg(loadavg ?? ''),
    memory: parseMemoryUsage(meminfo ?? ''),
    temperature: pickTemperature(sensors),
    processes: topProcesses(first[1], procs2, elapsed, TOP_PROCESSES),
    powerProfile: profile,
    clock,
    policy,
  };
}

const CPU_SYSFS = '/sys/devices/system/cpu';

/** `scaling_cur_freq` of every core (kHz in sysfs), plus the hardware range and whether boost is on. */
async function readClock(): Promise<PerfSample['clock']> {
  let dirs: string[] = [];
  try {
    dirs = (await readdir(CPU_SYSFS)).filter((d) => /^cpu\d+$/.test(d));
  } catch {
    return { currentMHz: [], minMHz: null, maxMHz: null, boost: null };
  }
  dirs.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const mhz = async (file: string) => {
    const n = Number((await readOrNull(file))?.trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
  };
  const current = await Promise.all(
    dirs.map((d) => mhz(`${CPU_SYSFS}/${d}/cpufreq/scaling_cur_freq`)),
  );
  const boost = (await readOrNull(`${CPU_SYSFS}/cpufreq/boost`))?.trim();
  return {
    currentMHz: current.filter((n): n is number => n !== null),
    minMHz: await mhz(`${CPU_SYSFS}/cpu0/cpufreq/cpuinfo_min_freq`),
    maxMHz: await mhz(`${CPU_SYSFS}/cpu0/cpufreq/cpuinfo_max_freq`),
    boost: boost === '1' ? true : boost === '0' ? false : null,
  };
}

/** The knobs behind a power profile, as sysfs shows them right now. */
async function readPolicy(): Promise<PerfSample['policy']> {
  const text = async (file: string) => (await readOrNull(file))?.trim() || null;
  const [governor, energyPreference, platformProfile, ac] = await Promise.all([
    text(`${CPU_SYSFS}/cpu0/cpufreq/scaling_governor`),
    text(`${CPU_SYSFS}/cpu0/cpufreq/energy_performance_preference`),
    text('/sys/firmware/acpi/platform_profile'),
    readAcOnline(),
  ]);
  return { governor, energyPreference, platformProfile, onAc: ac };
}

/** Whether a mains adapter reports itself online; `null` on a machine without one. */
async function readAcOnline(): Promise<boolean | null> {
  let names: string[];
  try {
    names = await readdir('/sys/class/power_supply');
  } catch {
    return null;
  }
  for (const n of names) {
    const type = (await readOrNull(`/sys/class/power_supply/${n}/type`))?.trim();
    if (type !== 'Mains') continue;
    const online = (await readOrNull(`/sys/class/power_supply/${n}/online`))?.trim();
    if (online === '1') return true;
    if (online === '0') return false;
  }
  return null;
}

/** Human form of a sample, for a shell. */
function perfText(s: PerfSample): string {
  const lines = [
    `CPU ${s.cpuPercent} %  (cores: ${s.cores.join(' ')})  load ${s.load1} / ${s.load5}`,
    `Memory ${s.memory.usedMiB} MiB used of ${s.memory.totalMiB} MiB, ${s.memory.availableMiB} MiB available` +
      (s.memory.swapUsedMiB ? `, swap ${s.memory.swapUsedMiB} MiB` : ''),
    s.temperature
      ? `Temperature ${s.temperature.celsius} °C (${s.temperature.sensor})`
      : 'Temperature: no sensor',
    s.clock.currentMHz.length
      ? `Clock ${describeClock(s.clock)}  (cores: ${s.clock.currentMHz.join(' ')} MHz)`
      : 'Clock: cpufreq not exposed',
    `Policy: platform profile ${s.policy.platformProfile ?? '?'}, EPP ${s.policy.energyPreference ?? '?'}, governor ${s.policy.governor ?? '?'}` +
      (s.policy.onAc === null ? '' : s.policy.onAc ? ', on AC' : ', on battery'),
    s.powerProfile
      ? `Power profile ${s.powerProfile.active} (available: ${s.powerProfile.available.join(', ')})`
      : 'Power profile: power-profiles-daemon is not installed',
    ...s.processes.map(
      (p) =>
        `  ${String(p.cpuPercent).padStart(4)} %  ${String(p.rssMiB).padStart(6)} MiB  ${p.name} (${p.pid})`,
    ),
  ];
  return lines.join('\n') + '\n';
}

/** All `/proc/[pid]/stat` files that could be read; a vanished pid is simply absent. */
async function readProcesses(): Promise<Map<number, ProcSnapshot>> {
  const out = new Map<number, ProcSnapshot>();
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        const text = await readOrNull(`/proc/${n}/stat`);
        const snap = text === null ? null : parseProcPidStat(text);
        if (snap) out.set(Number(n), snap);
      }),
  );
  return out;
}

/** Every `temp*_input` under `/sys/class/hwmon`, with the chip name and the input's label. */
async function readSensors(): Promise<Sensor[]> {
  const out: Sensor[] = [];
  let chips: string[];
  try {
    chips = await readdir('/sys/class/hwmon');
  } catch {
    return out;
  }
  await Promise.all(
    chips.map(async (h) => {
      const dir = `/sys/class/hwmon/${h}`;
      const chip = (await readOrNull(`${dir}/name`))?.trim();
      if (!chip) return;
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => /^temp\d+_input$/.test(f));
      } catch {
        return;
      }
      for (const f of files) {
        const raw = Number((await readOrNull(`${dir}/${f}`))?.trim());
        if (!Number.isFinite(raw)) continue;
        const label = (await readOrNull(`${dir}/${f.replace('_input', '_label')}`))?.trim() ?? '';
        out.push({ chip, label, celsius: Math.round(raw / 1000) });
      }
    }),
  );
  return out;
}

async function readPowerProfile() {
  const [get, list] = await Promise.all([
    runOrEmpty('powerprofilesctl', ['get']),
    runOrEmpty('powerprofilesctl', ['list']),
  ]);
  return parsePowerProfiles(get, list);
}

/**
 * Switches the profile through power-profiles-daemon, which polkit lets the
 * user at the keyboard do without root and which remembers the choice across
 * reboots; the sysfs knobs underneath are root-only and forget it.
 */
async function setProfile(name: string): Promise<number> {
  const profile = await readPowerProfile();
  if (!profile) {
    process.stderr.write(
      'btl-status: power-profiles-daemon is not installed; the desktop role in btl-infra installs it\n',
    );
    return 1;
  }
  if (!profile.available.includes(name)) {
    process.stderr.write(
      `btl-status: no profile called ${name}; available: ${profile.available.join(', ')}\n`,
    );
    return 2;
  }
  process.stdout.write(`+ powerprofilesctl set ${name}\n`);
  return new Promise((resolve) => {
    execFile(
      'powerprofilesctl',
      ['set', name],
      { encoding: 'utf8', timeout: TIMEOUT_MS },
      (err, _out, stderr) => {
        if (err) {
          process.stderr.write(`btl-status: ${stderr.trim() || err.message}\n`);
          resolve(1);
        } else resolve(0);
      },
    );
  });
}

/** Reads every source in parallel; each one degrades to empty on its own. */
export async function scan(): Promise<SystemStatus> {
  const [host, hardware, playbookRuns, failedSystem, failedUser, disks, network, vpn] =
    await Promise.all([
      readHost(),
      readHardware(),
      readTail(PLAYBOOK_LOG, PLAYBOOK_LOG_TAIL).then((t) =>
        t === null ? [] : parsePlaybookRuns(t),
      ),
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
    playbookRuns,
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
    user: userInfo().username,
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

/** The last `bytes` of a file, or `null` when it cannot be read. */
async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
