import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSteps } from '../src/server/main.js';
import { printersCommand } from '../src/server/paths.js';
import type { Printer } from '../src/shared/types.js';

const discovered: Printer = {
  id: 'Example_L1234_Series',
  name: 'Example L1234 Series',
  model: 'Example L1234 Series',
  host: 'printer-1234.local',
  ip: '192.0.2.10',
  uri: 'ipp://printer-1234.local:631/ipp/print',
  discovered: true,
  queue: null,
};
const withQueue: Printer = {
  ...discovered,
  id: "it's",
  queue: { name: "it's", uri: discovered.uri!, state: 'idle', isDefault: false },
};
const known = [discovered, withQueue];
const ctx = (printers: string) => ({
  printers,
  displays: '/x/cli/btl-displays.js',
  layouts: '/tmp/none',
});

describe('buildSteps', () => {
  it('types sudo commands with the quoted id', () => {
    expect(
      buildSteps({ action: 'printer-add', id: discovered.id }, known, ctx('btl-printers')),
    ).toEqual(["sudo btl-printers add 'Example_L1234_Series'"]);
    expect(
      buildSteps({ action: 'printer-default', id: "it's" }, known, ctx('btl-printers')),
    ).toEqual(["sudo btl-printers default 'it'\\''s'"]);
    expect(
      buildSteps({ action: 'printer-remove', id: "it's" }, known, ctx('/x/cli/btl-printers.js')),
    ).toEqual(["sudo /x/cli/btl-printers.js remove 'it'\\''s'"]);
  });

  it('prints the test page without sudo', () => {
    expect(buildSteps({ action: 'printer-test', id: "it's" }, known, ctx('btl-printers'))).toEqual([
      "btl-printers test 'it'\\''s'",
    ]);
  });

  it('refuses ids the server has not reported and actions that make no sense', () => {
    expect(() => buildSteps({ action: 'printer-add', id: 'nope' }, known, ctx('x'))).toThrow(
      /unknown printer/,
    );
    expect(() => buildSteps({ action: 'printer-add', id: "it's" }, known, ctx('x'))).toThrow(
      /already has a queue/,
    );
    expect(() =>
      buildSteps({ action: 'printer-test', id: discovered.id }, known, ctx('x')),
    ).toThrow(/no queue/);
    expect(() =>
      buildSteps(
        { action: 'printer-add', id: 'asleep' },
        [{ ...discovered, id: 'asleep', discovered: false }],
        ctx('x'),
      ),
    ).toThrow(/not seen/);
  });
});

describe('buildSteps for displays', () => {
  const layouts = mkdtempSync(path.join(tmpdir(), 'btldm-layouts-'));
  const file = path.join(layouts, 'layout-1.json');
  writeFileSync(file, '{}');
  const c = { printers: 'btl-printers', displays: '/x/cli/btl-displays.js', layouts };

  it('applies only a layout file from the server directory', () => {
    expect(buildSteps({ action: 'display-apply', file }, [], c)).toEqual([
      `/x/cli/btl-displays.js apply '${file}'`,
    ]);
    expect(() => buildSteps({ action: 'display-apply', file: '/etc/passwd' }, [], c)).toThrow(
      /not prepared/,
    );
    expect(() =>
      buildSteps({ action: 'display-apply', file: path.join(layouts, 'missing.json') }, [], c),
    ).toThrow(/not prepared/);
    expect(() =>
      buildSteps(
        { action: 'display-apply', file: path.join(layouts, '..', 'layout-1.json') },
        [],
        c,
      ),
    ).toThrow(/not prepared/);
  });
});

describe('printersCommand', () => {
  const cli = '/home/u/dev/BtlDeviceManager/cli/btl-printers.js';

  it('uses the short name when /usr/local/bin links to this clone', () => {
    const links: Record<string, string> = { '/usr/local/bin/btl-printers': cli, [cli]: cli };
    expect(printersCommand(cli, (p) => links[p] ?? null)).toBe('btl-printers');
  });

  it('falls back to the absolute path when the link is missing or points elsewhere', () => {
    expect(printersCommand(cli, (p) => (p === cli ? cli : null))).toBe(cli);
    const other: Record<string, string> = {
      '/usr/local/bin/btl-printers': '/opt/other.js',
      [cli]: cli,
    };
    expect(printersCommand(cli, (p) => other[p] ?? null)).toBe(cli);
  });
});
