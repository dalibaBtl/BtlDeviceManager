/**
 * Reads sway's view of the outputs (`swaymsg -t get_outputs`) into the shape
 * the app and the config writer work with.
 */
import type { DisplayMode, DisplayOutput, Transform, Workspace } from '../shared/types.js';
import { TRANSFORMS } from '../shared/types.js';

/** Virtual outputs created for streaming; the role manages them, the user must not. */
const HIDDEN_NAME = /^HEADLESS-/;

interface RawMode {
  width?: number;
  height?: number;
  refresh?: number;
}

interface RawOutput {
  name?: string;
  make?: string;
  model?: string;
  serial?: string;
  active?: boolean;
  scale?: number | null;
  transform?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  current_mode?: RawMode | null;
  modes?: RawMode[];
  focused?: boolean | null;
}

/**
 * Parses `swaymsg -t get_outputs`. The identifier is built exactly as sway
 * does it, `make + " " + model + " " + serial`, without trimming: a model with
 * a trailing space yields a double space, and that is what sway matches on.
 * Headless outputs are dropped. A disabled output has no rect and no current
 * mode; it gets its preferred mode so the UI can size it when re-enabling.
 */
export function parseOutputs(json: string): DisplayOutput[] {
  const raw = JSON.parse(json) as RawOutput[];
  if (!Array.isArray(raw)) throw new Error('get_outputs did not return a list');
  const out: DisplayOutput[] = [];
  for (const o of raw) {
    const name = o.name ?? '';
    if (!name || HIDDEN_NAME.test(name)) continue;
    const modes = dedupeModes(
      (o.modes ?? []).map(toMode).filter((m): m is DisplayMode => m !== null),
    );
    const current = toMode(o.current_mode ?? undefined);
    const mode = current ?? modes[0] ?? { width: 0, height: 0, refresh: 0 };
    if (current && !modes.some((m) => sameMode(m, current))) modes.unshift(current);
    const enabled = o.active === true;
    out.push({
      name,
      identifier: `${o.make ?? 'Unknown'} ${o.model ?? 'Unknown'} ${o.serial ?? 'Unknown'}`,
      make: o.make ?? 'Unknown',
      model: o.model ?? 'Unknown',
      serial: o.serial ?? 'Unknown',
      enabled,
      x: enabled ? (o.rect?.x ?? 0) : 0,
      y: enabled ? (o.rect?.y ?? 0) : 0,
      width: enabled ? (o.rect?.width ?? 0) : 0,
      height: enabled ? (o.rect?.height ?? 0) : 0,
      mode,
      modes,
      scale: typeof o.scale === 'number' && o.scale > 0 ? o.scale : 1,
      transform: toTransform(o.transform),
      focused: o.focused === true,
      workspaces: [],
    });
  }
  return out;
}

interface RawWorkspace {
  name?: string;
  output?: string;
  visible?: boolean;
  focused?: boolean;
}

/**
 * Attaches `swaymsg -t get_workspaces` to the outputs by connector name.
 * Workspaces on an output that is hidden or unknown are dropped; sway moves
 * them itself when the output goes away.
 */
export function attachWorkspaces(outputs: DisplayOutput[], json: string): DisplayOutput[] {
  const raw = JSON.parse(json) as RawWorkspace[];
  if (!Array.isArray(raw)) throw new Error('get_workspaces did not return a list');
  const byOutput = new Map<string, Workspace[]>();
  for (const w of raw) {
    if (typeof w.name !== 'string' || typeof w.output !== 'string') continue;
    const list = byOutput.get(w.output) ?? [];
    list.push({ name: w.name, visible: w.visible === true, focused: w.focused === true });
    byOutput.set(w.output, list);
  }
  return outputs.map((o) => ({ ...o, workspaces: byOutput.get(o.name) ?? [] }));
}

/** The one workspace with keyboard focus, if any output lists it. */
export function focusedWorkspace(outputs: DisplayOutput[]): string | null {
  for (const o of outputs) for (const w of o.workspaces) if (w.focused) return w.name;
  return null;
}

function toMode(m: RawMode | undefined): DisplayMode | null {
  if (!m || typeof m.width !== 'number' || typeof m.height !== 'number') return null;
  return {
    width: m.width,
    height: m.height,
    refresh: typeof m.refresh === 'number' ? m.refresh : 0,
  };
}

/**
 * sway lists one mode per aspect-ratio flag and several near-identical rates
 * (59.883, 59.901, 59.940 Hz …). The config cannot tell the flags apart and a
 * user cannot tell the rates apart, so one mode per resolution and whole hertz
 * is kept: the first one sway lists.
 */
function dedupeModes(modes: DisplayMode[]): DisplayMode[] {
  const seen = new Set<string>();
  return modes.filter((m) => {
    const key = `${m.width}x${m.height}@${Math.round(m.refresh / 1000)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sameMode(a: DisplayMode, b: DisplayMode): boolean {
  return a.width === b.width && a.height === b.height && a.refresh === b.refresh;
}

export function modeKey(m: DisplayMode): string {
  return `${m.width}x${m.height}@${m.refresh}`;
}

function toTransform(t: string | null | undefined): Transform {
  return TRANSFORMS.includes(t as Transform) ? (t as Transform) : 'normal';
}

/** `3440x1440@100.000Hz`, the form sway's config takes; refresh is millihertz. */
export function formatMode(m: DisplayMode): string {
  return m.refresh > 0
    ? `${m.width}x${m.height}@${(m.refresh / 1000).toFixed(3)}Hz`
    : `${m.width}x${m.height}`;
}

/** Human form: `3440×1440 @ 100 Hz`. */
export function describeMode(m: DisplayMode): string {
  const hz = m.refresh > 0 ? ` @ ${Math.round(m.refresh / 1000)} Hz` : '';
  return `${m.width}×${m.height}${hz}`;
}
