import { describe, expect, it } from 'vitest';
import { trapTarget } from './modal';

describe('trapTarget', () => {
  it('lets the browser move focus inside the dialog', () => {
    expect(trapTarget(1, 3, false)).toBeNull();
    expect(trapTarget(1, 3, true)).toBeNull();
  });

  it('wraps from the last control to the first, and back', () => {
    expect(trapTarget(2, 3, false)).toBe(0);
    expect(trapTarget(0, 3, true)).toBe(2);
  });

  it('pulls focus in from outside the dialog', () => {
    expect(trapTarget(-1, 3, false)).toBe(0);
    expect(trapTarget(-1, 3, true)).toBe(2);
  });

  it('keeps focus where it is when there is a single control', () => {
    expect(trapTarget(0, 1, false)).toBe(0);
    expect(trapTarget(0, 1, true)).toBe(0);
  });

  it('has nowhere to send focus without controls', () => {
    expect(trapTarget(-1, 0, false)).toBeNull();
  });
});
