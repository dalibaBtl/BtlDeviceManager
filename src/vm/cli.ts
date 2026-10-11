/**
 * `btl-vm`: the command behind the Virtual machine panel.
 *
 *     btl-vm list [--json]                 domains on qemu:///system and the console setting
 *     btl-vm start <name>                  virsh start
 *     btl-vm shutdown <name>               virsh shutdown (ACPI; the guest decides)
 *     btl-vm poweroff <name>               virsh destroy (pull the plug)
 *     btl-vm console <name>                open virt-viewer, move its window to the machine's workspace
 *     btl-vm console-workspace <name> <workspace>   remember where this machine's console opens
 *     btl-vm console-workspace <name> --none        forget it
 *
 * Nothing here needs root: members of the `libvirt` group drive the system
 * instance directly. The actions are still typed into the terminal by the app,
 * because a guest that will not start says why on stderr and the user has to
 * see that.
 *
 * Exit codes: 0 success, 1 a system command failed, 2 usage error or unknown domain.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { VirtualMachine, VmList, VmSettings } from '../shared/types.js';
import { consoleVariable, parseVmConf, parseWorkspaceNames, renderVmConf } from './settings.js';
import { VIRSH_URI, isDown, isUp, parseDominfo, parseNames } from './virsh.js';

const TIMEOUT_MS = 20_000;
/** How long `console` waits for virt-viewer to show a window before giving up on moving it. */
const WINDOW_WAIT_MS = 10_000;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

function swayDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'sway');
}

/** `config.d/vm.conf`, next to the outputs file written by `btl-displays`. */
export function vmConfPath(): string {
  return path.join(swayDir(), 'config.d', 'vm.conf');
}

/** Entry point used by `cli/btl-vm.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        await list(rest.includes('--json'));
        return 0;
      case 'start':
        await start(requireName(rest));
        return 0;
      case 'shutdown':
        await shutdown(requireName(rest));
        return 0;
      case 'poweroff':
        await poweroff(requireName(rest));
        return 0;
      case 'console':
        await console_(requireName(rest));
        return 0;
      case 'console-workspace': {
        const [name, workspace] = rest;
        if (!name || !workspace) throw new CliError(`missing name or workspace\n${USAGE}`, 2);
        await setConsoleWorkspace(name, workspace === '--none' ? null : workspace);
        return 0;
      }
      case undefined:
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return command ? 0 : 2;
      default:
        throw new CliError(`unknown command: ${command}\n${USAGE}`, 2);
    }
  } catch (e) {
    const err =
      e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), 1);
    process.stderr.write(`btl-vm: ${err.message}\n`);
    return err.exitCode;
  }
}

const USAGE = `usage: btl-vm list [--json]
       btl-vm start <name>
       btl-vm shutdown <name>
       btl-vm poweroff <name>
       btl-vm console <name>
       btl-vm console-workspace <name> <workspace> | --none
`;

function requireName(rest: string[]): string {
  const n = rest.find((a) => !a.startsWith('-'));
  if (!n) throw new CliError(`missing name\n${USAGE}`, 2);
  return n;
}

// ---- commands ---------------------------------------------------------------

async function list(json: boolean): Promise<void> {
  const result = await scan();
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  for (const vm of result.vms) {
    const spec = [vm.cpus && `${vm.cpus} CPU`, vm.memoryMiB && `${vm.memoryMiB} MiB`]
      .filter(Boolean)
      .join(', ');
    const where = vm.consoleWorkspace ? `console on ${vm.consoleWorkspace}` : '';
    process.stdout.write(`${vm.name.padEnd(20)} ${vm.state.padEnd(12)} ${spec}  ${where}\n`);
  }
  if (result.vms.length === 0) process.stdout.write('no virtual machines defined\n');
}

async function start(name: string): Promise<void> {
  const vm = await requireVm(name);
  if (!isDown(vm)) throw new CliError(`${vm.name} is ${vm.state}`, 2);
  process.stdout.write(await runVisible('virsh', ['-c', VIRSH_URI, 'start', vm.name]));
}

async function shutdown(name: string): Promise<void> {
  const vm = await requireVm(name);
  if (!isUp(vm)) throw new CliError(`${vm.name} is ${vm.state}`, 2);
  process.stdout.write(await runVisible('virsh', ['-c', VIRSH_URI, 'shutdown', vm.name]));
}

async function poweroff(name: string): Promise<void> {
  const vm = await requireVm(name);
  if (!isUp(vm)) throw new CliError(`${vm.name} is ${vm.state}`, 2);
  process.stdout.write(await runVisible('virsh', ['-c', VIRSH_URI, 'destroy', vm.name]));
}

/**
 * Opens the console in virt-viewer, which has its own window and `app_id`
 * (virt-manager would drag its main window along). The window is moved to the
 * machine's workspace by its pid: the CLI subscribes to sway's window events
 * before starting the viewer, so the first `new` window from that pid is the
 * console, whatever `app_id` the viewer uses. The workspace is focused too,
 * since the user just asked for the console. Without a configured workspace
 * the viewer is started and left alone.
 */
