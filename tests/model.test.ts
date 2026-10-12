import { describe, expect, it } from 'vitest';
import type { DiscoveredPrinter } from '../src/printers/avahi.js';
import { mergePrinters, slug } from '../src/printers/model.js';
import type { PrintQueue } from '../src/shared/types.js';

const example: DiscoveredPrinter = {
  name: 'Example L1234 Series',
  host: 'printer-1234.local',
  ip: '192.0.2.10',
  port: 631,
  model: 'Example L1234 Series',
  uri: 'ipp://printer-1234.local:631/ipp/print',
  family: 'IPv4',
};
const queue = (name: string, uri: string, isDefault = false): PrintQueue => ({
  name,
  uri,
  state: 'idle',
  isDefault,
  reasons: [],
  jobs: [],
});

describe('slug', () => {
  it('produces a CUPS-safe queue name', () => {
    expect(slug('Example L1234 Series')).toBe('Example_L1234_Series');
    expect(slug('  Tiskárna #2 / patro  ')).toBe('Tiskarna_2_patro');
    expect(slug('   ')).toBe('printer');
    expect(slug('x'.repeat(200))).toHaveLength(127);
  });
});

describe('mergePrinters', () => {
  it('matches a queue by host in the device URI and keeps the queue name as id', () => {
    const [p] = mergePrinters(
      [example],
      [queue('OFFICE', 'ipp://PRINTER-1234.local:631/ipp/print', true)],
    );
    expect(p!.id).toBe('OFFICE');
    expect(p!.discovered).toBe(true);
    expect(p!.queue?.isDefault).toBe(true);
  });

  it('matches a queue by ip or by slug', () => {
    expect(
      mergePrinters([example], [queue('X', 'ipp://192.0.2.10/ipp/print')])[0]!.queue?.name,
    ).toBe('X');
    expect(
      mergePrinters(
        [example],
        [queue('example_l1234_series', 'ipp://elsewhere.local/ipp/print')],
      )[0]!.queue?.name,
    ).toBe('example_l1234_series');
  });

  it('lists a discovered printer without a queue under its slug', () => {
    const [p] = mergePrinters([example], []);
    expect(p).toMatchObject({
      id: 'Example_L1234_Series',
      queue: null,
      discovered: true,
      ip: '192.0.2.10',
    });
  });

  it('lists an unmatched queue as not discovered, keeping the host from its URI', () => {
    const out = mergePrinters([example], [queue('Old', 'ipp://old.local:631/ipp/print')]);
    expect(out.map((p) => p.id)).toEqual(['Example_L1234_Series', 'Old']);
    expect(out[1]).toMatchObject({ discovered: false, ip: null, uri: null, host: 'old.local' });
    expect(out[1]!.queue?.name).toBe('Old');
  });
});
