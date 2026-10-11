/**
 * Logical geometry of outputs, shared by the canvas in the browser and the
 * validation in the CLI. sway positions outputs in logical pixels: the mode
 * divided by the scale, with width and height swapped for 90° rotations.
 */
import type { DisplayMode, LayoutEntry, Transform } from '../shared/types.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Logical size of an output after scale and transform. */
export function logicalSize(
  mode: DisplayMode,
  scale: number,
  transform: Transform,
): { width: number; height: number } {
  const w = Math.round(mode.width / scale);
  const h = Math.round(mode.height / scale);
  return /(^|-)(90|270)$/.test(transform) ? { width: h, height: w } : { width: w, height: h };
}

export function entryRect(e: LayoutEntry): Rect {
  return { x: e.x, y: e.y, ...logicalSize(e.mode, e.scale, e.transform) };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Snaps a dragged rectangle to the edges of its neighbours and to the origin,
 * independently per axis. Aligning edges is what makes the mouse cross between
 * monitors without a gap or a step, and it is far easier than checking for
 * gaps after the fact.
 */
export function snap(moving: Rect, others: Rect[], threshold: number): { x: number; y: number } {
  const xs = [
    0,
    ...others.flatMap((o) => [
      o.x,
      o.x + o.width,
      o.x - moving.width,
      o.x + o.width - moving.width,
    ]),
  ];
  const ys = [
    0,
    ...others.flatMap((o) => [
      o.y,
      o.y + o.height,
      o.y - moving.height,
      o.y + o.height - moving.height,
    ]),
  ];
  return { x: nearest(moving.x, xs, threshold), y: nearest(moving.y, ys, threshold) };
}

function nearest(v: number, candidates: number[], threshold: number): number {
  let best = v;
  let dist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d < dist) {
      dist = d;
      best = c;
    }
  }
  return Math.round(best);
}

/** Shifts all rectangles so the arrangement starts at the origin, as sway expects. */
export function normalize<T extends { x: number; y: number }>(items: T[]): T[] {
  if (items.length === 0) return items;
  const dx = Math.min(...items.map((i) => i.x));
  const dy = Math.min(...items.map((i) => i.y));
  return items.map((i) => ({ ...i, x: i.x - dx, y: i.y - dy }));
}

/** Enabled outputs that overlap, as pairs of connector names, for the user to fix. */
export function overlappingPairs(entries: LayoutEntry[]): [string, string][] {
  const on = entries.filter((e) => e.enabled);
  const pairs: [string, string][] = [];
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      if (overlaps(entryRect(on[i]!), entryRect(on[j]!))) pairs.push([on[i]!.name, on[j]!.name]);
    }
  }
  return pairs;
}