async function console_(name: string): Promise<void> {
  const vm = await requireVm(name);
  if (!isUp(vm)) throw new CliError(`${vm.name} is ${vm.state}; start it first`, 2);
  const viewer = await findOnPath('virt-viewer');
  if (!viewer) {
    throw new CliError(
      'virt-viewer is not installed; the desktop role in btl-infra installs it (apt install virt-viewer)',
      1,
    );
  }
  const workspace = vm.consoleWorkspace;
  const events = workspace ? await subscribeWindows() : null;
  const args = ['--connect', VIRSH_URI, vm.name];
  process.stdout.write(`+ virt-viewer ${args.map(quote).join(' ')}\n`);
  const child = spawn(viewer, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  try {
    const outcome = await Promise.race([
      events
        ? events.firstWindowOf(child).then((id) => ({ kind: 'window' as const, id }))
        : never(),
      exited(child).then((code) => ({ kind: 'exit' as const, code })),
      sleep(WINDOW_WAIT_MS).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (outcome.kind === 'exit') {
      throw new CliError(`virt-viewer exited with code ${outcome.code}: ${stderr.trim()}`, 1);
    }
    if (outcome.kind === 'window' && workspace) {
      await moveToWorkspace(outcome.id, workspace);
    } else if (outcome.kind === 'timeout' && workspace) {
      process.stderr.write(
        `btl-vm: virt-viewer showed no window within ${WINDOW_WAIT_MS / 1000} s; leaving it where it opens\n`,
      );
    }
  } finally {
    events?.close();
    child.stderr?.destroy();
    child.unref();
  }
}

/** Rewrites `vm.conf` with this machine's line changed; the file goes away with its last line. */
async function setConsoleWorkspace(name: string, workspace: string | null): Promise<void> {
  const vm = await requireVm(name);
  const target = vmConfPath();
  const choices = await consoleChoices();
  if (workspace === null) {
    choices.delete(consoleVariable(vm.name));
  } else {
    const known = await workspaceNames();
    if (!known.includes(workspace)) {
      throw new CliError(
        `no workspace called ${workspace}; known: ${known.join(', ') || 'none'}`,
        2,
      );
    }
    choices.set(consoleVariable(vm.name), workspace);
  }
  if (choices.size === 0) {
    await rm(target, { force: true });
    process.stdout.write(`removed ${target}; ${vm.name}'s console stays where it opens\n`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderVmConf(choices), 'utf8');
  process.stdout.write(`wrote ${target}\n`);
}

// ---- sway -------------------------------------------------------------------

interface WindowEvents {
  /** Resolves with the container id of the first new window created by `child`. */
  firstWindowOf(child: ChildProcess): Promise<number>;
  close(): void;
}

/** Starts `swaymsg -t subscribe '["window"]' -m` and waits until it is listening. */
function subscribeWindows(): Promise<WindowEvents> {
  return new Promise((resolve, reject) => {
    const sub = spawn('swaymsg', ['-t', 'subscribe', '["window"]', '-m'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const waiters: ((ev: { change: string; container: { id: number; pid: number } }) => void)[] =
      [];
    let buffer = '';
    sub.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { change: string; container: { id: number; pid: number } };
          for (const w of waiters) w(ev);
        } catch {
          // a line that is not one event; the stream stays usable
        }
      }
    });
    sub.on('error', (e) => reject(new CliError(`swaymsg: ${e.message}`, 1)));
    // swaymsg sends the subscribe request as soon as it starts; a short grace
    // period lets sway register it before the viewer can create a window.
    sub.on('spawn', () => setTimeout(() => resolve(api), 200));
    const api: WindowEvents = {
      firstWindowOf: (child) =>
        new Promise((res) => {
          waiters.push((ev) => {
            if (ev.change === 'new' && ev.container?.pid === child.pid) res(ev.container.id);
          });
        }),
      close: () => sub.kill(),
    };
  });
}

async function moveToWorkspace(conId: number, workspace: string): Promise<void> {
  const ws = `"${workspace.replace(/(["\\])/g, '\\$1')}"`;
  const cmd = `[con_id=${conId}] move container to workspace ${ws}; workspace ${ws}`;
  process.stdout.write(`+ swaymsg '${cmd}'\n`);
  const out = await run('swaymsg', [cmd]);
  const failed = (JSON.parse(out) as { success: boolean; error?: string }[]).find(
    (r) => !r.success,
  );
  if (failed) throw new CliError(failed.error ?? 'swaymsg refused the command', 1);
}

/** Workspaces named in the sway config, then any live ones the config does not name. */
async function workspaceNames(): Promise<string[]> {
  const names = parseWorkspaceNames(await readOrEmpty(path.join(swayDir(), 'config')));
  let live: string[] = [];
  try {
    live = (JSON.parse(await run('swaymsg', ['-t', 'get_workspaces'])) as { name: string }[]).map(
      (w) => w.name,
    );
  } catch {
    // not under sway: the config names are all there is
  }
  for (const n of live) if (!names.includes(n)) names.push(n);
  return names;
}

async function consoleChoices(): Promise<Map<string, string>> {
  return parseVmConf(await readOrEmpty(vmConfPath()));
}

async function settings(): Promise<VmSettings> {
  return { workspaces: await workspaceNames() };
}

// ---- libvirt ----------------------------------------------------------------

export async function scan(): Promise<VmList> {
  const [vms, s] = await Promise.all([domains(), settings()]);
  return { vms, settings: s, scannedAt: Date.now() };
}

async function domains(): Promise<VirtualMachine[]> {
  const [names, choices] = await Promise.all([
    run('virsh', ['-c', VIRSH_URI, 'list', '--all', '--name']).then(parseNames),
    consoleChoices(),
  ]);
  return Promise.all(
    names.map(async (n) => ({
      ...parseDominfo(n, await run('virsh', ['-c', VIRSH_URI, 'dominfo', n])),
      consoleWorkspace: choices.get(consoleVariable(n)) ?? null,
    })),
  );
}

async function requireVm(name: string): Promise<VirtualMachine> {
  const vms = await domains();
  const vm = vms.find((v) => v.name === name);
  if (vm) return vm;
  throw new CliError(
    `unknown virtual machine ${name}; known: ${vms.map((v) => v.name).join(', ') || 'none'}`,
    2,
  );
}

// ---- helpers ----------------------------------------------------------------

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err)
          reject(new CliError(`${cmd} ${args.join(' ')}: ${stderr.trim() || err.message}`, 1));
        else resolve(stdout);
      },
    );
  });
}

function runVisible(cmd: string, args: string[]): Promise<string> {
  process.stdout.write(`+ ${[cmd, ...args].map(quote).join(' ')}\n`);
  return run(cmd, args);
}

function quote(s: string): string {
  return /^[\w./:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function findOnPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // next directory
    }
  }
  return null;
}

function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}
