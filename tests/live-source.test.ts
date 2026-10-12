import { describe, expect, it } from 'vitest';
import { LiveSource } from '../src/server/cli-source.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('LiveSource', () => {
  it('runs only while someone watches and stops after the last watcher leaves', async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const src = new LiveSource(
      '/x/cli',
      ['perf', '--json'],
      (t) => JSON.parse(t) as { n: number },
      () => {
        runs++;
        return new Promise<string>((resolve) => {
          release = () => resolve(JSON.stringify({ n: runs }));
        });
      },
    );
    const seen: number[] = [];
    src.onSample = (r) => seen.push(r.n);
    expect(runs).toBe(0);
    src.watch(true);
    src.watch(true);
    await tick();
    expect(runs).toBe(1);
    release();
    await tick();
    expect(seen).toEqual([1]);
    src.watch(false);
    expect(src.watching).toBe(1);
    src.watch(false);
    expect(src.watching).toBe(0);
    src.watch(false);
    expect(src.watching).toBe(0);
  });

  it('reports a failed run and keeps going', async () => {
    const errors: string[] = [];
    const src = new LiveSource(
      '/x/cli',
      [],
      () => 1,
      () => Promise.reject(new Error('boom')),
    );
    src.onError = (e) => errors.push(e);
    src.watch(true);
    await tick();
    expect(errors).toEqual(['boom']);
    src.stop();
  });
});
