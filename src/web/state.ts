import { signal } from '@preact/signals';
import type { Printer, ServerMessage, TerminalAction } from '../shared/types.js';
import { api, socket } from './api.js';

/**
 * Application state as Preact signals. Server-pushed collections are replaced
 * wholesale on change; components read signals directly and own no server state.
 */

/** The panels in the left navigation; one per feature, in the order they appear. */
export type Panel = 'printers';
export const PANELS: { id: Panel; label: string }[] = [{ id: 'printers', label: 'Printers' }];
export const selectedPanel = signal<Panel>('printers');

export const printers = signal<Printer[]>([]);
/** Epoch milliseconds of the last successful scan; `null` until the first one finishes. */
export const scannedAt = signal<number | null>(null);
/** The CLI's error text when the last scan failed, shown instead of an empty list. */
export const printersError = signal<string | null>(null);
export const scanning = signal(false);

export interface Notice {
  id: number;
  level: 'info' | 'error';
  text: string;
}
export const notices = signal<Notice[]>([]);
let noticeSeq = 0;

/** Shows a transient message in the corner; errors stay longer. */
export function notify(level: Notice['level'], text: string): void {
  const id = ++noticeSeq;
  notices.value = [...notices.value, { id, level, text }];
  setTimeout(
    () => {
      notices.value = notices.value.filter((n) => n.id !== id);
    },
    level === 'error' ? 8000 : 3500,
  );
}

/** Runs an async action and reports failures as notices instead of unhandled rejections. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    notify('error', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/** Asks the server to rescan; the result arrives over the WebSocket for every window. */
export function refreshPrinters(): Promise<void> {
  return guard(() => api.post('/api/printers/refresh')).then(() => undefined);
}

/** Sends an action to be typed into this window's terminal. */
export function runInTerminal(run: TerminalAction): void {
  socket.send({ type: 'term-run', run });
}

/** Applies a server message to the state. */
export function applyServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'printers':
      printers.value = msg.items;
      scannedAt.value = msg.scannedAt;
      printersError.value = msg.error;
      break;
    case 'scanning':
      scanning.value = msg.scanning;
      break;
    case 'notice':
      notify(msg.level, msg.text);
      break;
    case 'term-data':
    case 'term-exit':
      // Handled by the terminal component.
      break;
  }
}
