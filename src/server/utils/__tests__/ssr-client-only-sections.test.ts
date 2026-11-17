import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The `ssr-client-only-sections` switch as the pages read it: on only when Flipt answers true for
 * exactly that key; unknown, uninitialised and throwing all read as off (today's render).
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { isFliptSync, ensureFliptInitialized, getFliptClientSync } = await import(
  '~/server/flipt/client'
);
const { ssrClientOnlySectionsOn, resetSsrClientOnlySectionsGateForTests } = await import(
  '~/server/utils/ssr-client-only-sections'
);

const answer = (on: boolean | null, key = 'ssr-client-only-sections') =>
  vi.mocked(isFliptSync).mockImplementation(((k: string) => (k === key ? on : null)) as never);

beforeEach(() => {
  vi.mocked(isFliptSync).mockReset();
  vi.mocked(getFliptClientSync).mockReturnValue({} as never);
  vi.mocked(ensureFliptInitialized).mockClear();
  resetSsrClientOnlySectionsGateForTests();
});

describe('ssrClientOnlySectionsOn', () => {
  it('is on when Flipt answers true for `ssr-client-only-sections`', () => {
    answer(true);
    expect(ssrClientOnlySectionsOn()).toBe(true);
  });

  it('is off when only some other key is on', () => {
    answer(true, 'bot-html-edge-cache');
    expect(ssrClientOnlySectionsOn()).toBe(false);
  });

  it.each([false, null])('is off when Flipt answers %s', (on) => {
    answer(on);
    expect(ssrClientOnlySectionsOn()).toBe(false);
  });

  it('is off when the read throws', () => {
    vi.mocked(isFliptSync).mockImplementation(() => {
      throw new Error('flipt down');
    });
    expect(ssrClientOnlySectionsOn()).toBe(false);
  });

  it('starts the Flipt client when it has none yet, and reads off meanwhile', () => {
    answer(null);
    vi.mocked(getFliptClientSync).mockReturnValue(null as never);
    expect(ssrClientOnlySectionsOn()).toBe(false);
    expect(ensureFliptInitialized).toHaveBeenCalledTimes(1);
  });

  it('reads Flipt once per window, not once per render', () => {
    answer(true);
    for (let i = 0; i < 5; i++) ssrClientOnlySectionsOn();
    expect(isFliptSync).toHaveBeenCalledTimes(1);
  });
});
