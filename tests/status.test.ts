import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '../src/shared/types.js';
import {
  parseCpuModel,
  parseDefaultRoute,
  parseFailedUnits,
  parseGpu,
  parseMeminfo,
  parseMounts,
  parseNmDevices,
  parseNmGeneral,
  parseOsRelease,
  parsePlaybookRuns,
  parseWgUnits,
  parseWifiList,
  parseWireguardLinks,
  splitTerse,
} from '../src/status/parse.js';
import { formatAgo, formatBytes, formatDuration, summaryText } from '../src/status/summary.js';

const NM_DEVICES = `GENERAL.DEVICE:wlp2s0
GENERAL.TYPE:wifi
GENERAL.HWADDR:00:11:22:33:44:55
GENERAL.STATE:100 (connected)
GENERAL.CONNECTION:Example Net
IP4.ADDRESS[1]:192.0.2.71/24
IP4.GATEWAY:192.0.2.1
IP4.DNS[1]:192.0.2.53
IP4.DNS[2]:192.0.2.54
IP6.ADDRESS[1]:fe80::1/64
IP6.ADDRESS[2]:2001:db8::71/64

GENERAL.DEVICE:lo
GENERAL.TYPE:loopback
GENERAL.HWADDR:00:00:00:00:00:00
GENERAL.STATE:100 (connected (externally))
GENERAL.CONNECTION:lo
IP4.ADDRESS[1]:127.0.0.1/8

GENERAL.DEVICE:enp3s0
GENERAL.TYPE:ethernet
GENERAL.HWADDR:00:11:22:33:44:66
GENERAL.STATE:20 (unavailable)
GENERAL.CONNECTION:
IP4.GATEWAY:

GENERAL.DEVICE:p2p-dev-wlp2s0
GENERAL.TYPE:wifi-p2p
GENERAL.STATE:30 (disconnected)
`;

describe('nmcli parsing', () => {
  it('splits terse lines on unescaped colons only', () => {
    expect(splitTerse('yes:Net\\:1:84:00\\:11\\:22')).toEqual(['yes', 'Net:1', '84', '00:11:22']);
  });

  it('reads general state and connectivity', () => {
    expect(parseNmGeneral('connected:full\n')).toEqual({
      state: 'connected',
      connectivity: 'full',
    });
    expect(parseNmGeneral('')).toEqual({ state: null, connectivity: null });
  });

  it('reads devices, drops loopback and p2p, keeps global IPv6 only', () => {
    const devices = parseNmDevices(NM_DEVICES);
    expect(devices.map((d) => d.device)).toEqual(['wlp2s0', 'enp3s0']);
    const wifi = devices[0]!;
    expect(wifi).toMatchObject({
      type: 'wifi',
      state: 'connected',
      connection: 'Example Net',
      mac: '00:11:22:33:44:55',
      ipv4: ['192.0.2.71/24'],
      ipv6: ['2001:db8::71/64'],
      gateway: '192.0.2.1',
      dns: ['192.0.2.53', '192.0.2.54'],
    });
    expect(devices[1]).toMatchObject({ state: 'unavailable', connection: null, ipv4: [], dns: [] });
  });

  it('reads the active wifi link per device', () => {
    const links = parseWifiList(
      'no:wlp2s0:Other:40:2412 MHz:54 Mbit/s:WPA2\nyes:wlp2s0:Example Net:84:5500 MHz:270 Mbit/s:WPA2 WPA3\n',
    );
    expect(links.get('wlp2s0')).toEqual({
      ssid: 'Example Net',
      signal: 84,
      frequencyMHz: 5500,
      rateMbit: 270,
      security: 'WPA2 WPA3',
    });
  });
});

