import { describe, expect, it } from 'vitest';
import {
  consoleVariable,
  parseVmConf,
  parseWorkspaceNames,
  renderVmConf,
  swayQuote,
} from '../src/vm/settings.js';

const CONFIG = `# Workspaces
set $mod Mod4
set $ws1 "1: dev"
set $ws2 "2: web"
  set $ws5 "5: vm"
set $ws_odd plain
# set $ws9 "commented out"
bindcode $mod+10 workspace $ws1
`;

describe('parseWorkspaceNames', () => {
  it('collects the set $ws… lines in order, quoted or not, ignoring comments', () => {
    expect(parseWorkspaceNames(CONFIG)).toEqual(['1: dev', '2: web', '5: vm', 'plain']);
  });

  it('returns nothing for a config without workspace variables', () => {
    expect(parseWorkspaceNames('set $mod Mod4\n')).toEqual([]);
  });
});

describe('vm.conf', () => {
  it('names one variable per machine, reduced to a sway token', () => {
    expect(consoleVariable('win11')).toBe('$btl_vm_console_win11');
    expect(consoleVariable('Example VM 2')).toBe('$btl_vm_console_Example_VM_2');
  });

  it('round-trips the choices, including quotes in a workspace name', () => {
    const choices = new Map([
      [consoleVariable('win11'), '5: vm'],
      [consoleVariable('b'), 'say "hi"'],
    ]);
    const text = renderVmConf(choices);
    expect(text).toContain('set $btl_vm_console_win11 "5: vm"');
    expect(text.startsWith('# Written by btl-vm')).toBe(true);
    expect(parseVmConf(text)).toEqual(choices);
  });

  it('reads nothing from an empty or unrelated file', () => {
    expect(parseVmConf('').size).toBe(0);
    expect(parseVmConf('# only a comment\nset $other "x"\n').size).toBe(0);
  });

  it('quotes for sway', () => {
    expect(swayQuote('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
  });
});
