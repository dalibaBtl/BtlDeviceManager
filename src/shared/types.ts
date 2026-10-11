/**
 * Wire types shared by the server, the browser front-end and the `btl-printers`
 * CLI. Everything crossing the HTTP/WebSocket boundary, and the JSON the CLI
 * prints, is declared here so all three compile against one contract.
 */

/** State of a CUPS queue as reported by `lpstat -p`. */
export type QueueState = 'idle' | 'printing' | 'stopped' | 'unknown';

/** A CUPS print queue that exists on this machine. */
export interface PrintQueue {
  /** Queue name, as used with `lp -d` and `lpadmin -p`. */
  name: string;
  /** Device URI the queue prints to, e.g. `ipp://host.local:631/ipp/print`. */
  uri: string;
  state: QueueState;
  /** Whether `lpstat -d` names this queue as the default destination. */
  isDefault: boolean;
}

/**
 * One printer as the UI sees it: a printer found on the network, a queue that
 * exists on this machine, or both when they match. `id` doubles as the queue
 * name, so `btl-printers add <id>` creates a queue called `<id>`.
 */
export interface Printer {
  /** Slug of the mDNS service name, or the queue name for a queue-only entry. */
  id: string;
  /** Human-readable name: the mDNS service name, or the queue name. */
  name: string;
  /** Model from the mDNS TXT record (`ty`), falling back to the name. */
  model: string;
  /** mDNS host name such as `printer-1234.local`; `null` when not discovered. */
  host: string | null;
  ip: string | null;
  /** IPP URI built from the mDNS record; `null` when not discovered. */
  uri: string | null;
  /** Seen on the network in the latest scan. Sleeping printers drop off mDNS. */
  discovered: boolean;
  /** The matching queue, or `null` when the printer has not been set up. */
  queue: PrintQueue | null;
}

/** Result of one `btl-printers list --json` run. */
export interface PrinterList {
  printers: Printer[];
  /** Epoch milliseconds when the scan finished. */
  scannedAt: number;
}

/** Messages pushed from server to client over the WebSocket. */
export type ServerMessage =
  | { type: 'printers'; items: Printer[]; scannedAt: number | null; error: string | null }
  | { type: 'scanning'; scanning: boolean }
  | { type: 'displays'; items: DisplayOutput[]; scannedAt: number | null; error: string | null }
  | {
      type: 'vms';
      items: VirtualMachine[];
      settings: VmSettings;
      scannedAt: number | null;
      error: string | null;
    }
  | { type: 'status'; status: SystemStatus | null; error: string | null }
  | { type: 'term-data'; data: string }
  | { type: 'term-exit'; code: number }
  | { type: 'notice'; level: 'info' | 'error'; text: string };

/**
 * Actions that are typed into the client's terminal rather than executed by
 * the server. Everything that needs `sudo`, and the test page, belongs here:
 * the user must see the command that ran on their machine and its answer.
 */
export type TerminalAction =
  | { action: 'printer-add'; id: string }
  | { action: 'printer-default'; id: string }
  | { action: 'printer-test'; id: string }
  | { action: 'printer-remove'; id: string }
  | { action: 'display-apply'; file: string }
  | { action: 'vm-start'; name: string }
  | { action: 'vm-shutdown'; name: string }
  | { action: 'vm-poweroff'; name: string }
  | { action: 'vm-console'; name: string }
  | { action: 'status-log'; unit: string; scope: UnitScope };

/** Messages sent from client to server over the WebSocket. */
export type ClientMessage =
  | { type: 'term-open'; cols: number; rows: number }
  | { type: 'term-input'; data: string }
  | { type: 'term-resize'; cols: number; rows: number }
  | { type: 'term-run'; run: TerminalAction };

// ---- displays ----------------------------------------------------------------

/** One video mode as sway reports it; `refresh` is in millihertz (60000 = 60 Hz). */
export interface DisplayMode {
  width: number;
  height: number;
  refresh: number;
}

/** Output rotation and flip, in sway's vocabulary. */
export type Transform =
  'normal' | '90' | '180' | '270' | 'flipped' | 'flipped-90' | 'flipped-180' | 'flipped-270';

export const TRANSFORMS: Transform[] = [
  'normal',
  '90',
  '180',
  '270',
  'flipped',
  'flipped-90',
  'flipped-180',
  'flipped-270',
];

/** Scale factors offered in the UI; sway accepts any number, but these are the ones that render well. */
export const SCALES = [1, 1.25, 1.5, 2];

/** A sway workspace as shown on an output; empty workspaces do not exist in sway, so these are the live ones. */
export interface Workspace {
  name: string;
  /** Shown on its output right now (one per output); `focused` is the one with keyboard focus. */
  visible: boolean;
  focused: boolean;
}

/**
 * One physical output as sway sees it. `identifier` is sway's
 * `"make model serial"` and is what the config file addresses, because the
 * connector `name` changes with the port the cable is plugged into.
 */
export interface DisplayOutput {
  name: string;
  identifier: string;
  make: string;
  model: string;
  serial: string;
  /** `false` for an output sway knows but has disabled. */
  enabled: boolean;
  /** Logical position and size, already after scale and transform; zero for a disabled output. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Current mode, or the preferred (first) mode for a disabled output. */
  mode: DisplayMode;
  modes: DisplayMode[];
  scale: number;
  transform: Transform;
  focused: boolean;
  /** Workspaces currently on this output, in sway's order. */
  workspaces: Workspace[];
}

