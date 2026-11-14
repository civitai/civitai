import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectsAllowed, pointerOffset } from './pointer-fx';

describe('pointerOffset', () => {
  const box = { left: 100, top: 50, width: 200, height: 100 };

  it('is 0 at the centre and +-1 at the edges', () => {
    expect(pointerOffset(200, 100, box)).toEqual({ x: 0, y: 0 });
    expect(pointerOffset(100, 50, box)).toEqual({ x: -1, y: -1 });
    expect(pointerOffset(300, 150, box)).toEqual({ x: 1, y: 1 });
  });

  it('never leaves -1..1 for a point outside the box', () => {
    expect(pointerOffset(-500, 900, box)).toEqual({ x: -1, y: 1 });
  });

  it('is 0 for an empty box', () => {
    expect(pointerOffset(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('effectsAllowed', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (matches: Record<string, boolean>) =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: Boolean(matches[query]) }));

  it('needs a fine pointer and no reduced-motion request', () => {
    stub({ '(hover: hover) and (pointer: fine)': true });
    expect(effectsAllowed()).toBe(true);
  });

  it('is off on touch', () => {
    stub({});
    expect(effectsAllowed()).toBe(false);
  });

  it('is off under reduced motion, even with a mouse', () => {
    stub({ '(hover: hover) and (pointer: fine)': true, '(prefers-reduced-motion: reduce)': true });
    expect(effectsAllowed()).toBe(false);
  });
});
