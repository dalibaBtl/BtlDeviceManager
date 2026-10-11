import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HEADER, layoutFromOutputs, renderConfig, validateLayout } from '../src/displays/config.js';
import { parseOutputs } from '../src/displays/sway.js';

const outputs = parseOutputs(
  readFileSync(new URL('./fixtures/get_outputs.json', import.meta.url), 'utf8'),
);

describe('renderConfig', () => {
  it('writes one quoted output line per entry, enabled or disabled, normalized to the origin', () => {
    const layout = layoutFromOutputs(outputs);
    layout.outputs[0]!.enabled = false;
    layout.outputs[1]!.x = 500;
    layout.outputs[1]!.y = 300;
    const text = renderConfig(layout);
    expect(text.startsWith(HEADER)).toBe(true);
    expect(text).toContain('# eDP-1\noutput "Example Display Corp. PANEL14-0  Unknown" disable');
    expect(text).toContain(
      '# HDMI-A-1\noutput "Example UW3440 SN0000001" enable pos 0 0 mode 3440x1440@100.000Hz scale 1 transform normal',
    );
  });

  it('round-trips the current arrangement', () => {
    const text = renderConfig(layoutFromOutputs(outputs));
    expect(text).toContain('enable pos 0 240 mode 1920x1200@60.000Hz');
    expect(text).toContain('enable pos 1920 0 mode 3440x1440@100.000Hz');
  });
});

describe('validateLayout', () => {
  it('accepts the current state', () => {
    expect(validateLayout(layoutFromOutputs(outputs), outputs)).toEqual([]);
  });

  it('names every problem', () => {
    const layout = layoutFromOutputs(outputs);
    layout.outputs[0]!.x = 0.5;
    layout.outputs[0]!.scale = 1.1;
    layout.outputs[1]!.mode = { width: 1, height: 1, refresh: 1 };
    layout.outputs[1]!.x = 100;
    layout.outputs.push({ ...layout.outputs[1]!, identifier: 'Gone Monitor 1', name: 'Gone' });
    const problems = validateLayout(layout, outputs);
    expect(problems).toEqual([
      'eDP-1: position must be whole pixels',
      'eDP-1: scale 1.1 is not one of 1, 1.25, 1.5, 2',
      'HDMI-A-1: mode 1x1@0.001Hz is not offered by this output',
      'Gone Monitor 1: not connected right now',
      'HDMI-A-1 and Gone overlap',
    ]);
  });

  it('refuses to switch everything off', () => {
    const layout = layoutFromOutputs(outputs);
    for (const o of layout.outputs) o.enabled = false;
    expect(validateLayout(layout, outputs)).toEqual(['at least one output must stay enabled']);
  });
});
