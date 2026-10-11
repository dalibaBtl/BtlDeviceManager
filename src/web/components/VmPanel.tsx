import type { VirtualMachine } from '../../shared/types.js';
import { isDown, isUp } from '../../vm/virsh.js';
import { api } from '../api.js';
import {
  guard,
  refreshVms,
  runInTerminal,
  vmSettings,
  vms,
  vmsError,
  vmsScannedAt,
} from '../state.js';
import { askConfirm } from './Dialogs.jsx';
import { scannedLabel } from './PrintersPanel.jsx';

/**
 * Virtual machines on this station: start, shut down, force off, open the
 * console. Every action is typed into the terminal, so a guest that will not
 * start says why where the user can read it. The one setting, which workspace
 * a machine's console window goes to, is written directly: it is a line in
 * the user's own sway config and cannot need root.
 */
export function VmPanel() {
  const items = vms.value;
  const error = vmsError.value;
  return (
    <section class="pane panel">
      <header>
        <span class="title">Virtual machine</span>
        <span class="meta">{scannedLabel(vmsScannedAt.value)}</span>
        <button title="Read the list again" onClick={() => void refreshVms()}>
          Refresh
        </button>
      </header>
      <div class="content">
        {error && (
          <p class="problem">
            Could not list virtual machines: <code>{error}</code>
          </p>
        )}
        {!error && items.length === 0 && vmsScannedAt.value !== null && (
          <p class="empty">No virtual machines are defined on this machine.</p>
        )}
        {!error && items.length === 0 && vmsScannedAt.value === null && (
          <p class="empty">Waiting for the first scan…</p>
        )}
        {items.length > 0 && (
          <table class="vms">
            <thead>
              <tr>
                <th>Machine</th>
                <th>State</th>
                <th>CPUs</th>
                <th>Memory</th>
                <th>Console on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((vm) => (
                <VmRow key={vm.name} vm={vm} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** State of one machine in words and a CSS class. */
export function vmStatus(vm: VirtualMachine): { label: string; cls: string } {
  switch (vm.state) {
    case 'running':
    case 'idle':
      return { label: 'Running', cls: 'ok' };
    case 'paused':
    case 'pmsuspended':
      return { label: 'Paused', cls: 'warn' };
    case 'in shutdown':
      return { label: 'Shutting down', cls: 'warn' };
    case 'shut off':
      return { label: 'Off', cls: 'away' };
    case 'crashed':
      return { label: 'Crashed', cls: 'warn' };
    default:
      return { label: vm.state, cls: 'away' };
  }
}

function VmRow({ vm }: { vm: VirtualMachine }) {
  const status = vmStatus(vm);
  const setWorkspace = (value: string) =>
    void guard(() =>
      api.post('/api/vms/console-workspace', {
        name: vm.name,
        workspace: value === '' ? null : value,
      }),
    );
  const poweroff = async () => {
    const ok = await askConfirm(
      'Force off?',
      `This cuts the power to "${vm.name}" without letting the guest shut down. Anything unsaved inside it is lost. Use Shut down unless the guest is stuck.`,
      { okLabel: 'Force off', danger: true },
    );
    if (ok) runInTerminal({ action: 'vm-poweroff', name: vm.name });
  };
  return (
    <tr class={isUp(vm) ? '' : 'away'}>
      <td class="name">
        {vm.name}
        {vm.autostart && <span class="meta"> starts with the machine</span>}
      </td>
      <td>
        <span class={`chip ${status.cls}`}>{status.label}</span>
      </td>
      <td>{vm.cpus ?? '–'}</td>
      <td>{vm.memoryMiB !== null ? formatMemory(vm.memoryMiB) : '–'}</td>
      <td>
        <select
          class="mode"
          title="Workspace this machine's console window is moved to"
          value={vm.consoleWorkspace ?? ''}
          onChange={(e) => setWorkspace((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">the current workspace</option>
          {vmSettings.value.workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </td>
      <td class="actions">
        {isDown(vm) && (
          <button
            class="primary"
            onClick={() => runInTerminal({ action: 'vm-start', name: vm.name })}
          >
            Start
          </button>
        )}
        {isUp(vm) && (
          <button
            class="primary"
            onClick={() => runInTerminal({ action: 'vm-console', name: vm.name })}
          >
            Console
          </button>
        )}
        {isUp(vm) && (
          <button
            title="Ask the guest to shut down (ACPI)"
            onClick={() => runInTerminal({ action: 'vm-shutdown', name: vm.name })}
          >
            Shut down
          </button>
        )}
        {isUp(vm) && (
          <button class="quiet" title="Cut the power" onClick={() => void poweroff()}>
            Force off
          </button>
        )}
      </td>
    </tr>
  );
}

/** `16384` → `16 GiB`, `3072` → `3 GiB`, `512` → `512 MiB`. */
export function formatMemory(mib: number): string {
  if (mib >= 1024 && mib % 256 === 0) {
    const gib = mib / 1024;
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  }
  return `${mib} MiB`;
}
