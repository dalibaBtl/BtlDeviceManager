import type { Printer } from '../../shared/types.js';
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
              {items.map((p) => (
                <PrinterRow key={p.id} printer={p} />
              ))}
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
  if (p.queue.isDefault) return { label: 'Default', cls: 'ok' };
  return { label: 'Ready', cls: 'ok' };
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
  return (
    <tr class={p.discovered ? '' : 'away'}>
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
        {p.queue && (
          <button class="quiet" title="Delete the queue" onClick={() => void remove()}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

/** "scanned 12 s ago" style label; exact enough for a one-minute refresh cadence. */
export function scannedLabel(at: number | null, now: number = Date.now()): string {
  if (at === null) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `scanned ${s} s ago`;
  const m = Math.round(s / 60);
  return `scanned ${m} min ago`;
}
