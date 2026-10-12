import { signal } from '@preact/signals';
import type {
  DisplayOutput,
  PerfSample,
  Printer,
  ServerMessage,
  SystemStatus,
  TerminalAction,
  UpdateState,
  VirtualMachine,
  VmSettings,
  VmStats,
  WatchTopic,
} from '../shared/types.js';
import { api, socket } from './api.js';

/**
 * Application state as Preact signals. Server-pushed collections are replaced
 * wholesale on change; components read signals directly and own no server state.
 */

/** The panels in the left navigation; one per feature, in the order they appear. */
export type Panel = 'printers' | 'displays' | 'vm' | 'status' | 'performance';
export const PANELS: { id: Panel; label: string }[] = [
  { id: 'printers', label: 'Printers' },
  { id: 'displays', label: 'Displays' },
  { id: 'vm', label: 'Virtual machine' },
  { id: 'status', label: 'Status' },
  { id: 'performance', label: 'Performance' },
];
export const selectedPanel = signal<Panel>('printers');

export const printers = signal<Printer[]>([]);
/** Epoch milliseconds of the last successful scan; `null` until the first one finishes. */
export const scannedAt = signal<number | null>(null);
/** The CLI's error text when the last scan failed, shown instead of an empty list. */
export const printersError = signal<string | null>(null);
export const scanning = signal(false);

export const displays = signal<DisplayOutput[]>([]);
export const displaysError = signal<string | null>(null);
export const displaysScannedAt = signal<number | null>(null);

export const vms = signal<VirtualMachine[]>([]);
export const vmsError = signal<string | null>(null);
export const vmsScannedAt = signal<number | null>(null);
export const vmSettings = signal<VmSettings>({ workspaces: [] });

export const status = signal<SystemStatus | null>(null);
export const statusError = signal<string | null>(null);

/** Latest live sample while the Status panel is open; `null` before the first arrives. */
export const perf = signal<PerfSample | null>(null);
/** Latest per-guest stats while the Virtual machine panel is open, keyed by domain name. */
export const vmStats = signal<Map<string, VmStats>>(new Map());

const watchCounts = new Map<WatchTopic, number>();

/**
 * Asks the server for a live feed while a component is mounted. Counted per
 * topic so two components may share one subscription, and resent after a
 * reconnect, since the server forgets watchers with the connection.
 */
export function watchLive(topic: WatchTopic, on: boolean): void {
  const n = Math.max(0, (watchCounts.get(topic) ?? 0) + (on ? 1 : -1));
  watchCounts.set(topic, n);
  if ((on && n === 1) || (!on && n === 0)) socket.send({ type: 'watch', topic, on });
}

socket.onOpen(() => {
  for (const [topic, n] of watchCounts) if (n > 0) socket.send({ type: 'watch', topic, on: true });
});

/** Switches the power profile; the next live sample shows the result. */
export function setPowerProfile(profile: string): Promise<void> {
  return guard(() => api.post('/api/status/profile', { profile })).then(() => undefined);
}

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

export function refreshVms(): Promise<void> {
  return guard(() => api.post('/api/vms/refresh')).then(() => undefined);
}

export function refreshStatus(): Promise<void> {
  return guard(() => api.post('/api/status/refresh')).then(() => undefined);
}

/** Sends an action to be typed into this window's terminal. */
/** Where this installation stands against the repository; `null` until the first check. */
export const update = signal<UpdateState | null>(null);
/** A newer build is on disk than the one the server runs; a restart picks it up. */
export const updateBuilt = signal(false);

export function checkForUpdate(): Promise<void> {
  return guard(() => api.post('/api/update/check')).then(() => undefined);
}

/**
 * Asks the server to replace itself with the new build. The socket drops and
 * reconnects on its own; the terminal pane opens a fresh shell when it does.
 */
export function restartApp(): Promise<void> {
  return guard(() => api.post('/api/restart')).then(() => undefined);
}

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
    case 'displays':
      displays.value = msg.items;
      displaysScannedAt.value = msg.scannedAt;
      displaysError.value = msg.error;
      break;
    case 'vms':
      vms.value = msg.items;
      vmsScannedAt.value = msg.scannedAt;
      vmsError.value = msg.error;
      vmSettings.value = msg.settings;
      break;
    case 'status':
      status.value = msg.status;
      statusError.value = msg.error;
      break;
    case 'perf':
      perf.value = msg.sample;
      break;
    case 'vm-stats':
      vmStats.value = new Map(msg.items.map((s) => [s.name, s]));
      break;
    case 'update':
      update.value = msg.state;
      updateBuilt.value = msg.built;
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
