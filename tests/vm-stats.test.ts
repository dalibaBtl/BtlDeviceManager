import { describe, expect, it } from 'vitest';
import { parseDomstats, vmStats } from '../src/vm/stats.js';

const A = `Domain: 'win11'
  balloon.current=16777216
  balloon.maximum=16777216
  balloon.rss=17000000
  vcpu.current=4
  vcpu.0.time=1000000000000
  vcpu.1.time=1000000000000
  vcpu.2.time=5000000000
  vcpu.3.time=5000000000

Domain: 'off'
  balloon.current=4194304
  balloon.maximum=4194304
  vcpu.current=2

`;
const B = A.replace('vcpu.0.time=1000000000000', 'vcpu.0.time=1001000000000').replace(
  'vcpu.1.time=1000000000000',
  'vcpu.1.time=1000500000000',
);

describe('btl-vm stats', () => {
  it('parses domstats per domain and keeps only counters it needs', () => {
    const m = parseDomstats(A);
    expect([...m.keys()]).toEqual(['win11', 'off']);
    expect(m.get('win11')).toEqual({
      vcpuNs: [1000000000000, 1000000000000, 5000000000, 5000000000],
      rssKiB: 17000000,
      maxKiB: 16777216,
    });
    expect(m.get('off')).toEqual({ vcpuNs: [], rssKiB: null, maxKiB: 4194304 });
  });

  it('turns two readings into per-vCPU percentages and drops guests that are not running', () => {
    expect(vmStats(parseDomstats(A), parseDomstats(B), 1)).toEqual([
      { name: 'win11', vcpus: [100, 50, 0, 0], cpuPercent: 150, rssMiB: 16602, maxMiB: 16384 },
    ]);
    expect(vmStats(parseDomstats(A), parseDomstats(B), 0)).toEqual([]);
  });
});
