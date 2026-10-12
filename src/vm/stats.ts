/**
 * Pure part of `btl-vm stats`: parsing `virsh domstats --vcpu --balloon` and
 * turning two readings into per-vCPU percentages.
 */
import type { VmStats } from '../shared/types.js';

export interface DomainCounters {
  /** Cumulative CPU nanoseconds per vCPU; empty for a guest that is not running. */
  vcpuNs: number[];
  /** `balloon.rss` in KiB when the guest runs, else `null`. */
  rssKiB: number | null;
  /** `balloon.maximum` in KiB. */
  maxKiB: number;
}

/**
 * `virsh domstats` prints `Domain: 'name'` followed by indented `key=value`
 * lines. Only the counters needed here are kept.
 */
export function parseDomstats(text: string): Map<string, DomainCounters> {
  const out = new Map<string, DomainCounters>();
  let cur: DomainCounters | null = null;
  for (const raw of text.split('\n')) {
    const dom = /^Domain:\s+'(.*)'\s*$/.exec(raw);
    if (dom && dom[1] !== undefined) {
      cur = { vcpuNs: [], rssKiB: null, maxKiB: 0 };
      out.set(dom[1], cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s*([\w.]+)=(.*)$/.exec(raw);
    if (!kv || kv[1] === undefined || kv[2] === undefined) continue;
    const [, key, value] = kv;
    const n = Number(value);
    const vcpu = /^vcpu\.(\d+)\.time$/.exec(key);
    if (vcpu && vcpu[1] !== undefined) cur.vcpuNs[Number(vcpu[1])] = n;
    else if (key === 'balloon.rss') cur.rssKiB = n;
    else if (key === 'balloon.maximum') cur.maxKiB = n;
  }
  return out;
}

/** Per-vCPU busy share between two readings; guests without vCPU counters (not running) are left out. */
export function vmStats(
  before: Map<string, DomainCounters>,
  after: Map<string, DomainCounters>,
  elapsedSeconds: number,
): VmStats[] {
  const out: VmStats[] = [];
  if (elapsedSeconds <= 0) return out;
  for (const [name, b] of after) {
    const a = before.get(name);
    if (!a || b.vcpuNs.length === 0) continue;
    const vcpus = b.vcpuNs.map((ns, i) =>
      Math.max(
        0,
        Math.min(100, Math.round(((ns - (a.vcpuNs[i] ?? ns)) / 1e9 / elapsedSeconds) * 100)),
      ),
    );
    out.push({
      name,
      vcpus,
      cpuPercent: vcpus.reduce((x, y) => x + y, 0),
      rssMiB: b.rssKiB === null ? null : Math.round(b.rssKiB / 1024),
      maxMiB: Math.round(b.maxKiB / 1024),
    });
  }
  return out;
}
