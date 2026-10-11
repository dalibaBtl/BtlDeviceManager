import { describe, expect, it } from 'vitest';
import { isDown, isUp, normalizeState, parseDominfo, parseNames } from '../src/vm/virsh.js';

const DOMINFO = `Id:             -
Name:           win11
UUID:           00000000-0000-4000-8000-000000000000
OS Type:        hvm
State:          shut off
CPU(s):         4
Max memory:     16777216 KiB
Used memory:    16777216 KiB
Persistent:     yes
Autostart:      disable
Autostart Once: disable
Managed save:   no
Security model: apparmor
Security DOI:   0

`;

describe('parseDominfo', () => {
  it('reads the fields the panel shows', () => {
    expect(parseDominfo('win11', DOMINFO)).toEqual({
      name: 'win11',
      id: null,
      state: 'shut off',
      cpus: 4,
      memoryMiB: 16384,
      autostart: false,
      persistent: true,
      consoleWorkspace: null,
    });
  });

  it('takes the numeric id, autostart and multi-word states from a running guest', () => {
    const text = DOMINFO.replace('Id:             -', 'Id:             7')
      .replace('State:          shut off', 'State:          in shutdown')
      .replace('Autostart:      disable', 'Autostart:      enable')
      .replace('CPU time:', 'CPU time:');
    const vm = parseDominfo('win11', text);
    expect(vm.id).toBe(7);
    expect(vm.state).toBe('in shutdown');
    expect(vm.autostart).toBe(true);
  });

  it('tolerates missing fields rather than failing the whole list', () => {
    const vm = parseDominfo('x', 'Name: x\nState: running\n');
    expect(vm).toMatchObject({ cpus: null, memoryMiB: null, state: 'running', id: null });
  });
});

describe('states', () => {
  it('normalizes known states and keeps unknown ones visible', () => {
    expect(normalizeState('  Shut Off ')).toBe('shut off');
    expect(normalizeState('pmsuspended')).toBe('pmsuspended');
    expect(normalizeState('teleporting')).toBe('unknown');
  });

  it('decides which actions apply', () => {
    const base = parseDominfo('x', 'State: running');
    expect(isUp(base)).toBe(true);
    expect(isDown(base)).toBe(false);
    expect(isUp({ ...base, state: 'paused' })).toBe(true);
    expect(isDown({ ...base, state: 'crashed' })).toBe(true);
    expect(isUp({ ...base, state: 'unknown' })).toBe(false);
    expect(isDown({ ...base, state: 'unknown' })).toBe(false);
  });
});

describe('parseNames', () => {
  it('returns one name per non-empty line, spaces inside kept', () => {
    expect(parseNames('win11\nExample VM\n\n')).toEqual(['win11', 'Example VM']);
  });
});
