// Renders the Printers panel to static HTML with populated state. There is no
// browser in CI, so this is the cheapest way to catch runtime errors in the
// view code and to assert which actions appear for which printer state.
import { render } from 'preact-render-to-string';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Printer } from '../src/shared/types.js';

beforeAll(() => {
  // The API client reads these at import time.
  Object.assign(globalThis, {
    location: { search: '?t=test', origin: 'http://127.0.0.1:1' },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
    },
  });
});

async function load() {
  const state = await import('../src/web/state.js');
  const panel = await import('../src/web/components/PrintersPanel.jsx');
  return { state, ...panel };
}

const found: Printer = {
  id: 'Example_L1234_Series',
  name: 'Example L1234 Series',
  model: 'Example L1234 Series',
  host: 'printer-1234.local',
  ip: '192.0.2.10',
  uri: 'ipp://printer-1234.local:631/ipp/print',
  discovered: true,
  queue: null,
};
const ready: Printer = {
  ...found,
  id: 'Office',
  name: 'Office Printer',
  queue: { name: 'Office', uri: found.uri!, state: 'idle', isDefault: true },
};
const asleep: Printer = {
  id: 'Old',
  name: 'Old',
  model: 'Old',
  host: 'old.local',
  ip: null,
  uri: null,
  discovered: false,
  queue: { name: 'Old', uri: 'ipp://old.local:631/ipp/print', state: 'idle', isDefault: false },
};

describe('PrintersPanel', () => {
  it('explains an empty list after a scan instead of showing nothing', async () => {
    const { state, PrintersPanel } = await load();
    state.printers.value = [];
    state.scannedAt.value = Date.now();
    const html = render(<PrintersPanel />);
    expect(html).toContain('No printers found');
    expect(html).toContain('wake');
  });

  it('shows the CLI error inline', async () => {
    const { state, PrintersPanel } = await load();
    state.printersError.value = 'avahi-browse: command not found';
    const html = render(<PrintersPanel />);
    expect(html).toContain('Could not list printers');
    expect(html).toContain('avahi-browse: command not found');
    state.printersError.value = null;
  });

  it('offers Initialize only to a discovered printer without a queue', async () => {
    const { state, PrintersPanel } = await load();
    state.printers.value = [found];
    const html = render(<PrintersPanel />);
    expect(html).toContain('Initialize');
    expect(html).toContain('Not set up');
    expect(html).not.toContain('Test page');
    expect(html).toContain('192.0.2.10');
  });

  it('offers test page and remove to a default queue, but not Set as default', async () => {
    const { state, PrintersPanel } = await load();
    state.printers.value = [ready];
    const html = render(<PrintersPanel />);
    expect(html).toContain('Default');
    expect(html).toContain('Test page');
    expect(html).toContain('Remove');
    expect(html).not.toContain('Set as default');
    expect(html).not.toContain('Initialize');
    expect(html).toContain('queue Office');
  });

  it('keeps a sleeping printer usable and says it is away', async () => {
    const { state, PrintersPanel } = await load();
    state.printers.value = [asleep];
    const html = render(<PrintersPanel />);
    expect(html).toContain('Not seen on network');
    expect(html).toContain('Set as default');
    expect(html).toContain('No printer answered on the network right now');
    expect(html).not.toContain('Initialize');
  });
});

describe('helpers', () => {
  it('scannedLabel counts seconds then minutes', async () => {
    const { scannedLabel } = await load();
    expect(scannedLabel(null)).toBe('');
    expect(scannedLabel(1000, 13_000)).toBe('scanned 12 s ago');
    expect(scannedLabel(0, 150_000)).toBe('scanned 3 min ago');
  });

  it('printerStatus ranks stopped queues as a warning', async () => {
    const { printerStatus } = await load();
    expect(printerStatus({ ...ready, queue: { ...ready.queue!, state: 'stopped' } }).cls).toBe(
      'warn',
    );
    expect(printerStatus(asleep).cls).toBe('away');
    expect(printerStatus(found).cls).toBe('new');
  });
});
