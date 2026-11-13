import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
}));

import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import {
  isSiteSearchPassthroughOn,
  resetSiteSearchPassthroughForTests,
} from '~/server/services/site-search-passthrough';

const flag = vi.mocked(isFliptSync);

beforeEach(() => {
  vi.clearAllMocks();
  resetSiteSearchPassthroughForTests();
});

describe('isSiteSearchPassthroughOn', () => {
  it('is on when Flipt says the site-search-passthrough flag is on', () => {
    flag.mockReturnValue(true);
    expect(isSiteSearchPassthroughOn()).toBe(true);
    expect(flag).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.SITE_SEARCH_PASSTHROUGH);
  });

  it('is off when the flag is unknown to Flipt', () => {
    flag.mockReturnValue(null);
    expect(isSiteSearchPassthroughOn()).toBe(false);
  });

  it('is off when the Flipt read throws', () => {
    flag.mockImplementation(() => {
      throw new Error('eval failed');
    });
    expect(isSiteSearchPassthroughOn()).toBe(false);
  });
});
