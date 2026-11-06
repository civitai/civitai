import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as FeedbackService from '~/server/services/feedback.service';
import type * as SemanticSearch from '~/server/services/semantic-image-search.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Both procedures spend (an embedding per new query) or write (a Feedback row), and the flag is
// the only thing that keeps them to devs, mods and testers.

const h = vi.hoisted(() => ({
  flagOn: false,
  search: vi.fn(),
  createFeedback: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ semanticImageSearch: h.flagOn }),
}));
vi.mock('~/server/services/semantic-image-search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SemanticSearch>()),
  searchSemanticImages: h.search,
}));
vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  createFeedback: h.createFeedback,
  isFeedbackAreaEnabled: async () => true,
}));

import { semanticImageSearchRouter } from '~/server/routers/semantic-image-search.router';

const caller = () =>
  semanticImageSearchRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 7, isModerator: false, muted: false, onboarding: 0x1f, emailVerified: new Date() },
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    features: {},
    track: { search: vi.fn().mockResolvedValue(undefined) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.search.mockResolvedValue({ items: [], nextCursor: undefined });
  h.createFeedback.mockResolvedValue({ id: 1 });
});

describe('semanticImageSearch router', () => {
  it('refuses search without the flag', async () => {
    h.flagOn = false;
    await expect(caller().search({ query: 'fox' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('refuses feedback without the flag', async () => {
    h.flagOn = false;
    await expect(caller().feedback({ rating: 'up' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.createFeedback).not.toHaveBeenCalled();
  });

  it('serves both with the flag', async () => {
    h.flagOn = true;
    await caller().search({ query: 'fox' });
    await caller().feedback({ rating: 'down', comment: 'not foxes' });
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, area: 'semantic-image-search', message: 'not foxes' })
    );
  });
});
