import type { DiskUsage, FailedUnit, NetworkDevice, SystemStatus } from '../../shared/types.js';
import {
  describeRun,
  formatAgo,
  formatBytes,
  formatDuration,
  formatMiB,
  summaryText,
} from '../../status/summary.js';
import { notify, refreshStatus, runInTerminal, status, statusError } from '../state.js';
import { scannedLabel } from './PrintersPanel.jsx';

/**
 * Read-only view of the machine for the moment support asks "what do you
 * have there": identity, hardware, last configuration run, failed services,
 * disks, network with addresses, VPN. "Copy summary" puts the same facts on
 * the clipboard as one block of text. The one action, showing a failed
 * service's log, is typed into the terminal because the journal needs root.
 */
export function StatusPanel() {
  const s = status.value;
  const error = statusError.value;
  const copy = async () => {
    if (!s) return;
    try {
      await navigator.clipboard.writeText(summaryText(s));
      notify('info', 'Summary copied');
    } catch (e) {
      notify('error', `Could not copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <section class="pane panel">
      <header>
        <span class="title">Status</span>
        <span class="meta">{scannedLabel(s?.scannedAt ?? null)}</span>
        <button
          title="Copy everything below as text, to paste into a chat or an e-mail"
          disabled={!s}
          onClick={() => void copy()}
        >
          Copy summary
        </button>
        <button title="Read everything again" onClick={() => void refreshStatus()}>
          Refresh
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not read the status: <code>{error}</code>
          </p>
        )}
        {!error && !s && <p class="empty">Reading…</p>}
        {s && <StatusBody s={s} />}
      </div>
    </section>
  );
}

function StatusBody({ s }: { s: SystemStatus }) {
  const hw = s.hardware;
  return (
    <div class="status">
      <Card title="This machine">
        <Row k="Name" v={s.host.name} />
        <Row k="System" v={`${s.host.os}, kernel ${s.host.kernel}`} />
        <Row k="Up for" v={formatDuration(s.host.uptimeSeconds)} />
        <Row
          k="Time"
          v={`${s.host.timezone ?? 'unknown zone'}${s.host.ntpSynchronized === null ? '' : s.host.ntpSynchronized ? ', clock synchronized' : ', clock NOT synchronized'}`}
          warn={s.host.ntpSynchronized === false}
        />
        <Row
          k="Last playbook run"
          v={
            s.playbookRuns[0]
              ? `${formatAgo(Date.parse(s.playbookRuns[0].at))} (${new Date(s.playbookRuns[0].at).toLocaleString()}), ${describeRun(s.playbookRuns[0])}`
              : 'no record on this machine'
          }
        />
        {s.playbookRuns.length > 1 && (
          <Row
            k="Earlier runs"
            v={s.playbookRuns
              .slice(1)
              .map((r) => `${new Date(r.at).toLocaleString()} ${describeRun(r)}`)
              .join(' · ')}
          />
        )}
      </Card>
      <Card title="Hardware">
        <Row k="Model" v={[hw.vendor, hw.model].filter(Boolean).join(' ') || 'unknown'} />
        {hw.board && <Row k="Board" v={hw.board} />}
        {hw.biosVersion && (
          <Row k="BIOS" v={`${hw.biosVersion}${hw.biosDate ? ` (${hw.biosDate})` : ''}`} />
        )}
        <Row k="CPU" v={hw.cpu ? `${hw.cpu}, ${hw.cpuCount} threads` : 'unknown'} />
        <Row
          k="Memory"
          v={
            hw.memoryMiB !== null
              ? `${formatMiB(hw.memoryMiB)}${hw.memoryAvailableMiB !== null ? `, ${formatMiB(hw.memoryAvailableMiB)} free` : ''}`
              : 'unknown'
          }
        />
        {hw.gpu && <Row k="Graphics" v={hw.gpu} />}
        {hw.battery && (
          <Row
            k="Battery"
            v={`${hw.battery.percent} %, ${hw.battery.status.toLowerCase()}`}
            warn={hw.battery.percent < 15 && hw.battery.status !== 'Charging'}
          />
        )}
      </Card>
      <Card title="Services">
        {s.failedUnits.length === 0 ? (
          <p class="ok-line">All services are running.</p>
        ) : (
          <table class="status">
            <tbody>
              {s.failedUnits.map((u) => (
                <FailedRow key={`${u.scope}/${u.unit}`} u={u} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Disks">
        <table class="status">
          <tbody>
            {s.disks.map((d) => (
              <DiskRow key={d.target} d={d} />
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Network">
        <Row
          k="State"
          v={`${s.network.state ?? 'unknown'}${s.network.connectivity ? `, internet ${s.network.connectivity}` : ''}`}
          warn={s.network.connectivity !== null && s.network.connectivity !== 'full'}
        />
        <Row
          k="Gateway"
          v={
            s.network.defaultRoute
              ? `${s.network.defaultRoute.gateway} via ${s.network.defaultRoute.device}`
              : 'no default route'
          }
          warn={!s.network.defaultRoute}
        />
        {s.network.devices.map((d) => (
          <DeviceRows key={d.device} d={d} />
        ))}
      </Card>
      <Card title="VPN">
        {s.vpn.tunnels.length === 0 && s.vpn.units.length === 0 && (
          <p class="empty">
            No tunnel is up. A tunnel that is set up but switched off is not visible here.
          </p>
        )}
        {s.vpn.tunnels.map((t) => (
          <Row key={t.ifname} k={t.ifname} v={`up, ${t.addresses.join(' ') || 'no address'}`} />
        ))}
        {s.vpn.units.map((u) => (
          <Row key={u.unit} k={u.unit} v={`${u.active} (${u.sub})`} warn={u.active === 'failed'} />
        ))}
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div class={`kv${warn ? ' warn' : ''}`}>
      <span class="k">{k}</span>
      <span class="v">{v}</span>
    </div>
  );
}

function FailedRow({ u }: { u: FailedUnit }) {
  return (
    <tr>
      <td class="name">
        {u.unit}
        {u.scope === 'user' && <span class="meta"> user</span>}
      </td>
      <td>{u.description}</td>
      <td>
        <span class="chip warn">{u.sub}</span>
      </td>
      <td class="actions">
        <button
          onClick={() => runInTerminal({ action: 'status-log', unit: u.unit, scope: u.scope })}
        >
          Show log
        </button>
      </td>
    </tr>
  );
}

/** Disks above this share of use are flagged; running out of space is the classic silent failure. */
export const DISK_WARN_PERCENT = 90;

function DiskRow({ d }: { d: DiskUsage }) {
  const pct = d.size > 0 ? Math.round((d.used / d.size) * 100) : 0;
  return (
    <tr class={pct >= DISK_WARN_PERCENT ? 'warn' : ''}>
      <td class="name">{d.target}</td>
      <td class="mono">{d.source}</td>
      <td>
        <div class="bar" title={`${pct} % used`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      </td>
      <td>
        {formatBytes(d.avail)} free of {formatBytes(d.size)}
      </td>
    </tr>
  );
}

function DeviceRows({ d }: { d: NetworkDevice }) {
  const parts: string[] = [d.state];
  if (d.connection) parts.push(`"${d.connection}"`);
  if (d.ipv4.length) parts.push(d.ipv4.join(', '));
  if (d.ipv6.length) parts.push(d.ipv6.join(', '));
  if (d.wifi) {
    parts.push(
      `SSID "${d.wifi.ssid}", signal ${d.wifi.signal} %${d.wifi.frequencyMHz ? `, ${d.wifi.frequencyMHz} MHz` : ''}${d.wifi.rateMbit ? `, ${d.wifi.rateMbit} Mbit/s` : ''}`,
    );
  }
  if (d.speedMbit) parts.push(`${d.speedMbit} Mbit/s`);
  if (d.mac) parts.push(`MAC ${d.mac}`);
  if (d.dns.length) parts.push(`DNS ${d.dns.join(', ')}`);
  return (
    <Row
      k={`${d.device} (${d.type})`}
      v={parts.join(' · ')}
      warn={d.state !== 'connected' && d.type !== 'bridge'}
    />
  );
}
