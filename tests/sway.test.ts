import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  attachWorkspaces,
  describeMode,
  focusedWorkspace,
  formatMode,
  parseOutputs,
} from '../src/displays/sway.js';

// Captured from `swaymsg -t get_outputs` on a workstation, with make/model/serial
// replaced by documentation values. The laptop panel's model ends in a space,
// and the Sunshine headless output reports nothing but "Unknown".
const FIXTURE = readFileSync(new URL('./fixtures/get_outputs.json', import.meta.url), 'utf8');

describe('parseOutputs', () => {
  const outputs = parseOutputs(FIXTURE);

  it('hides headless outputs and keeps physical ones in order', () => {
    expect(outputs.map((o) => o.name)).toEqual(['eDP-1', 'HDMI-A-1']);
  });

  it('builds the identifier exactly as sway does, trailing space included', () => {
    expect(outputs[0]!.identifier).toBe('Example Display Corp. PANEL14-0  Unknown');
    expect(outputs[1]!.identifier).toBe('Example UW3440 SN0000001');
  });

  it('reads logical rect, current mode, scale and transform', () => {
    const hdmi = outputs[1]!;
    expect(hdmi).toMatchObject({
      enabled: true,
      x: 1920,
      y: 0,
      width: 3440,
      height: 1440,
      scale: 1,
      transform: 'normal',
      focused: false,
    });
    expect(hdmi.mode).toEqual({ width: 3440, height: 1440, refresh: 100000 });
    expect(outputs[0]!.focused).toBe(true);
  });

  it('collapses modes that differ only by aspect-ratio flag or a fraction of a hertz', () => {
    const hdmi = outputs[1]!;
    expect(hdmi.modes.filter((m) => m.width === 1920 && m.height === 1080)).toHaveLength(1);
    expect(outputs[0]!.modes).toHaveLength(2);
    const [o] = parseOutputs(
      JSON.stringify([
        {
          name: 'DP-1',
          active: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          modes: [
            { width: 1920, height: 1080, refresh: 60000 },
            { width: 1920, height: 1080, refresh: 59940 },
            { width: 1920, height: 1080, refresh: 50000 },
          ],
        },
      ]),
    );
    expect(o!.modes.map((m) => m.refresh)).toEqual([60000, 50000]);
  });

  it('gives a disabled output zero geometry and its preferred mode', () => {
    const raw = JSON.parse(FIXTURE) as Record<string, unknown>[];
    const off = {
      ...raw[1]!,
      active: false,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      current_mode: null,
      scale: null,
      transform: null,
    };
    const [o] = parseOutputs(JSON.stringify([off]));
    expect(o).toMatchObject({
      enabled: false,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      scale: 1,
      transform: 'normal',
    });
    expect(o!.mode).toEqual({ width: 3440, height: 1440, refresh: 100000 });
  });
});

describe('mode formatting', () => {
  it('writes millihertz as a decimal rate for the config and rounds for humans', () => {
    expect(formatMode({ width: 3440, height: 1440, refresh: 100000 })).toBe('3440x1440@100.000Hz');
    expect(formatMode({ width: 1920, height: 1080, refresh: 59940 })).toBe('1920x1080@59.940Hz');
    expect(formatMode({ width: 800, height: 600, refresh: 0 })).toBe('800x600');
    expect(describeMode({ width: 1920, height: 1080, refresh: 59940 })).toBe('1920×1080 @ 60 Hz');
  });
});

describe('attachWorkspaces', () => {
  const WS = JSON.stringify([
    { num: 4, name: '4: misc', output: 'HDMI-A-1', focused: true, visible: true },
    { num: 1, name: '1: dev', output: 'eDP-1', focused: false, visible: true },
    { num: 3, name: '3: ai', output: 'eDP-1', focused: false, visible: false },
    { num: 9, name: 'stream', output: 'HEADLESS-1', focused: false, visible: true },
  ]);

  it('groups workspaces by connector in sway order and drops hidden outputs', () => {
    const outputs = attachWorkspaces(parseOutputs(FIXTURE), WS);
    expect(outputs[0]!.workspaces.map((w) => w.name)).toEqual(['1: dev', '3: ai']);
    expect(outputs[1]!.workspaces).toEqual([{ name: '4: misc', visible: true, focused: true }]);
    expect(focusedWorkspace(outputs)).toBe('4: misc');
    expect(focusedWorkspace(parseOutputs(FIXTURE))).toBe(null);
  });
});
