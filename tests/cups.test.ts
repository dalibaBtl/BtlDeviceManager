import { describe, expect, it } from 'vitest';
import {
  driverlessServiceName,
  lpadminAddArgs,
  lpadminDefaultArgs,
  lpadminRemoveArgs,
  lpTestPageArgs,
  parseDriverlessList,
  parseLpstat,
  uriHost,
} from '../src/printers/cups.js';

describe('parseLpstat', () => {
  const devices = [
    'device for Office: ipp://printer-1234.local:631/ipp/print',
    'device for Old: socket://192.0.2.20:9100',
    'device for Busy: ipp://busy.local:631/ipp/print',
  ].join('\n');
  const printers = [
    'printer Office is idle.  enabled since Sun 11 Oct 2026 16:54:57 CEST',
    'printer Old disabled since Sun 11 Oct 2026 16:54:57 CEST -',
    '\tPaused',
    'printer Busy now printing Busy-12.  enabled since Sun 11 Oct 2026 16:54:57 CEST',
  ].join('\n');

  it('joins device, state and default', () => {
    const q = parseLpstat(devices, printers, 'system default destination: Office\n');
    expect(q.map((x) => [x.name, x.state, x.isDefault])).toEqual([
      ['Busy', 'printing', false],
      ['Office', 'idle', true],
      ['Old', 'stopped', false],
    ]);
    expect(q[1]!.uri).toBe('ipp://printer-1234.local:631/ipp/print');
  });

  it('handles no default and no queues', () => {
    expect(parseLpstat(devices, printers, 'no system default destination\n')[1]!.isDefault).toBe(
      false,
    );
    expect(parseLpstat('lpstat: No destinations added.\n', '', '')).toEqual([]);
  });
});

describe('parseDriverlessList', () => {
  it('extracts model, uri, make and description', () => {
    const out =
      '"driverless:ipp://printer-1234.local:631/ipp/print" en "Example" "Example L1234 Series, driverless, cups-filters 2.0.1" "MFG:Example;MDL:L1234 Series;CMD:PDF;"\n';
    expect(parseDriverlessList(out)).toEqual([
      {
        model: 'driverless:ipp://printer-1234.local:631/ipp/print',
        uri: 'ipp://printer-1234.local:631/ipp/print',
        make: 'Example',
        description: 'Example L1234 Series, driverless, cups-filters 2.0.1',
      },
    ]);
  });

  it('ignores debug chatter', () => {
    expect(parseDriverlessList('DEBUG: Started ippfind (PID 1)\n')).toEqual([]);
  });
});

describe('lpadmin arguments', () => {
  it('creates queues with a driverless model, never "everywhere"', () => {
    const args = lpadminAddArgs(
      'Office',
      'ipp://h.local:631/ipp/print',
      'driverless:ipp://h.local:631/ipp/print',
    );
    expect(args).toEqual([
      '-p',
      'Office',
      '-E',
      '-v',
      'ipp://h.local:631/ipp/print',
      '-m',
      'driverless:ipp://h.local:631/ipp/print',
    ]);
    expect(args.indexOf('-E')).toBeGreaterThan(args.indexOf('-p'));
    expect(args).not.toContain('everywhere');
  });

  it('builds the other commands', () => {
    expect(lpadminDefaultArgs('Office')).toEqual(['-d', 'Office']);
    expect(lpadminRemoveArgs('Office')).toEqual(['-x', 'Office']);
    expect(lpTestPageArgs('Office')).toEqual(['-d', 'Office', '/usr/share/cups/data/testprint']);
  });
});

describe('uriHost', () => {
  it('lower-cases the host and ignores port and path', () => {
    expect(uriHost('ipp://Printer-1234.LOCAL:631/ipp/print')).toBe('printer-1234.local');
    expect(uriHost('socket://192.0.2.20:9100')).toBe('192.0.2.20');
    expect(uriHost('file:///dev/null')).toBe(null);
  });
});

describe('driverlessServiceName', () => {
  it('decodes the service name from a DNS-SD style URI and ignores host URIs', () => {
    expect(driverlessServiceName('ipps://Example%20L1234%20Series._ipps._tcp.local/')).toBe(
      'Example L1234 Series',
    );
    expect(driverlessServiceName('ipp://Example._ipp._tcp.local:631/ipp/print')).toBe('Example');
    expect(driverlessServiceName('ipp://printer-1234.local:631/ipp/print')).toBeNull();
  });

  it('parses the DNS-SD form of driverless list', () => {
    const line =
      '"driverless:ipps://Example%20L1234%20Series._ipps._tcp.local/" en "Example" "Example L1234 Series, driverless, cups-filters 1.28.17" "MFG:Example;MDL:L1234 Series;CMD:PWGRaster,PWG;"\n';
    expect(parseDriverlessList(line)[0]?.uri).toBe(
      'ipps://Example%20L1234%20Series._ipps._tcp.local/',
    );
  });
});
