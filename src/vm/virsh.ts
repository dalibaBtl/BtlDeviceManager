/**
 * Parsers for `virsh` output. virsh has no JSON mode, so the CLI reads the
 * line-oriented `dominfo` of every domain named by `list --all --name`; that
 * copes with names containing spaces, which the `list` table does not.
 */
import type { VirtualMachine, VmState } from '../shared/types.js';

/**
 * The connection every `virsh` call uses. Without `-c`, virsh picks
 * `qemu:///session` for a plain user, a private instance that holds no
 * machines; the ones the station runs live on the system instance, which
 * members of the `libvirt` group may drive without root.
 */
export const VIRSH_URI = 'qemu:///system';

const STATES: readonly VmState[] = [
  'running',
  'idle',
  'paused',
  'in shutdown',
  'shut off',
  'crashed',
  'pmsuspended',
];

/** Maps libvirt's state text onto {@link VmState}; anything unexpected is `unknown`. */
export function normalizeState(text: string): VmState {
  const t = text.trim().toLowerCase();
  return STATES.find((s) => s === t) ?? 'unknown';
}

/** Domain names from `virsh list --all --name`: one per line, trailing blank line. */
export function parseNames(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Reads `virsh dominfo <name>`: `Key:   value` lines. Only the fields the UI
 * shows are taken; unknown lines are ignored so a newer libvirt cannot break
 * the parser. `name` is passed in because a domain name with trailing
 * whitespace would not survive the round trip through the text.
 */
export function parseDominfo(name: string, text: string): VirtualMachine {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) fields.set(m[1].trim(), m[2].trim());
  }
  const id = Number(fields.get('Id'));
  const cpus = Number(fields.get('CPU(s)'));
  const memKiB = /^(\d+)\s*KiB$/.exec(fields.get('Max memory') ?? '');
  return {
    name,
    id: Number.isInteger(id) && id > 0 ? id : null,
    state: normalizeState(fields.get('State') ?? ''),
    cpus: Number.isInteger(cpus) && cpus > 0 ? cpus : null,
    memoryMiB: memKiB?.[1] !== undefined ? Math.round(Number(memKiB[1]) / 1024) : null,
    autostart: fields.get('Autostart') === 'enable',
    persistent: fields.get('Persistent') === 'yes',
    consoleWorkspace: null,
  };
}

/** Whether the guest is up in any form virt-viewer can attach to. */
export function isUp(vm: VirtualMachine): boolean {
  return vm.state === 'running' || vm.state === 'idle' || vm.state === 'paused';
}

/** Whether `virsh start` makes sense: the guest is down. */
export function isDown(vm: VirtualMachine): boolean {
  return vm.state === 'shut off' || vm.state === 'crashed';
}
