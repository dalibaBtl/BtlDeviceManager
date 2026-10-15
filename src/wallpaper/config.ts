/**
 * The desktop background as sway's config language spells it, and the file
 * the choice is kept in.
 *
 * The `desktop` role sets a solid colour for every output in the main config
 * and leaves pictures to the user: a path that does not exist on a station
 * prints an error at every start. `config.d/wallpaper.conf` is read after the
 * main config, so its `output * bg …` line wins. The app owns that file and
 * rewrites it whole; whatever it said before is read once, so the panel shows
 * the background in use, and replaced on the next change.
 */
import type { WallpaperFit, WallpaperSetting } from '../shared/types.js';

/** sway's image modes, in the order the panel offers them. */
export const WALLPAPER_FITS: WallpaperFit[] = ['fill', 'fit', 'center', 'tile', 'stretch'];

export const WALLPAPER_CONF_HEADER =
  '# Written by btl-wallpaper (BTL Device Manager). Overrides the background in ~/.config/sway/config.';

/** Image types swaybg can load through gdk-pixbuf without extra loaders. */
export type ImageType = 'png' | 'jpg';

/** Larger than any sensible 8K picture; anything bigger is a mistake, not a wallpaper. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const COLOR = /^#[0-9a-fA-F]{6}$/;

export function isColor(s: string): boolean {
  return COLOR.test(s);
}

export function isFit(s: string): s is WallpaperFit {
  return (WALLPAPER_FITS as string[]).includes(s);
}

/** Recognises an image by its first bytes; the file name says nothing reliable. */
export function imageType(head: Uint8Array): ImageType | null {
  if (
    head.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)
  )
    return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  return null;
}

/**
 * The last `output * bg …` line of a sway config, or `null` when there is
 * none. Only the all-outputs form is read; a per-output background is a line
 * the user wrote for a reason, and the panel does not pretend to manage it.
 */
export function parseBackground(config: string): WallpaperSetting | null {
  let found: WallpaperSetting | null = null;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const words = splitWords(line);
    if (words.length < 4 || words[0] !== 'output' || words[1] !== '*') continue;
    if (words[2] !== 'bg' && words[2] !== 'background') continue;
    const [target, mode, extra] = [words[3] ?? '', words[4], words[5]];
    if (mode === 'solid_color' && isColor(target)) {
      found = { kind: 'color', color: target.toLowerCase() };
    } else if (mode !== undefined && isFit(mode)) {
      const color = extra !== undefined && isColor(extra) ? extra.toLowerCase() : null;
      found = { kind: 'image', path: target, fit: mode, color };
    }
  }
  return found;
}

/** The arguments after `output * bg`, quoted for sway; shared by the file and `swaymsg`. */
export function backgroundArgs(s: WallpaperSetting): string {
  if (s.kind === 'color') return `${s.color} solid_color`;
  return `${swayQuote(s.path)} ${s.fit}${s.color ? ` ${s.color}` : ''}`;
}

/** The content of `config.d/wallpaper.conf` for one setting. */
export function renderWallpaperConf(s: WallpaperSetting): string {
  return `${WALLPAPER_CONF_HEADER}\noutput * bg ${backgroundArgs(s)}\n`;
}

/** The runtime equivalent of {@link renderWallpaperConf}, as one `swaymsg` argument. */
export function swaymsgCommand(s: WallpaperSetting): string {
  return `output * bg ${backgroundArgs(s)}`;
}

/** Quotes a path for sway's config language: double quotes with backslash escapes. */
function swayQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

/** Splits a config line into words, honouring double quotes and backslash escapes. */
function splitWords(line: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? ''));
  }
  return words;
}
