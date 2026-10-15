/**
 * The keyboard layouts the panel offers, how sway reports them, and the file
 * the choice is kept in.
 *
 * Only the Czech layout is offered, in its two physical arrangements: QWERTY,
 * which the `desktop` role sets, and QWERTZ, printed on most Czech keyboards.
 * The list is a whitelist on purpose; anything else is a line in the user's
 * own sway config, not a setting this app needs to know about.
 *
 * sway's `get_inputs` names the active layout only by its xkb description
 * (`Czech (QWERTY)`), never by variant, so the description is what maps a
 * keyboard back to an option.
 */
import type { KeyboardDevice, KeyboardLayoutOption } from '../shared/types.js';

/** The xkb layout every offered variant belongs to. */
export const XKB_LAYOUT = 'cz';

/**
 * Offered variants, the role's default first. QWERTZ is `basic` rather than
 * an empty variant: `swaymsg` cannot pass an empty argument, and `basic` is
 * the same symbols file entry `cz` falls back to.
 */
export const KEYBOARD_LAYOUTS: KeyboardLayoutOption[] = [
  { variant: 'qwerty', label: 'Czech QWERTY', xkbName: 'Czech (QWERTY)' },
  { variant: 'basic', label: 'Czech QWERTZ', xkbName: 'Czech' },
];

export const KEYBOARD_CONF_HEADER =
  '# Written by btl-keyboard (BTL Device Manager). Overrides the layout in ~/.config/sway/config.';

interface RawInput {
  identifier?: string;
  name?: string;
  type?: string;
  xkb_active_layout_name?: string;
}

/**
 * Parses `swaymsg -t get_inputs` into the keyboards and the layout each uses.
 * One physical keyboard shows up as several devices (system and consumer
 * control); all are kept, since each carries its own keymap.
 */
export function parseKeyboards(json: string): KeyboardDevice[] {
  const raw = JSON.parse(json) as RawInput[];
  if (!Array.isArray(raw)) throw new Error('get_inputs did not return a list');
  return raw
    .filter((d) => d.type === 'keyboard' && typeof d.identifier === 'string')
    .map((d) => ({
      identifier: d.identifier ?? '',
      name: d.name ?? d.identifier ?? '',
      layout: d.xkb_active_layout_name ?? null,
    }));
}

/** Distinct layout names in use, in device order. */
export function activeLayouts(devices: KeyboardDevice[]): string[] {
  const names: string[] = [];
  for (const d of devices) if (d.layout && !names.includes(d.layout)) names.push(d.layout);
  return names;
}

/**
 * The offered variant every keyboard uses now, or `null` when no keyboard is
 * connected, keyboards disagree (a per-device line somewhere in the config),
 * or the layout is not one of ours.
 */
export function currentVariant(devices: KeyboardDevice[]): string | null {
  const names = activeLayouts(devices);
  if (names.length !== 1) return null;
  return KEYBOARD_LAYOUTS.find((l) => l.xkbName === names[0])?.variant ?? null;
}

export function findLayout(variant: string): KeyboardLayoutOption | undefined {
  return KEYBOARD_LAYOUTS.find((l) => l.variant === variant);
}

/**
 * The content of `config.d/keyboard.conf`. Both layout and variant are
 * written, so the choice stays a valid keymap even if the main config moves to
 * another layout. The `input` lines merge into the role's `type:keyboard`
 * block, which sway reads first, so `xkb_numlock` and the rest stay.
 */
export function renderKeyboardConf(variant: string): string {
  return (
    `${KEYBOARD_CONF_HEADER}\n` +
    `input type:keyboard xkb_layout ${XKB_LAYOUT}\n` +
    `input type:keyboard xkb_variant ${variant}\n`
  );
}

/** Reads the stored variant back; `null` for a missing file or one without our line. */
export function parseKeyboardConf(text: string): string | null {
  for (const raw of text.split('\n')) {
    const m = /^input\s+type:keyboard\s+xkb_variant\s+(\S+)\s*$/.exec(raw.trim());
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

/** The runtime equivalent of {@link renderKeyboardConf}, as one `swaymsg` argument. */
export function swaymsgCommand(variant: string): string {
  return (
    `input type:keyboard xkb_layout ${XKB_LAYOUT}; ` + `input type:keyboard xkb_variant ${variant}`
  );
}
