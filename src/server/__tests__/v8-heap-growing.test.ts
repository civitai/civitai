import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeapGrowingPercent } from '~/server/v8-heap-growing';

const ENV = 'V8_HEAP_GROWING_PERCENT';

describe('applyHeapGrowingPercent', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    vi.restoreAllMocks();
  });

  it('does nothing when the env var is unset', () => {
    const setFlags = vi.fn();
    expect(applyHeapGrowingPercent(undefined, setFlags)).toBeUndefined();
    expect(setFlags).not.toHaveBeenCalled();
  });

  it('reads the env var and sets the exact V8 flag', () => {
    process.env[ENV] = '37';
    const setFlags = vi.fn();
    expect(applyHeapGrowingPercent(undefined, setFlags)).toBe(37);
    expect(setFlags).toHaveBeenCalledTimes(1);
    expect(setFlags).toHaveBeenCalledWith('--heap-growing-percent=37');
  });

  it.each([
    ['1', '--heap-growing-percent=1'],
    ['400', '--heap-growing-percent=400'],
    ['050', '--heap-growing-percent=50'],
  ])('accepts %s', (raw, flag) => {
    const setFlags = vi.fn();
    applyHeapGrowingPercent(raw, setFlags);
    expect(setFlags).toHaveBeenCalledWith(flag);
  });

  it.each(['', '0', '401', '1000', '-5', '30.5', '1e2', '30abc', ' 30', 'abc'])(
    'ignores %j',
    (raw) => {
      const setFlags = vi.fn();
      expect(applyHeapGrowingPercent(raw, setFlags)).toBeUndefined();
      expect(setFlags).not.toHaveBeenCalled();
    }
  );
});
