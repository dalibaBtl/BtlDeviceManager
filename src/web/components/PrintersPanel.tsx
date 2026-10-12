import type { PrintJob, Printer } from '../../shared/types.js';
import {
  printers,
  printersError,
  refreshPrinters,
  runInTerminal,
  scannedAt,
  scanning,
} from '../state.js';
import { askConfirm } from './Dialogs.jsx';

/**
 * Printers found on the network and queues set up on this machine, with the
 * actions a user needs: set up, make default, test, remove. Every action is
 * typed into the terminal; this panel never changes the system itself.
 */
export function PrintersPanel() {
  const items = printers.value;
  const error = printersError.value;
  return (
    <section class="pane panel">
      <header>
        <span class="title">Printers</span>
        <span class="meta">{scanning.value ? 'scanning…' : scannedLabel(scannedAt.value)}</span>
        <button
          title="Look for printers again"
          disabled={scanning.value}
          onClick={() => void refreshPrinters()}
        >
          Refresh
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not list printers: <code>{error}</code>
          </p>
        )}
        {!error && items.length === 0 && scannedAt.value !== null && (
          <p class="empty">
            No printers found. Printers go to sleep and drop off the network after a while; wake one
            up and press Refresh.
          </p>
        )}
        {!error && items.length === 0 && scannedAt.value === null && !scanning.value && (
          <p class="empty">Waiting for the first scan…</p>
        )}
        {items.length > 0 && (
          <table class="printers">
            <thead>
              <tr>
                <th>Printer</th>
                <th>Model</th>
                <th>Address</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => [
                <PrinterRow key={p.id} printer={p} />,
                ...(p.queue?.jobs ?? []).map((j) => (
                  <JobRow key={`${p.id}-${j.id}`} printer={p} job={j} />
                )),
              ])}
            </tbody>
          </table>
        )}
        {items.length > 0 && !items.some((p) => p.discovered) && (
          <p class="empty">
            No printer answered on the network right now; the queues above are still usable once the
            printer wakes up.
          </p>
        )}
      </div>
    </section>
  );
}

/** Status of one printer in words and a CSS class, in the order a user cares about. */
export function printerStatus(p: Printer): { label: string; cls: string } {
  if (!p.queue) return { label: 'Not set up', cls: 'new' };
  if (!p.discovered) return { label: 'Not seen on network', cls: 'away' };
  if (p.queue.state === 'stopped') return { label: 'Queue stopped', cls: 'warn' };
  const alert = p.queue.reasons.map(describeReason).find((r) => r !== null);
  if (alert) return { label: alert, cls: 'warn' };
  if (p.queue.state === 'printing') return { label: 'Printing', cls: 'ok' };
  const n = p.queue.jobs.length;
  if (n > 0) return { label: `${n} job${n === 1 ? '' : 's'} waiting`, cls: 'warn' };
  if (p.queue.isDefault) return { label: 'Default', cls: 'ok' };
  return { label: 'Ready', cls: 'ok' };
}

/**
 * The printer-state-reasons a user can act on, in plain words. Anything else
 * (`cups-waiting-for-job-completed`, vendor-specific keywords) is left to the
 * CLI output, where support can read the raw keyword.
 */
export function describeReason(reason: string): string | null {
  const key = reason.replace(/-(report|warning|error)$/, '');
  switch (key) {
    case 'media-empty':
    case 'media-needed':
      return 'Out of paper';
    case 'media-jam':
      return 'Paper jam';
    case 'toner-empty':
    case 'marker-supply-empty':
      return 'Out of ink';
    case 'toner-low':
    case 'marker-supply-low':
      return 'Ink low';
    case 'cover-open':
    case 'door-open':
      return 'Cover open';
    case 'offline':
    case 'connecting-to-device':
      return 'Printer unreachable';
    case 'paused':
      return 'Paused';
    default:
      return null;
  }
}

function PrinterRow({ printer: p }: { printer: Printer }) {
  const status = printerStatus(p);
  const remove = async () => {
    const ok = await askConfirm(
      'Remove queue?',
      `This deletes the queue "${p.queue?.name}" from this machine. The printer itself is not affected and can be set up again.`,
      { okLabel: 'Remove', danger: true },
    );
    if (ok) runInTerminal({ action: 'printer-remove', id: p.id });
  };
  const cancelAll = async () => {
    const n = p.queue?.jobs.length ?? 0;
    const ok = await askConfirm(
      'Cancel all jobs?',
      `This removes all ${n} jobs waiting on "${p.queue?.name}". Anything already sent to the printer may still come out.`,
      { okLabel: 'Cancel all', danger: true },
    );
    if (ok) runInTerminal({ action: 'printer-cancel', id: p.id, job: null });
  };
  return (
    <tr class={`${p.discovered ? '' : 'away'}${p.queue?.jobs.length ? ' has-jobs' : ''}`}>
      <td class="name">
        {p.name}
        {p.queue && p.queue.name !== p.name && <span class="meta"> queue {p.queue.name}</span>}
      </td>
      <td>{p.model}</td>
      <td class="mono">{p.ip ?? p.host ?? '–'}</td>
      <td>
        <span class={`chip ${status.cls}`}>{status.label}</span>
      </td>
      <td class="actions">
        {!p.queue && p.discovered && (
          <button
            class="primary"
            onClick={() => runInTerminal({ action: 'printer-add', id: p.id })}
          >
            Initialize
          </button>
        )}
        {p.queue && !p.queue.isDefault && (
          <button onClick={() => runInTerminal({ action: 'printer-default', id: p.id })}>
            Set as default
          </button>
        )}
        {p.queue && (
          <button onClick={() => runInTerminal({ action: 'printer-test', id: p.id })}>
            Test page
          </button>
        )}
        {p.queue && p.queue.jobs.length > 1 && (
          <button
            class="quiet"
            title="Cancel every job waiting on this queue"
            onClick={() => void cancelAll()}
          >
            Cancel all
          </button>
        )}
        {p.queue && (
          <button class="quiet" title="Delete the queue" onClick={() => void remove()}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

/** One unfinished job under its printer; cancelling it is typed like every other change. */
function JobRow({ printer: p, job: j }: { printer: Printer; job: PrintJob }) {
  const state = j.reasons.includes('job-printing')
    ? 'printing'
    : j.reasons.some((r) => r.startsWith('job-hold'))
      ? 'held'
      : 'waiting';
  return (
    <tr class="job">
      <td class="name">
        <span class="meta">job {j.id}</span>
      </td>
      <td>
        {j.user} · {formatSize(j.sizeBytes)}
      </td>
      <td class="meta">{j.submittedAt === null ? '–' : formatTime(j.submittedAt)}</td>
      <td>
        <span class={`chip ${state === 'printing' ? 'ok' : 'warn'}`}>{state}</span>
      </td>
      <td class="actions">
        <button
          class="quiet"
          title="Remove this job from the queue"
          onClick={() => runInTerminal({ action: 'printer-cancel', id: p.id, job: j.id })}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Time of day for today's jobs, date and time for older ones. */
function formatTime(at: number): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/** "scanned 12 s ago" style label; exact enough for a one-minute refresh cadence. */
export function scannedLabel(at: number | null, now: number = Date.now()): string {
  if (at === null) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `scanned ${s} s ago`;
  const m = Math.round(s / 60);
  return `scanned ${m} min ago`;
}
