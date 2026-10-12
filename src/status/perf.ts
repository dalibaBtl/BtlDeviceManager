/**
 * Pure parts of `btl-status perf`: parsers for the kernel's counters and the
 * arithmetic that turns two samples into percentages. The CLI takes the
 * samples; nothing here touches the system, so the maths is tested on
 * captured text.
 */
import type { PowerProfile, ProcessLoad } from '../shared/types.js';

/** Jiffies per second on Linux x86; `/proc/[pid]/stat` times are in these. */
export const CLK_TCK = 100;

export interface CpuTimes {
  busy: number;
  idle: number;
}

/** `/proc/stat` → the aggregate line and one entry per core, in kernel order. */
export function parseProcStat(text: string): { total: CpuTimes; cores: CpuTimes[] } {
  let total: CpuTimes = { busy: 0, idle: 0 };
  const cores: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    const m = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!m || m[2] === undefined) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    // user nice system idle iowait irq softirq steal; guest time is already inside user.
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    const busy = (f[0] ?? 0) + (f[1] ?? 0) + (f[2] ?? 0) + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0);
    if (m[1] === '') total = { busy, idle };
    else cores.push({ busy, idle });
  }
  return { total, cores };
}

/** Busy share between two readings of the same counter, 0–100; 0 when nothing elapsed. */
export function cpuPercent(before: CpuTimes, after: CpuTimes): number {
  const busy = after.busy - before.busy;
  const all = busy + (after.idle - before.idle);
  return all > 0 ? Math.round((busy / all) * 100) : 0;
}

/** `/proc/loadavg` → the one- and five-minute averages. */
export function parseLoadavg(text: string): { load1: number; load5: number } {
  const [a, b] = text.trim().split(/\s+/);
  return { load1: Number(a) || 0, load5: Number(b) || 0 };
}

/** `/proc/meminfo` → the numbers people ask about, in MiB. */
export function parseMemoryUsage(text: string): {
  totalMiB: number;
  usedMiB: number;
  availableMiB: number;
  swapUsedMiB: number;
} {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m && m[1] !== undefined ? Number(m[1]) : 0;
  };
  const mib = (n: number) => Math.round(n / 1024);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return {
    totalMiB: mib(total),
    usedMiB: mib(Math.max(0, total - available)),
    availableMiB: mib(available),
    swapUsedMiB: mib(Math.max(0, kb('SwapTotal') - kb('SwapFree'))),
  };
}

export interface Sensor {
  /** hwmon chip name, e.g. `k10temp`, `acpitz`, `nvme`. */
  chip: string;
  label: string;
  celsius: number;
}

/** Chips that measure the CPU itself, in order of preference. */
const CPU_CHIPS = ['k10temp', 'zenpower', 'coretemp'];

/**
 * The temperature to show: the CPU chip when the kernel exposes one, else
 * the ACPI thermal zone (what a laptop's firmware thinks), else the hottest
 * reading of all. The chip name travels along so the number is not mistaken
 * for something it is not.
 */
export function pickTemperature(sensors: Sensor[]): { celsius: number; sensor: string } | null {
  const by = (pred: (s: Sensor) => boolean) => {
    const hits = sensors.filter(pred);
    if (hits.length === 0) return null;
    const hot = hits.reduce((a, b) => (b.celsius > a.celsius ? b : a));
    return { celsius: hot.celsius, sensor: hot.label ? `${hot.chip} ${hot.label}` : hot.chip };
  };
  for (const chip of CPU_CHIPS) {
    const hit = by((s) => s.chip === chip);
    if (hit) return hit;
  }
  return by((s) => s.chip === 'acpitz') ?? by(() => true);
}

export interface ProcSnapshot {
  name: string;
  /** utime + stime in jiffies. */
  ticks: number;
  rssPages: number;
}

/**
 * `/proc/[pid]/stat` → name and CPU ticks. The command name sits in
 * parentheses and may contain spaces or parentheses itself, so the line is
 * split at the last `)`; the fields after it start with the state.
 */
export function parseProcPidStat(text: string): ProcSnapshot | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); utime is field 14, stime 15, rss 24.
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rss = Number(rest[21]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { name: text.slice(open + 1, close), ticks: utime + stime, rssPages: rss || 0 };
}

/**
 * Busiest processes between two snapshots. A pid that appeared or vanished
 * inside the window is skipped: half a window says nothing useful.
 */
export function topProcesses(
  before: Map<number, ProcSnapshot>,
  after: Map<number, ProcSnapshot>,
  elapsedSeconds: number,
  limit: number,
  pageSizeBytes: number = 4096,
): ProcessLoad[] {
  const out: ProcessLoad[] = [];
  if (elapsedSeconds <= 0) return out;
  for (const [pid, b] of after) {
    const a = before.get(pid);
    if (!a || a.name !== b.name) continue;
    const cpuPercent = Math.round(((b.ticks - a.ticks) / CLK_TCK / elapsedSeconds) * 100);
    out.push({
      pid,
      name: b.name,
      cpuPercent,
      rssMiB: Math.round((b.rssPages * pageSizeBytes) / 1048576),
    });
  }
  return out.sort((x, y) => y.cpuPercent - x.cpuPercent || y.rssMiB - x.rssMiB).slice(0, limit);
}

/**
 * `powerprofilesctl get` (one word) and `powerprofilesctl list`, whose
 * profile lines are `name:` or `* name:` for the active one, followed by
 * indented details that are ignored.
 */
export function parsePowerProfiles(getOut: string, listOut: string): PowerProfile | null {
  const active = getOut.trim();
  const available: string[] = [];
  for (const line of listOut.split('\n')) {
    const m = /^\s*\*?\s*([a-z][\w-]*):\s*$/.exec(line);
    if (m && m[1] !== undefined && !available.includes(m[1])) available.push(m[1]);
  }
  if (!active && available.length === 0) return null;
  return { active: active || (available[0] ?? ''), available };
}
