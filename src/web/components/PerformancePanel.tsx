import { useEffect } from 'preact/hooks';
import type { PerfSample } from '../../shared/types.js';
import { describeClock, formatMiB } from '../../status/summary.js';
import { perf, setPowerProfile, watchLive } from '../state.js';
import { Card, Row } from './StatusPanel.jsx';

/**
 * Live view of the host, like a task manager: one `btl-status perf` sample
 * every couple of seconds while this panel is open, nothing when it is not.
 * The power profile select is the one control; everything else is read.
 */
export function PerformancePanel() {
  useEffect(() => {
    watchLive('perf', true);
    return () => watchLive('perf', false);
  }, []);
  const sample = perf.value;
  return (
    <section class="pane panel">
      <header>
        <span class="title">Performance</span>
        <span class="meta">
          {sample ? `sampled ${new Date(sample.at).toLocaleTimeString()}` : 'sampling…'}
        </span>
      </header>
      <div class="content">
        <Performance sample={sample} />
      </div>
    </section>
  );
}

/** Live one-second samples, like a task manager; shown only while this panel is open. */
function Performance({ sample }: { sample: PerfSample | null }) {
  if (!sample) return <p class="empty">Sampling…</p>;
  const m = sample.memory;
  const memPct = m.totalMiB > 0 ? Math.round((m.usedMiB / m.totalMiB) * 100) : 0;
  return (
    <div class="status">
      <Card title="Processor">
        <div class="kv">
          <span class="k">CPU</span>
          <span class="v">
            <Bar percent={sample.cpuPercent} wide /> {sample.cpuPercent} %, load {sample.load1}
            <span class="cores">
              {sample.cores.map((c, i) => (
                <Bar key={i} percent={c} small />
              ))}
            </span>
          </span>
        </div>
        <div class="kv">
          <span class="k">Memory</span>
          <span class="v">
            <Bar percent={memPct} wide /> {formatMiB(m.usedMiB)} of {formatMiB(m.totalMiB)}
            {m.swapUsedMiB > 0 && `, swap ${formatMiB(m.swapUsedMiB)}`}
          </span>
        </div>
        <div class="kv">
          <span class="k">Clock</span>
          <span class="v">
            {describeClock(sample.clock)}
            {sample.clock.maxMHz !== null && sample.clock.currentMHz.length > 0 && (
              <span class="cores">
                {sample.clock.currentMHz.map((mhz, i) => (
                  <Bar key={i} percent={(mhz / (sample.clock.maxMHz ?? mhz)) * 100} small />
                ))}
              </span>
            )}
          </span>
        </div>
        <Row
          k="Temperature"
          v={
            sample.temperature
              ? `${sample.temperature.celsius} °C (${sample.temperature.sensor})`
              : 'no sensor'
          }
          warn={(sample.temperature?.celsius ?? 0) >= 90}
        />
        <div class="kv">
          <span class="k">Power profile</span>
          <span class="v">
            {sample.powerProfile ? (
              <select
                class="mode"
                title="Switch through power-profiles-daemon; remembered across reboots"
                value={sample.powerProfile.active}
                onChange={(e) => void setPowerProfile((e.currentTarget as HTMLSelectElement).value)}
              >
                {sample.powerProfile.available.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              'power-profiles-daemon is not installed; the desktop role installs it'
            )}
          </span>
        </div>
        <Row
          k="In effect"
          v={`platform profile ${sample.policy.platformProfile ?? 'n/a'} · EPP ${sample.policy.energyPreference ?? 'n/a'} · governor ${sample.policy.governor ?? 'n/a'}${sample.policy.onAc === null ? '' : sample.policy.onAc ? ' · on AC' : ' · on battery'}`}
        />
      </Card>
      <Card title="Busiest processes">
        <table class="status procs">
          <tbody>
            {sample.processes.map((p) => (
              <tr key={p.pid}>
                <td class="name">{p.name}</td>
                <td class="mono">{p.pid}</td>
                <td>{p.cpuPercent} %</td>
                <td>{formatMiB(p.rssMiB)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** A horizontal usage bar; `small` is the per-core tick, `wide` the headline one. */
export function Bar({
  percent,
  small,
  wide,
}: {
  percent: number;
  small?: boolean;
  wide?: boolean;
}) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span
      class={`bar inline${small ? ' small' : ''}${wide ? ' wide' : ''}${p >= 90 ? ' hot' : ''}`}
      title={`${p} %`}
    >
      <span style={small ? { height: `${p}%` } : { width: `${p}%` }} />
    </span>
  );
}
