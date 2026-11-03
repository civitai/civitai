import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
}));

import { isFliptSync } from '~/server/flipt/client';
import {
  registerMantineUseStylesHoistGate,
  setMantineUseStylesHoistGate,
} from '~/server/utils/mantine-styles-hoist-gate';

const flag = vi.mocked(isFliptSync);
// The literal, not the exported constant: the patched Mantine files hardcode this string.
const KEY = Symbol.for('civitai.mantine.useStylesHoist');
const installed = () => (globalThis as unknown as Record<symbol, unknown>)[KEY];

afterEach(() => {
  setMantineUseStylesHoistGate(undefined);
  vi.clearAllMocks();
});

describe('registerMantineUseStylesHoistGate', () => {
  it('installs a gate that reads ssr-mantine-usestyles-hoist', () => {
    flag.mockReturnValue(true);
    registerMantineUseStylesHoistGate();
    const gate = installed() as () => boolean;
    expect(typeof gate).toBe('function');
    expect(gate()).toBe(true);
    expect(flag).toHaveBeenCalledWith('ssr-mantine-usestyles-hoist');
  });

  it.each([false, null])('reads %s as off', (value) => {
    flag.mockReturnValue(value);
    registerMantineUseStylesHoistGate();
    expect((installed() as () => boolean)()).toBe(false);
  });

  it('removes the gate when given undefined', () => {
    setMantineUseStylesHoistGate(() => true);
    expect(typeof installed()).toBe('function');
    setMantineUseStylesHoistGate(undefined);
    expect(installed()).toBeUndefined();
  });
});