describe('system parsing', () => {
  it('tags failed units with their scope', () => {
    const json =
      '[{"unit":"example.service","load":"loaded","active":"failed","sub":"failed","description":"Example"}]';
    expect(parseFailedUnits(json, 'user')).toEqual([
      { unit: 'example.service', description: 'Example', sub: 'failed', scope: 'user' },
    ]);
    expect(parseFailedUnits('[]', 'system')).toEqual([]);
  });

  it('flattens findmnt output in tree order', () => {
    const json = JSON.stringify({
      filesystems: [
        {
          target: '/',
          source: '/dev/nvme0n1p2',
          fstype: 'ext4',
          size: 1000,
          used: 400,
          avail: 600,
          children: [
            {
              target: '/boot/efi',
              source: '/dev/nvme0n1p1',
              fstype: 'vfat',
              size: 100,
              used: 1,
              avail: 99,
            },
          ],
        },
      ],
    });
    expect(parseMounts(json).map((d) => d.target)).toEqual(['/', '/boot/efi']);
    expect(parseMounts(json)[0]).toMatchObject({ used: 400, avail: 600, fstype: 'ext4' });
  });

  it('reads the default route, wireguard links and wg-quick units', () => {
    expect(parseDefaultRoute('[{"dst":"default","gateway":"192.0.2.1","dev":"wlp2s0"}]')).toEqual({
      device: 'wlp2s0',
      gateway: '192.0.2.1',
    });
    expect(parseDefaultRoute('[]')).toBeNull();
    const links = JSON.stringify([
      {
        ifname: 'wlp2s0',
        addr_info: [{ family: 'inet', local: '192.0.2.71', prefixlen: 24, scope: 'global' }],
      },
      {
        ifname: 'wg0',
        linkinfo: { info_kind: 'wireguard' },
        addr_info: [{ family: 'inet', local: '10.77.0.5', prefixlen: 24, scope: 'global' }],
      },
    ]);
    expect(parseWireguardLinks(links)).toEqual([{ ifname: 'wg0', addresses: ['10.77.0.5/24'] }]);
    expect(
      parseWgUnits('[{"unit":"wg-quick@wg0.service","active":"active","sub":"exited"}]'),
    ).toEqual([{ unit: 'wg-quick@wg0.service', active: 'active', sub: 'exited' }]);
  });

  it('reads playbook runs from the end, skipping broken lines, zone-less as UTC', () => {
    const log = [
      '{"at":"2026-10-01T08:00:00Z","playbook":"Base","user":"jan","from":"192.0.2.5"}',
      'not json',
      '{"playbook":"no timestamp"}',
      '{"at":"2026-10-11T20:55:27","playbook":"Base","user":"jan","from":""}',
      '{"at":"2026-10-11T21:01:27Z","playbook":"Base","user":"jan","from":""}',
      '{"at":"2026-10-11T22:00:0',
    ].join('\n');
    expect(parsePlaybookRuns(log)).toEqual([
      { at: '2026-10-11T21:01:27Z', playbook: 'Base', user: 'jan', from: null },
      { at: '2026-10-11T20:55:27Z', playbook: 'Base', user: 'jan', from: null },
      { at: '2026-10-01T08:00:00Z', playbook: 'Base', user: 'jan', from: '192.0.2.5' },
    ]);
    expect(parsePlaybookRuns(log, 1)).toHaveLength(1);
    expect(parsePlaybookRuns('')).toEqual([]);
  });

  it('reads cpu, memory, gpu and os-release', () => {
    expect(parseCpuModel('processor\t: 0\nmodel name\t: Example CPU 7 445\n')).toBe(
      'Example CPU 7 445',
    );
    expect(parseMeminfo('MemTotal:       31986476 kB\nMemAvailable:   28330032 kB\n')).toEqual({
      totalMiB: 31237,
      availableMiB: 27666,
    });
    expect(
      parseGpu(
        '03:00.0 "Display controller" "Example Vendor, Inc. [EV]" "Model X" -rc0 -p00 "Sub" "Device 1"',
      ),
    ).toBe('Example Vendor, Inc. Model X');
    expect(parseGpu('00:1f.0 "ISA bridge" "V" "M"')).toBeNull();
    expect(
      parseOsRelease('NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n'),
    ).toBe('Debian GNU/Linux 13 (trixie)');
  });
});

export const SAMPLE: SystemStatus = {
  host: {
    name: 'example-station',
    os: 'Debian GNU/Linux 13 (trixie)',
    kernel: '6.12.0',
    uptimeSeconds: 2 * 86400 + 3 * 3600,
    timezone: 'Europe/Prague',
    ntpSynchronized: true,
  },
  hardware: {
    vendor: 'Example',
    model: 'Book 14',
    board: 'B14',
    biosVersion: '1.02',
    biosDate: '01/01/2026',
    cpu: 'Example CPU',
    cpuCount: 8,
    memoryMiB: 16384,
    memoryAvailableMiB: 8000,
    gpu: 'Example GPU',
    battery: { percent: 50, status: 'Discharging' },
  },
  playbookRuns: [],
  failedUnits: [
    { unit: 'example.service', description: 'Example', sub: 'failed', scope: 'system' },
  ],
  disks: [
    { target: '/', source: '/dev/sda1', fstype: 'ext4', size: 100e9, used: 95e9, avail: 5e9 },
  ],
  network: {
    state: 'connected',
    connectivity: 'full',
    defaultRoute: { device: 'wlp2s0', gateway: '192.0.2.1' },
    devices: [
      {
        device: 'wlp2s0',
        type: 'wifi',
        state: 'connected',
        connection: 'Example Net',
        mac: '00:11:22:33:44:55',
        ipv4: ['192.0.2.71/24'],
        ipv6: [],
        gateway: '192.0.2.1',
        dns: ['192.0.2.53'],
        speedMbit: null,
        wifi: {
          ssid: 'Example Net',
          signal: 84,
          frequencyMHz: 5500,
          rateMbit: 270,
          security: 'WPA2',
        },
      },
    ],
  },
  vpn: { tunnels: [], units: [] },
  scannedAt: 0,
};

describe('summary', () => {
  it('puts everything support asks for into one text block', () => {
    const text = summaryText(SAMPLE, Date.parse('2026-10-11T12:00:00Z'));
    expect(text).toContain(
      'example-station  Debian GNU/Linux 13 (trixie), kernel 6.12.0, up 2 d 3 h',
    );
    expect(text).toContain('Hardware: Example Book 14, BIOS 1.02');
    expect(text).toContain('Last playbook run: no record on this machine');
    const withRun = summaryText(
      {
        ...SAMPLE,
        playbookRuns: [
          { at: '2026-10-11T09:00:00Z', playbook: 'Base', user: 'jan', from: '192.0.2.5' },
        ],
      },
      Date.parse('2026-10-11T12:00:00Z'),
    );
    expect(withRun).toContain('Last playbook run: 3 hours ago, Base by jan from 192.0.2.5');
    expect(text).toContain('Failed services: example.service');
    expect(text).toContain('Disk /: 5.0 GB free of 100.0 GB (95 % used, ext4 on /dev/sda1)');
    expect(text).toContain('gateway 192.0.2.1 via wlp2s0');
    expect(text).toContain('SSID "Example Net" signal 84 %, 5500 MHz, 270 Mbit/s, WPA2');
    expect(text).toContain('VPN: no tunnel up');
  });

  it('formats sizes, durations and ages', () => {
    expect(formatBytes(363_378_831_360)).toBe('363.4 GB');
    expect(formatBytes(1_500_000)).toBe('2 MB');
    expect(formatDuration(35160)).toBe('9 h 46 min');
    expect(formatDuration(300)).toBe('5 min');
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(formatAgo(now - 5 * 86400_000, now)).toBe('5 days ago');
  });
});
