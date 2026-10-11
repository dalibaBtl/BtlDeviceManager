import { describe, expect, it } from 'vitest';
import {
  logicalSize,
  normalize,
  overlappingPairs,
  overlaps,
  snap,
} from '../src/displays/geometry.js';
import type { LayoutEntry } from '../src/shared/types.js';

const mode = { width: 3440, height: 1440, refresh: 100000 };

describe('logicalSize', () => {
  it('divides by scale and swaps for quarter turns', () => {
    expect(logicalSize(mode, 1, 'normal')).toEqual({ width: 3440, height: 1440 });
    expect(logicalSize(mode, 2, 'normal')).toEqual({ width: 1720, height: 720 });
    expect(logicalSize(mode, 1.5, '90')).toEqual({ width: 960, height: 2293 });
    expect(logicalSize(mode, 1, 'flipped-270')).toEqual({ width: 1440, height: 3440 });
    expect(logicalSize(mode, 1, 'flipped-180')).toEqual({ width: 3440, height: 1440 });
  });
});

describe('snap', () => {
  const other = { x: 1920, y: 0, width: 3440, height: 1440 };
  it('aligns to a neighbour edge within the threshold, per axis', () => {
    expect(snap({ x: 5363, y: 7, width: 1920, height: 1200 }, [other], 20)).toEqual({
      x: 5360,
      y: 0,
    });
    expect(snap({ x: 12, y: 230, width: 1920, height: 1200 }, [other], 20)).toEqual({
      x: 0,
      y: 240,
    });
  });
  it('leaves a far position alone, rounded', () => {
    expect(snap({ x: 700.4, y: 500, width: 100, height: 100 }, [other], 20)).toEqual({
      x: 700,
      y: 500,
    });
  });
});

describe('overlaps and normalize', () => {
  it('detects overlap, not touching edges', () => {
    expect(
      overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBe(false);
    expect(
      overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 10, height: 10 }),
    ).toBe(true);
  });
  it('moves the arrangement to the origin', () => {
    expect(
      normalize([
        { x: 100, y: 50 },
        { x: 300, y: 80 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 30 },
    ]);
  });
  it('names overlapping enabled outputs only', () => {
    const e = (name: string, x: number, enabled = true): LayoutEntry => ({
      identifier: name,
      name,
      enabled,
      x,
      y: 0,
      mode,
      scale: 1,
      transform: 'normal',
      workspaces: [],
    });
    expect(overlappingPairs([e('A', 0), e('B', 3440), e('C', 100, false)])).toEqual([]);
    expect(overlappingPairs([e('A', 0), e('B', 3000)])).toEqual([['A', 'B']]);
  });
});
