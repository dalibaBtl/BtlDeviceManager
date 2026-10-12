// Renders the Printers panel to static HTML with populated state. There is no
// browser in CI, so this is the cheapest way to catch runtime errors in the
// view code and to assert which actions appear for which printer state.
import { render } from 'preact-render-to-string';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Printer, VirtualMachine } from '../src/shared/types.js';

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
  queue: { name: 'Office', uri: found.uri!, state: 'idle', isDefault: true, reasons: [], jobs: [] },
};
const busy: Printer = {
  ...ready,
  queue: {
    ...ready.queue!,
    state: 'printing',
    jobs: [
      { id: 12, user: 'alice', sizeBytes: 1024, submittedAt: null, reasons: ['job-printing'] },
      { id: 13, user: 'alice', sizeBytes: 3_000_000, submittedAt: null, reasons: [] },
    ],
  },
};
const asleep: Printer = {
  id: 'Old',
  name: 'Old',
  model: 'Old',
  host: 'old.local',
  ip: null,
  uri: null,
  discovered: false,
  queue: {
    name: 'Old',
    uri: 'ipp://old.local:631/ipp/print',
    state: 'idle',
    isDefault: false,
    reasons: [],
    jobs: [],
  },
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

  it('lists waiting jobs under the printer with Cancel and Cancel all', async () => {
    const { state, PrintersPanel } = await load();
    state.printers.value = [busy];
    const html = render(<PrintersPanel />);
    expect(html).toContain('Printing');
    expect(html).toContain('job 12');
    expect(html).toContain('job 13');
    expect(html).toContain('2.9 MiB');
    expect(html).toContain('printing');
    expect(html).toContain('Cancel all');
    expect(html.match(/>Cancel</g)).toHaveLength(2);
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

  it('printerStatus puts alerts and waiting jobs before Ready', async () => {
    const { printerStatus } = await load();
    const q = ready.queue!;
    expect(
      printerStatus({ ...ready, queue: { ...q, reasons: ['media-empty-report'] } }).label,
    ).toBe('Out of paper');
    expect(
      printerStatus({ ...ready, queue: { ...q, reasons: ['cups-waiting-for-job-completed'] } })
        .label,
    ).toBe('Default');
    expect(
      printerStatus({
        ...ready,
        queue: { ...q, jobs: [{ id: 1, user: 'a', sizeBytes: 1, submittedAt: null, reasons: [] }] },
      }).label,
    ).toBe('1 job waiting');
  });
});

describe('DisplaysPanel', () => {
  const laptop = {
    name: 'eDP-1',
    identifier: 'Example Display Corp. PANEL14-0  Unknown',
    make: 'Example Display Corp.',
    model: 'PANEL14-0 ',
    serial: 'Unknown',
    enabled: true,
    x: 0,
    y: 240,
    width: 1920,
    height: 1200,
    mode: { width: 1920, height: 1200, refresh: 60000 },
    modes: [{ width: 1920, height: 1200, refresh: 60000 }],
    scale: 1,
    transform: 'normal' as const,
    focused: true,
    workspaces: [
      { name: '1: dev', visible: true, focused: true },
      { name: '3: ai', visible: false, focused: false },
    ],
  };
  const external = {
    ...laptop,
    name: 'HDMI-A-1',
    identifier: 'Example UW3440 SN0000001',
    x: 1920,
    y: 0,
    width: 3440,
    height: 1440,
    mode: { width: 3440, height: 1440, refresh: 100000 },
    modes: [{ width: 3440, height: 1440, refresh: 100000 }],
    focused: false,
    workspaces: [{ name: '4: misc', visible: true, focused: false }],
  };

  it('draws one rectangle per enabled display and a row per display', async () => {
    const state = await import('../src/web/state.js');
    const { DisplaysPanel } = await import('../src/web/components/DisplaysPanel.jsx');
    state.displays.value = [
      laptop,
      { ...external, enabled: false, x: 0, y: 0, width: 0, height: 0 },
    ];
    const html = render(<DisplaysPanel />);
    expect(html.match(/class="display /g)).toHaveLength(1);
    expect(html).toContain('eDP-1');
    expect(html).toContain('HDMI-A-1');
    expect(html).toContain('3440×1440 @ 100 Hz');
    expect(html).toContain('Example UW3440 SN0000001');
    expect(html).not.toContain('unsaved changes');
  });

  it('draws workspace labels inside their display, marking the visible one', async () => {
    const state = await import('../src/web/state.js');
    const { DisplaysPanel } = await import('../src/web/components/DisplaysPanel.jsx');
    state.displays.value = [laptop, external];
    const html = render(<DisplaysPanel />);
    expect(html).toContain('1: dev');
    expect(html).toContain('3: ai');
    expect(html).toContain('4: misc');
    expect(html.match(/class="ws visible/g)).toHaveLength(2);
    expect(html.match(/class="ws /g)).toHaveLength(3);
  });

  it('shows the read error instead of an empty canvas', async () => {
    const state = await import('../src/web/state.js');
    const { DisplaysPanel } = await import('../src/web/components/DisplaysPanel.jsx');
    state.displays.value = [];
    state.displaysError.value = 'swaymsg: not found';
    const html = render(<DisplaysPanel />);
    expect(html).toContain('Could not read displays');
    state.displaysError.value = null;
  });

  it('fits the arrangement into the canvas width', async () => {
    const { fitToCanvas } = await import('../src/web/components/DisplaysPanel.jsx');
    const fit = fitToCanvas(
      [
        { x: 0, y: 240, width: 1920, height: 1200 },
        { x: 1920, y: 0, width: 3440, height: 1440 },
      ],
      720,
      24,
    );
    expect(fit.k).toBeCloseTo((720 - 48) / 5360, 5);
    expect(fit.height).toBe(Math.ceil(1440 * fit.k) + 48);
  });
});

describe('VmPanel', () => {
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

  async function loadVm() {
    const state = await import('../src/web/state.js');
    const panel = await import('../src/web/components/VmPanel.jsx');
    return { state, ...panel };
  }

  it('explains an empty list and shows the CLI error verbatim', async () => {
    const { state, VmPanel } = await loadVm();
    state.vms.value = [];
    state.vmsScannedAt.value = Date.now();
    state.vmsError.value = null;
    expect(render(<VmPanel />)).toContain('No virtual machines are defined');
    state.vmsError.value = 'virsh: failed to connect';
    expect(render(<VmPanel />)).toContain('failed to connect');
  });

  it('offers Start for a stopped guest and Console, Shut down, Force off for a running one', async () => {
    const { state, VmPanel } = await loadVm();
    state.vmsError.value = null;
    state.vms.value = [
      off,
      { ...off, name: 'up', id: 2, state: 'running', autostart: true, consoleWorkspace: '5: vm' },
    ];
    state.vmSettings.value = { workspaces: ['1: dev', '5: vm'] };
    const html = render(<VmPanel />);
    expect(html).toContain('>Start<');
    expect(html).toContain('>Console<');
    expect(html).toContain('>Shut down<');
    expect(html).toContain('>Force off<');
    expect(html).toContain('16 GiB');
    expect(html).toContain('starts with the machine');
    expect(html.match(/<option selected value="5: vm"/g)).toHaveLength(1);
    expect(html.match(/<option selected value>/g)).toHaveLength(1);
  });

  it('formats memory the way people say it', async () => {
    const { formatMemory } = await loadVm();
    expect(formatMemory(16384)).toBe('16 GiB');
    expect(formatMemory(1536)).toBe('1.5 GiB');
    expect(formatMemory(512)).toBe('512 MiB');
    expect(formatMemory(1000)).toBe('1000 MiB');
  });
});

describe('StatusPanel', () => {
  async function loadStatus() {
    const state = await import('../src/web/state.js');
    const panel = await import('../src/web/components/StatusPanel.jsx');
    const { SAMPLE } = await import('./status.test.js');
    return { state, SAMPLE, ...panel };
  }

  it('shows the CLI error, then every section with warnings where due', async () => {
    const { state, SAMPLE, StatusPanel } = await loadStatus();
    state.status.value = null;
    state.statusError.value = 'btl-status: boom';
    expect(render(<StatusPanel />)).toContain('boom');
    state.statusError.value = null;
    state.status.value = SAMPLE;
    const html = render(<StatusPanel />);
    expect(html).toContain('example-station');
    expect(html).toContain('Example Book 14');
    expect(html).toContain('no record on this machine');
    expect(html).toContain('example.service');
    expect(html).toContain('>Show log<');
    expect(html).toContain('<tr class="warn">'); // the 95 % disk
    expect(html).toContain('192.0.2.71/24');
    expect(html).toContain('SSID &quot;Example Net&quot;');
    expect(html).toContain('No tunnel is up');
  });

  it('says so when all services run', async () => {
    const { state, SAMPLE, StatusPanel } = await loadStatus();
    state.statusError.value = null;
    state.status.value = { ...SAMPLE, failedUnits: [] };
    expect(render(<StatusPanel />)).toContain('All services are running');
  });
});

describe('live performance', () => {
  it('renders the Performance card from a sample with the profile select', async () => {
    const state = await import('../src/web/state.js');
    const { PerformancePanel } = await import('../src/web/components/PerformancePanel.jsx');
    state.perf.value = {
      at: 0,
      cpuPercent: 42,
      cores: [100, 0],
      load1: 1.5,
      load5: 1,
      memory: { totalMiB: 32768, usedMiB: 8192, availableMiB: 24576, swapUsedMiB: 0 },
      temperature: { celsius: 55, sensor: 'acpitz' },
      processes: [{ pid: 7, name: 'chrome', cpuPercent: 30, rssMiB: 500 }],
      powerProfile: { active: 'balanced', available: ['performance', 'balanced'] },
      clock: { currentMHz: [4600, 600], minMHz: 600, maxMHz: 4700, boost: true },
      policy: {
        governor: 'powersave',
        energyPreference: 'balance_performance',
        platformProfile: 'balanced',
        onAc: true,
      },
    };
    const html = render(<PerformancePanel />);
    expect(html).toContain('42 %');
    expect(html).toContain('55 °C (acpitz)');
    expect(html).toContain('<option selected value="balanced"');
    expect(html).toContain('chrome');
    expect(html).toContain('2.6 GHz now (0.6–4.7), boost on');
    expect(html).toContain('platform profile balanced · EPP balance_performance');
    state.perf.value = { ...state.perf.value, powerProfile: null };
    expect(render(<PerformancePanel />)).toContain('power-profiles-daemon is not installed');
  });

  it('shows per-vCPU load for a running guest', async () => {
    const state = await import('../src/web/state.js');
    const { VmPanel } = await import('../src/web/components/VmPanel.jsx');
    state.vmsError.value = null;
    state.vms.value = [
      {
        name: 'up',
        id: 2,
        state: 'running',
        cpus: 4,
        memoryMiB: 16384,
        autostart: false,
        persistent: true,
        consoleWorkspace: null,
      },
    ];
    state.vmStats.value = new Map([
      ['up', { name: 'up', vcpus: [100, 99, 0, 0], cpuPercent: 199, rssMiB: 16602, maxMiB: 16384 }],
    ]);
    const html = render(<VmPanel />);
    expect(html).toContain('2 of 4 vCPU busy');
    expect(html).toContain('vCPU 2: 0 %');
  });
});