/** What the user wants one output to be; the unit of `btl-displays apply`. */
export interface LayoutEntry {
  identifier: string;
  /** Connector name at the time of editing, kept for the comment in the config file. */
  name: string;
  enabled: boolean;
  x: number;
  y: number;
  mode: DisplayMode;
  scale: number;
  transform: Transform;
  /**
   * Workspace names pinned to this output (`workspace <name> output <id>` in
   * the config). Every existing workspace is written on Apply, so a replugged
   * monitor gets its workspaces back instead of sway's default placement.
   */
  workspaces: string[];
}

/** The whole arrangement, written to `~/.config/sway/config.d/outputs.conf`. */
export interface DisplayLayout {
  version: 1;
  outputs: LayoutEntry[];
}

/** Result of one `btl-displays list --json` run. */
export interface DisplayList {
  outputs: DisplayOutput[];
  scannedAt: number;
}

// ---- virtual machines --------------------------------------------------------

/** Domain state in libvirt's own words (`virsh dominfo`), plus `unknown` for anything new. */
export type VmState =
  | 'running'
  | 'idle'
  | 'paused'
  | 'in shutdown'
  | 'shut off'
  | 'crashed'
  | 'pmsuspended'
  | 'unknown';

/** One libvirt domain on the system connection (`qemu:///system`). */
export interface VirtualMachine {
  /** Domain name, the argument of every `virsh` command. */
  name: string;
  /** libvirt's numeric id while running; `null` when shut off. */
  id: number | null;
  state: VmState;
  /** Virtual CPUs and maximum memory from `dominfo`; `null` when the field is missing. */
  cpus: number | null;
  memoryMiB: number | null;
  /** Started by libvirt at boot. */
  autostart: boolean;
  /** Defined permanently rather than created for one run. */
  persistent: boolean;
  /**
   * Workspace this machine's console window is moved to, or `null` to leave it
   * where it opens. Stored as a sway variable in `~/.config/sway/config.d/vm.conf`.
   */
  consoleWorkspace: string | null;
}

/** What the console workspace can be chosen from: names in the sway config plus the live ones. */
export interface VmSettings {
  workspaces: string[];
}

/** Result of one `btl-vm list --json` run. */
export interface VmList {
  vms: VirtualMachine[];
  settings: VmSettings;
  scannedAt: number;
}

// ---- status -------------------------------------------------------------------

/** Whether a unit belongs to the system manager or the user's own. */
export type UnitScope = 'system' | 'user';

/** Identity of the machine, the first things support asks for. */
export interface StatusHost {
  name: string;
  /** `PRETTY_NAME` from os-release. */
  os: string;
  kernel: string;
  uptimeSeconds: number;
  timezone: string | null;
  /** `null` when timedatectl is not available. */
  ntpSynchronized: boolean | null;
}

/** What the DMI tables, /proc and sysfs say about the hardware; `null` where the machine does not tell. */
export interface StatusHardware {
  vendor: string | null;
  model: string | null;
  board: string | null;
  biosVersion: string | null;
  biosDate: string | null;
  cpu: string | null;
  cpuCount: number;
  memoryMiB: number | null;
  memoryAvailableMiB: number | null;
  gpu: string | null;
  battery: { percent: number; status: string } | null;
}

/** One configuration run, as the playbook appends it to `/var/log/btl/ansible-runs.jsonl`. */
export interface PlaybookRun {
  /** ISO 8601 timestamp with zone. */
  at: string;
  /** The play's name, as Ansible reports it. */
  playbook: string | null;
  /** Who ran it and from which address; empty for a run started on the machine itself. */
  user: string | null;
  from: string | null;
}

export interface FailedUnit {
  unit: string;
  description: string;
  /** systemd's sub-state, e.g. `failed`. */
  sub: string;
  scope: UnitScope;
}

/** One real filesystem, sizes in bytes. */
export interface DiskUsage {
  target: string;
  source: string;
  fstype: string;
  size: number;
  used: number;
  avail: number;
}

export interface WifiLink {
  ssid: string;
  /** 0–100 as NetworkManager reports it. */
  signal: number;
  frequencyMHz: number | null;
  rateMbit: number | null;
  security: string;
}

/** One network device as NetworkManager and the kernel see it; loopback and Wi-Fi P2P are left out. */
export interface NetworkDevice {
  device: string;
  type: string;
  /** NetworkManager's words, e.g. `connected`, `disconnected`, `unavailable`. */
  state: string;
  connection: string | null;
  mac: string | null;
  ipv4: string[];
  ipv6: string[];
  gateway: string | null;
  dns: string[];
  /** Link speed from sysfs for wired devices. */
  speedMbit: number | null;
  wifi: WifiLink | null;
}

export interface NetworkStatus {
  /** NetworkManager's overall state, e.g. `connected`. */
  state: string | null;
  /** NetworkManager's connectivity check: `full`, `limited`, `portal`, `none`, `unknown`. */
  connectivity: string | null;
  defaultRoute: { device: string; gateway: string } | null;
  devices: NetworkDevice[];
}

export interface VpnStatus {
  /** WireGuard interfaces that exist right now, with their addresses. */
  tunnels: { ifname: string; addresses: string[] }[];
  /** `wg-quick@…` instances systemd knows; an instance never started is invisible without root. */
  units: { unit: string; active: string; sub: string }[];
}

/** Result of one `btl-status list --json` run: everything support asks about, read-only. */
export interface SystemStatus {
  host: StatusHost;
  hardware: StatusHardware;
  /** Latest first, at most a handful; empty when the machine has no record. */
  playbookRuns: PlaybookRun[];
  failedUnits: FailedUnit[];
  disks: DiskUsage[];
  network: NetworkStatus;
  vpn: VpnStatus;
  /** Epoch milliseconds when the read finished. */
  scannedAt: number;
}
