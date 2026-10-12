import { describe, expect, it } from 'vitest';
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
} from '../src/status/perf.js';

const STAT_A = `cpu  1000 0 500 8000 100 0 50 0 300 0
cpu0 500 0 250 4000 50 0 25 0 150 0
cpu1 500 0 250 4000 50 0 25 0 150 0
intr 1 2 3
`;
const STAT_B = `cpu  1300 0 600 8200 100 0 50 0 300 0
cpu0 800 0 350 4000 50 0 25 0 150 0
cpu1 500 0 250 4200 50 0 25 0 150 0
`;

describe('cpu', () => {
  it('turns two /proc/stat readings into busy percentages, total and per core', () => {
    const a = parseProcStat(STAT_A);
    const b = parseProcStat(STAT_B);
    expect(a.cores).toHaveLength(2);
    expect(cpuPercent(a.total, b.total)).toBe(67); // 400 busy of 600 elapsed
    expect(cpuPercent(a.cores[0]!, b.cores[0]!)).toBe(100);
    expect(cpuPercent(a.cores[1]!, b.cores[1]!)).toBe(0);
    expect(cpuPercent(a.total, a.total)).toBe(0);
  });

  it('reads load averages', () => {
    expect(parseLoadavg('0.46 0.61 1.00 1/1078 19639\n')).toEqual({ load1: 0.46, load5: 0.61 });
  });
});

describe('memory and sensors', () => {
  it('computes used from total minus available, swap from total minus free', () => {
    const text =
      'MemTotal:       31986476 kB\nMemFree: 1 kB\nMemAvailable:   28330032 kB\nSwapTotal: 2097148 kB\nSwapFree: 1048574 kB\n';
    expect(parseMemoryUsage(text)).toEqual({
      totalMiB: 31237,
      usedMiB: 3571,
      availableMiB: 27666,
      swapUsedMiB: 1024,
    });
  });

  it('prefers the CPU chip, then the ACPI zone, then the hottest reading', () => {
    const nvme = { chip: 'nvme', label: 'Composite', celsius: 29 };
    const acpi = { chip: 'acpitz', label: '', celsius: 34 };
    const gpu = { chip: 'amdgpu', label: 'edge', celsius: 70 };
    const cpu = { chip: 'k10temp', label: 'Tctl', celsius: 61 };
    expect(pickTemperature([nvme, acpi, gpu, cpu])).toEqual({
      celsius: 61,
      sensor: 'k10temp Tctl',
    });
    expect(pickTemperature([nvme, acpi, gpu])).toEqual({ celsius: 34, sensor: 'acpitz' });
    expect(pickTemperature([nvme, gpu])).toEqual({ celsius: 70, sensor: 'amdgpu edge' });
    expect(pickTemperature([])).toBeNull();
  });
});

describe('processes', () => {
  it('parses /proc/[pid]/stat with spaces and parentheses in the name', () => {
    const line =
      '123 (Web Content (x)) S 1 123 123 0 -1 4194304 87 0 0 0 250 50 0 0 20 0 1 0 695905 2658304 364 1 2 3';
    expect(parseProcPidStat(line)).toEqual({ name: 'Web Content (x)', ticks: 300, rssPages: 364 });
    expect(parseProcPidStat('garbage')).toBeNull();
  });

  it('ranks by CPU over the window and skips pids that changed hands', () => {
    const before = new Map<number, ProcSnapshot>([
      [1, { name: 'idle', ticks: 100, rssPages: 10 }],
      [2, { name: 'busy', ticks: 100, rssPages: 1000 }],
      [3, { name: 'gone', ticks: 5, rssPages: 1 }],
      [4, { name: 'old', ticks: 5, rssPages: 1 }],
    ]);
    const after = new Map<number, ProcSnapshot>([
      [1, { name: 'idle', ticks: 101, rssPages: 10 }],
      [2, { name: 'busy', ticks: 200, rssPages: 1000 }],
      [4, { name: 'new', ticks: 90, rssPages: 1 }],
      [5, { name: 'fresh', ticks: 90, rssPages: 1 }],
    ]);
    expect(topProcesses(before, after, 1, 5)).toEqual([
      { pid: 2, name: 'busy', cpuPercent: 100, rssMiB: 4 },
      { pid: 1, name: 'idle', cpuPercent: 1, rssMiB: 0 },
    ]);
    expect(topProcesses(before, after, 1, 1)).toHaveLength(1);
    expect(topProcesses(before, after, 0, 5)).toEqual([]);
  });
});

describe('power profiles', () => {
  it('reads the active profile and the offered ones from powerprofilesctl', () => {
    const list = `  performance:\n    CpuDriver:\tamd_pstate\n    Degraded:   no\n\n* balanced:\n    CpuDriver:\tamd_pstate\n\n  power-saver:\n    CpuDriver:\tamd_pstate\n`;
    expect(parsePowerProfiles('balanced\n', list)).toEqual({
      active: 'balanced',
      available: ['performance', 'balanced', 'power-saver'],
    });
    expect(parsePowerProfiles('', '')).toBeNull();
  });
});
