/**
 * The status as one block of plain text: what `btl-status list` prints and
 * what the panel's "Copy summary" puts on the clipboard, so the person on
 * the phone with support can paste it instead of reading numbers aloud.
 */
import type { DiskUsage, PlaybookRun, SystemStatus } from '../shared/types.js';

export function summaryText(s: SystemStatus, now: number = Date.now()): string {
  const lines: string[] = [];
  const h = s.host;
  const hw = s.hardware;
  lines.push(`${h.name}  ${h.os}, kernel ${h.kernel}, up ${formatDuration(h.uptimeSeconds)}`);
  lines.push(
    `Hardware: ${[hw.vendor, hw.model].filter(Boolean).join(' ') || 'unknown'}` +
      (hw.biosVersion ? `, BIOS ${hw.biosVersion}` : '') +
      (hw.cpu ? `\n  CPU ${hw.cpu} (${hw.cpuCount} threads)` : '') +
      (hw.memoryMiB !== null ? `, RAM ${formatMiB(hw.memoryMiB)}` : '') +
      (hw.gpu ? `\n  GPU ${hw.gpu}` : '') +
      (hw.battery ? `\n  Battery ${hw.battery.percent} % (${hw.battery.status})` : ''),
  );
  const last = s.playbookRuns[0];
  lines.push(
    last
      ? `Last playbook run: ${formatAgo(Date.parse(last.at), now)}, ${describeRun(last)}`
      : 'Last playbook run: no record on this machine',
  );
  lines.push(
    s.failedUnits.length === 0
      ? 'Services: all running'
      : `Failed services: ${s.failedUnits.map((u) => (u.scope === 'user' ? `${u.unit} (user)` : u.unit)).join(', ')}`,
  );
  for (const d of s.disks) lines.push(`Disk ${d.target}: ${describeDisk(d)}`);
  const n = s.network;
  lines.push(
    `Network: ${n.state ?? 'unknown'}` +
      (n.connectivity ? `, connectivity ${n.connectivity}` : '') +
      (n.defaultRoute
        ? `, gateway ${n.defaultRoute.gateway} via ${n.defaultRoute.device}`
        : ', no default route'),
  );
  for (const d of n.devices) {
    const parts = [`${d.device} (${d.type}) ${d.state}`];
    if (d.connection) parts.push(`"${d.connection}"`);
    if (d.ipv4.length) parts.push(d.ipv4.join(' '));
    if (d.ipv6.length) parts.push(d.ipv6.join(' '));
    if (d.mac) parts.push(`MAC ${d.mac}`);
    if (d.wifi) {
      parts.push(
        `SSID "${d.wifi.ssid}" signal ${d.wifi.signal} %` +
          (d.wifi.frequencyMHz ? `, ${d.wifi.frequencyMHz} MHz` : '') +
          (d.wifi.rateMbit ? `, ${d.wifi.rateMbit} Mbit/s` : '') +
          (d.wifi.security ? `, ${d.wifi.security}` : ''),
      );
    }
    if (d.speedMbit) parts.push(`${d.speedMbit} Mbit/s`);
    if (d.dns.length) parts.push(`DNS ${d.dns.join(' ')}`);
    lines.push(`  ${parts.join(', ')}`);
  }
  const v = s.vpn;
  if (v.tunnels.length === 0 && v.units.length === 0) {
    lines.push('VPN: no tunnel up');
  } else {
    for (const t of v.tunnels)
      lines.push(`VPN ${t.ifname}: up, ${t.addresses.join(' ') || 'no address'}`);
    for (const u of v.units) lines.push(`VPN unit ${u.unit}: ${u.active} (${u.sub})`);
  }
  return lines.join('\n') + '\n';
}

/** `site.yml by jan from 192.0.2.5`, with whatever parts the record has. */
export function describeRun(r: PlaybookRun): string {
  return [r.playbook ?? 'unknown playbook', r.user && `by ${r.user}`, r.from && `from ${r.from}`]
    .filter(Boolean)
    .join(' ');
}

export function describeDisk(d: DiskUsage): string {
  const pct = d.size > 0 ? Math.round((d.used / d.size) * 100) : 0;
  return `${formatBytes(d.avail)} free of ${formatBytes(d.size)} (${pct} % used, ${d.fstype} on ${d.source})`;
}

/** Bytes → `363.4 GB`-style text in decimal units, like `df -h --si` and what vendors print on the box. */
export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

export function formatMiB(mib: number): string {
  return mib >= 1024 ? `${Math.round(mib / 1024)} GiB` : `${mib} MiB`;
}

/** Seconds → `3 d 4 h`, `4 h 12 min`, `12 min`. */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** Timestamp → `2 days ago`, `3 hours ago`, `just now`. */
export function formatAgo(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
