import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSteps } from '../src/server/main.js';
import { printersCommand } from '../src/server/paths.js';
import type { Printer, VirtualMachine } from '../src/shared/types.js';

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
const known = { printers: [discovered, withQueue], vms: [], failedUnits: [] };
const ctx = (printers: string) => ({
  printers,
  displays: '/x/cli/btl-displays.js',
  vm: '/x/cli/btl-vm.js',
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
        {
          printers: [{ ...discovered, id: 'asleep', discovered: false }],
          vms: [],
          failedUnits: [],
        },
        ctx('x'),
      ),
    ).toThrow(/not seen/);
  });
});

describe('buildSteps for displays', () => {
  const layouts = mkdtempSync(path.join(tmpdir(), 'btldm-layouts-'));
  const file = path.join(layouts, 'layout-1.json');
  writeFileSync(file, '{}');
  const c = { ...ctx('btl-printers'), layouts };
  const none = { printers: [], vms: [], failedUnits: [] };

  it('applies only a layout file from the server directory', () => {
    expect(buildSteps({ action: 'display-apply', file }, none, c)).toEqual([
      `/x/cli/btl-displays.js apply '${file}'`,
    ]);
    expect(() => buildSteps({ action: 'display-apply', file: '/etc/passwd' }, none, c)).toThrow(
      /not prepared/,
    );
    expect(() =>
      buildSteps({ action: 'display-apply', file: path.join(layouts, 'missing.json') }, none, c),
    ).toThrow(/not prepared/);
    expect(() =>
      buildSteps(
        { action: 'display-apply', file: path.join(layouts, '..', 'layout-1.json') },
        none,
        c,
      ),
    ).toThrow(/not prepared/);
  });
});

describe('buildSteps for virtual machines', () => {
  const off: VirtualMachine = {
    name: 'Example VM',
    id: null,
    state: 'shut off',
    cpus: 4,
    memoryMiB: 16384,
    autostart: false,
    persistent: true,
    consoleWorkspace: null,
  };
  const up: VirtualMachine = { ...off, name: 'up', id: 3, state: 'running' };
  const k = { printers: [], vms: [off, up], failedUnits: [] };
  const c = ctx('btl-printers');

  it('types the CLI without sudo and quotes the name', () => {
    expect(buildSteps({ action: 'vm-start', name: 'Example VM' }, k, c)).toEqual([
      "/x/cli/btl-vm.js start 'Example VM'",
      "/x/cli/btl-vm.js console 'Example VM'",
    ]);
    expect(buildSteps({ action: 'vm-shutdown', name: 'up' }, k, c)).toEqual([
      "/x/cli/btl-vm.js shutdown 'up'",
    ]);
    expect(buildSteps({ action: 'vm-poweroff', name: 'up' }, k, c)).toEqual([
      "/x/cli/btl-vm.js poweroff 'up'",
    ]);
    expect(buildSteps({ action: 'vm-console', name: 'up' }, k, c)).toEqual([
      "/x/cli/btl-vm.js console 'up'",
    ]);
  });

  it('refuses unknown names and actions the state does not allow', () => {
    expect(() => buildSteps({ action: 'vm-start', name: 'nope' }, k, c)).toThrow(/unknown virtual/);
    expect(() => buildSteps({ action: 'vm-start', name: 'up' }, k, c)).toThrow(/is running/);
    expect(() => buildSteps({ action: 'vm-console', name: 'Example VM' }, k, c)).toThrow(
      /start it first/,
    );
    expect(() => buildSteps({ action: 'vm-shutdown', name: 'Example VM' }, k, c)).toThrow(
      /is shut off/,
    );
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

describe('buildSteps for status', () => {
  const failed = [
    { unit: 'example.service', description: 'Example', sub: 'failed', scope: 'system' as const },
    { unit: 'mine.service', description: 'Mine', sub: 'failed', scope: 'user' as const },
  ];
  const k = { printers: [], vms: [], failedUnits: failed };
  const c = ctx('btl-printers');

  it('shows a system log with sudo and a user log without', () => {
    expect(
      buildSteps({ action: 'status-log', unit: 'example.service', scope: 'system' }, k, c),
    ).toEqual(["sudo journalctl -u 'example.service' -n 50 --no-pager"]);
    expect(buildSteps({ action: 'status-log', unit: 'mine.service', scope: 'user' }, k, c)).toEqual(
      ["journalctl --user -u 'mine.service' -n 50 --no-pager"],
    );
  });

  it('refuses a unit the status did not report', () => {
    expect(() =>
      buildSteps({ action: 'status-log', unit: 'ssh.service', scope: 'system' }, k, c),
    ).toThrow(/unknown unit/);
    expect(() =>
      buildSteps({ action: 'status-log', unit: 'mine.service', scope: 'system' }, k, c),
    ).toThrow(/unknown unit/);
  });
});
