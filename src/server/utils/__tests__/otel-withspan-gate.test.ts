import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
}));

import { isFliptSync } from '~/server/flipt/client';
import { setWithSpanSkipUnsampledGate } from '@civitai/telemetry/otel-helpers';
import {
  createCachedFlagGate,
  registerWithSpanSkipUnsampledGate,
  WITHSPAN_GATE_REFRESH_MS,
} from '~/server/utils/otel-withspan-gate';

const flag = vi.mocked(isFliptSync);

afterEach(() => {
  setWithSpanSkipUnsampledGate(undefined);
  vi.clearAllMocks();
});

describe('createCachedFlagGate', () => {
  it('reads once per refresh window and re-reads at the window boundary', () => {
    let t = 1_000;
    const answers = [true, false];
    const read = vi.fn(() => answers.shift() ?? null);
    const gate = createCachedFlagGate(read, 5_000, () => t);

    expect(gate()).toBe(true); // first call reads
    t = 3_500; // middle of the window
    expect(gate()).toBe(true);
    t = 5_999; // last millisecond of the window
    expect(gate()).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    t = 6_000; // boundary: re-read
    expect(gate()).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('treats null (unknown flag / Flipt not ready) and a throwing read as off', () => {
    let t = 0;
    const nullGate = createCachedFlagGate(
      () => null,
      10,
      () => t
    );
    expect(nullGate()).toBe(false);

    const throwingGate = createCachedFlagGate(
      () => {
        throw new Error('eval failed');
      },
      10,
      () => t
    );
    expect(throwingGate()).toBe(false);
    t = 10;
    expect(throwingGate()).toBe(false);
  });

  it('defaults to a five-second window', () => {
    expect(WITHSPAN_GATE_REFRESH_MS).toBe(5_000);
  });
});

describe('registerWithSpanSkipUnsampledGate', () => {
  it('installs a gate on the shared state that reads the otel-withspan-skip-unsampled flag', () => {
    expect(globalThis.__civitaiWithSpanSkipUnsampledGate?.gate).toBeUndefined();
    flag.mockReturnValue(true);

    registerWithSpanSkipUnsampledGate();

    const gate = globalThis.__civitaiWithSpanSkipUnsampledGate?.gate;
    expect(gate).toBeTypeOf('function');
    expect(gate!()).toBe(true);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag).toHaveBeenCalledWith('otel-withspan-skip-unsampled');
  });

  it('reads as off while Flipt answers null', () => {
    flag.mockReturnValue(null);
    registerWithSpanSkipUnsampledGate();
    expect(globalThis.__civitaiWithSpanSkipUnsampledGate?.gate!()).toBe(false);
  });
});
