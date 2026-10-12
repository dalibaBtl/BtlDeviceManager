import { describe, expect, it } from 'vitest';
import {
  cancelArgs,
  driverlessServiceName,
  lpadminAddArgs,
  lpadminDefaultArgs,
  lpadminRemoveArgs,
  lpTestPageArgs,
  parseDriverlessList,
  parseLpstat,
  parseLpstatJobs,
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
  const printersLong = [
    'printer Office is idle.  enabled since Sun Oct 11 23:17:20 2026',
    '\tForm mounted:',
    '\tContent types: any',
    '\tAlerts: none',
    '\tLocation: ',
    'printer Busy now printing Busy-12.  enabled since Sun Oct 11 23:17:20 2026',
    '\tForm mounted:',
    '\tAlerts: media-empty-report cups-waiting-for-job-completed',
    'printer Old disabled since Sun Oct 11 23:17:20 2026 -',
    '\tPaused',
    '\tAlerts: paused',
  ].join('\n');
  const jobs = [
    'Busy-12                 alice             1024   Mon Oct 12 13:04:04 2026',
    '\tAlerts: job-printing',
    '\tqueued for Busy',
    'Busy-13                 bob            3000000   Mon Oct 12 13:05:00 2026',
    '\tAlerts: job-hold-until-specified',
    '\tqueued for Busy',
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

  it('reads alerts from the long form and attaches jobs to their queue', () => {
    const q = parseLpstat(devices, printersLong, '', jobs);
    const busy = q[0]!;
    expect(busy.state).toBe('printing');
    expect(busy.reasons).toEqual(['media-empty-report', 'cups-waiting-for-job-completed']);
    expect(busy.jobs.map((j) => [j.id, j.user, j.sizeBytes, j.reasons])).toEqual([
      [12, 'alice', 1024, ['job-printing']],
      [13, 'bob', 3_000_000, ['job-hold-until-specified']],
    ]);
    expect(busy.jobs[0]!.submittedAt).toBe(new Date(2026, 9, 12, 13, 4, 4).getTime());
    expect(q[1]!.reasons).toEqual([]);
    expect(q[1]!.jobs).toEqual([]);
    expect(q[2]!.reasons).toEqual(['paused']);
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

describe('parseLpstatJobs', () => {
  it('splits the request id at the last dash and copes with no jobs', () => {
    const m = parseLpstatJobs('My-Queue-3   carol   10   Mon Oct 12 13:04:04 2026\n');
    expect([...m.keys()]).toEqual(['My-Queue']);
    expect(m.get('My-Queue')![0]!.id).toBe(3);
    expect(parseLpstatJobs('').size).toBe(0);
    expect(parseLpstatJobs('lpstat: No destinations added.\n').size).toBe(0);
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
    expect(cancelArgs('Office', 12)).toEqual(['Office-12']);
    expect(cancelArgs('Office', null)).toEqual(['-a', 'Office']);
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
