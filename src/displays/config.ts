/**
 * The `outputs.conf` writer and the layout checks that run before it.
 */
import type { DisplayLayout, DisplayOutput, LayoutEntry } from '../shared/types.js';
import { SCALES, TRANSFORMS } from '../shared/types.js';
import { normalize, overlappingPairs } from './geometry.js';
import { formatMode, sameMode } from './sway.js';

/** First line of every file this app writes; the app refuses to show a diff against anything else as "ours". */
export const HEADER =
  '# Written by btl-displays (BTL Device Manager). Edits here are replaced on the next Apply.';

/**
 * Renders the sway config. Outputs are addressed by identifier in double
 * quotes because identifiers contain spaces (and sometimes two in a row, when
 * a model string ends in one). Disabled outputs are written too, so a
 * re-plugged monitor that was switched off stays off instead of popping up
 * to the right of everything.
 */
export function renderConfig(layout: DisplayLayout): string {
  const lines = [
    HEADER,
    '# Positions are logical pixels, origin top-left; outputs are matched by "make model serial".',
    '',
  ];
  const entries = normalizeEnabled(layout.outputs);
  for (const e of entries) {
    lines.push(`# ${e.name}`);
    if (!e.enabled) {
      lines.push(`output ${quote(e.identifier)} disable`);
    } else {
      lines.push(
        `output ${quote(e.identifier)} enable pos ${e.x} ${e.y} mode ${formatMode(e.mode)} scale ${e.scale} transform ${e.transform}`,
      );
    }
  }
  const pinned = entries.filter((e) => e.workspaces.length > 0);
  if (pinned.length > 0) {
    lines.push('', '# Workspaces return to these outputs when a monitor is plugged back in.');
    for (const e of pinned) {
      for (const w of e.workspaces)
        lines.push(`workspace ${quote(w)} output ${quote(e.identifier)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Moves the enabled outputs to start at the origin; disabled ones keep their stored position. */
function normalizeEnabled(entries: LayoutEntry[]): LayoutEntry[] {
  const on = normalize(entries.filter((e) => e.enabled));
  return entries.map((e) => on.find((n) => n.identifier === e.identifier) ?? e);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Checks a layout against what sway currently reports. Returns the problems
 * as sentences; an empty list means the layout can be written.
 */
export function validateLayout(layout: DisplayLayout, known: DisplayOutput[]): string[] {
  const problems: string[] = [];
  if (layout.version !== 1 || !Array.isArray(layout.outputs))
    return ['layout file has an unknown shape'];
  const seen = new Set<string>();
  for (const e of layout.outputs) {
    const out = known.find((k) => k.identifier === e.identifier);
    if (!out) {
      problems.push(`${e.identifier}: not connected right now`);
      continue;
    }
    if (seen.has(e.identifier)) problems.push(`${out.name}: listed twice`);
    seen.add(e.identifier);
    if (!Number.isInteger(e.x) || !Number.isInteger(e.y))
      problems.push(`${out.name}: position must be whole pixels`);
    if (!out.modes.some((m) => sameMode(m, e.mode)))
      problems.push(`${out.name}: mode ${formatMode(e.mode)} is not offered by this output`);
    if (!SCALES.includes(e.scale))
      problems.push(`${out.name}: scale ${e.scale} is not one of ${SCALES.join(', ')}`);
    if (!TRANSFORMS.includes(e.transform))
      problems.push(`${out.name}: unknown transform ${String(e.transform)}`);
  }
  if (!layout.outputs.some((e) => e.enabled))
    problems.push('at least one output must stay enabled');
  const ws = new Set<string>();
  for (const e of layout.outputs) {
    for (const w of e.workspaces ?? []) {
      if (typeof w !== 'string' || w === '') problems.push(`${e.name}: empty workspace name`);
      else if (ws.has(w)) problems.push(`workspace ${w} is assigned to two outputs`);
      ws.add(w);
    }
  }
  for (const [a, b] of overlappingPairs(layout.outputs)) problems.push(`${a} and ${b} overlap`);
  return problems;
}

/** The layout that reproduces what sway shows now; the starting point for editing. */
export function layoutFromOutputs(outputs: DisplayOutput[]): DisplayLayout {
  return {
    version: 1,
    outputs: outputs.map((o) => ({
      identifier: o.identifier,
      name: o.name,
      enabled: o.enabled,
      x: o.x,
      y: o.y,
      mode: o.mode,
      scale: o.scale,
      transform: o.transform,
      workspaces: o.workspaces.map((w) => w.name),
    })),
  };
}
