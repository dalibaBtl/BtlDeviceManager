import { describe, expect, it } from 'vitest';
import {
  activeLayouts,
  currentVariant,
  findLayout,
  parseKeyboardConf,
  parseKeyboards,
  renderKeyboardConf,
  swaymsgCommand,
} from '../src/keyboard/layout.js';

// Shape of `swaymsg -t get_inputs` on a workstation, with documentation ids:
// one physical keyboard shows up as several devices, plus a pointer.
const INPUTS = JSON.stringify([
  {
    identifier: '1234:5678:Example_Keyboard',
    name: 'Example Keyboard',
    type: 'keyboard',
    xkb_layout_names: ['Czech (QWERTY)'],
    xkb_active_layout_index: 0,
    xkb_active_layout_name: 'Czech (QWERTY)',
  },
  {
    identifier: '1234:5678:Example_Keyboard_Consumer_Control',
    name: 'Example Keyboard Consumer Control',
    type: 'pointer',
  },
  {
    identifier: '1234:5678:Example_Keyboard_System_Control',
    name: 'Example Keyboard System Control',
    type: 'keyboard',
    xkb_active_layout_name: 'Czech (QWERTY)',
  },
]);

describe('parseKeyboards', () => {
  it('keeps keyboards only, with their active layout', () => {
    const devices = parseKeyboards(INPUTS);
    expect(devices.map((d) => d.identifier)).toEqual([
      '1234:5678:Example_Keyboard',
      '1234:5678:Example_Keyboard_System_Control',
    ]);
    expect(activeLayouts(devices)).toEqual(['Czech (QWERTY)']);
    expect(currentVariant(devices)).toBe('qwerty');
  });

  it('rejects output that is not a list', () => {
    expect(() => parseKeyboards('{}')).toThrow(/not return a list/);
  });
});

describe('currentVariant', () => {
  const kb = (layout: string | null) => ({ identifier: 'x', name: 'x', layout });

  it('maps the plain Czech description to QWERTZ', () => {
    expect(currentVariant([kb('Czech')])).toBe('basic');
  });

  it('is null with no keyboard, disagreeing keyboards or a layout not offered', () => {
    expect(currentVariant([])).toBeNull();
    expect(currentVariant([kb('Czech'), kb('Czech (QWERTY)')])).toBeNull();
    expect(currentVariant([kb('English (US)')])).toBeNull();
  });
});

describe('keyboard.conf', () => {
  it('writes layout and variant and reads the variant back', () => {
    const text = renderKeyboardConf('basic');
    expect(text).toContain('input type:keyboard xkb_layout cz\n');
    expect(text).toContain('input type:keyboard xkb_variant basic\n');
    expect(parseKeyboardConf(text)).toBe('basic');
  });

  it('reads nothing from a missing or foreign file', () => {
    expect(parseKeyboardConf('')).toBeNull();
    expect(parseKeyboardConf('input type:touchpad tap enabled\n')).toBeNull();
  });

  it('applies the same lines at runtime', () => {
    expect(swaymsgCommand('qwerty')).toBe(
      'input type:keyboard xkb_layout cz; input type:keyboard xkb_variant qwerty',
    );
  });

  it('offers only the whitelisted variants', () => {
    expect(findLayout('qwerty')?.label).toBe('Czech QWERTY');
    expect(findLayout('basic')?.label).toBe('Czech QWERTZ');
    expect(findLayout('dvorak-ucw')).toBeUndefined();
  });
});
