/**
 * Combines what mDNS sees with what CUPS has into the list the UI shows.
 */
import type { DiscoveredPrinter } from './avahi.js';
import { uriHost } from './cups.js';
import type { Printer, PrintQueue } from '../shared/types.js';

/**
 * Turns a service name into a CUPS queue name. CUPS forbids spaces, `/`, `#`
 * and control characters and treats names case-insensitively; everything
 * outside letters, digits, `_` and `-` becomes `_`, runs collapse, and the
 * result is capped at CUPS's 127-character limit.
 */
export function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 127);
  return s || 'printer';
}

/**
 * Merges discovered printers with existing queues. A queue matches a
 * discovered printer when its device URI names the same host or address, or
 * when the queue is called what the printer's slug would be (a queue the app
 * itself created). Queues with no match are listed as not discovered: the
 * printer is asleep, off, or elsewhere, but the queue is still usable.
 */
export function mergePrinters(discovered: DiscoveredPrinter[], queues: PrintQueue[]): Printer[] {
  const unmatched = new Set(queues);
  const out: Printer[] = [];
  for (const d of discovered) {
    const id = slug(d.name);
    const queue =
      queues.find((q) => matchesHost(q, d)) ??
      queues.find((q) => q.name.toLowerCase() === id.toLowerCase());
    if (queue) unmatched.delete(queue);
    out.push({
      id: queue?.name ?? id,
      name: d.name,
      model: d.model,
      host: d.host,
      ip: d.ip,
      uri: d.uri,
      discovered: true,
      queue: queue ?? null,
    });
  }
  for (const q of unmatched) {
    out.push({
      id: q.name,
      name: q.name,
      model: q.name,
      host: uriHost(q.uri),
      ip: null,
      uri: null,
      discovered: false,
      queue: q,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function matchesHost(q: PrintQueue, d: DiscoveredPrinter): boolean {
  const h = uriHost(q.uri);
  return h !== null && (h === d.host.toLowerCase() || h === d.ip.toLowerCase());
}
