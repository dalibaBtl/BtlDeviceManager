import { describe, expect, it } from 'vitest';
import {
  imageType,
  parseBackground,
  renderWallpaperConf,
  swaymsgCommand,
} from '../src/wallpaper/config.js';

// The role's main config sets a colour; a hand-written wallpaper.conf a picture.
const MAIN = `# Background of all outputs
output HEADLESS-1 disable
output * bg #000000 solid_color
`;
const HAND = `# comment explaining the choice
output * bg /home/example/Pictures/hud.png fit #01070E
`;

describe('parseBackground', () => {
  it('reads a solid colour and a picture with its bar colour', () => {
    expect(parseBackground(MAIN)).toEqual({ kind: 'color', color: '#000000' });
    expect(parseBackground(HAND)).toEqual({
      kind: 'image',
      path: '/home/example/Pictures/hud.png',
      fit: 'fit',
      color: '#01070e',
    });
  });

  it('takes the last line, ignores comments and per-output backgrounds', () => {
    const text = `output * bg #111111 solid_color
# output * bg #222222 solid_color
output DP-1 bg #333333 solid_color
`;
    expect(parseBackground(text)).toEqual({ kind: 'color', color: '#111111' });
  });

  it('returns null without a background line or for one it does not understand', () => {
    expect(parseBackground('set $mod Mod4\n')).toBeNull();
    expect(parseBackground('output * bg /a.png sideways\n')).toBeNull();
  });
});

describe('wallpaper.conf', () => {
  it('quotes a path with spaces and reads it back unchanged', () => {
    const setting = {
      kind: 'image' as const,
      path: '/home/example/My "best" picture.png',
      fit: 'fill' as const,
      color: null,
    };
    const text = renderWallpaperConf(setting);
    expect(text).toContain('output * bg "/home/example/My \\"best\\" picture.png" fill\n');
    expect(parseBackground(text)).toEqual(setting);
  });

  it('applies the same line at runtime', () => {
    expect(swaymsgCommand({ kind: 'color', color: '#1d2330' })).toBe(
      'output * bg #1d2330 solid_color',
    );
  });
});

describe('imageType', () => {
  it('recognises PNG and JPEG by their first bytes and nothing else', () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageType(new TextEncoder().encode('RIFF....WEBP'))).toBeNull();
    expect(imageType(new Uint8Array([]))).toBeNull();
  });
});
