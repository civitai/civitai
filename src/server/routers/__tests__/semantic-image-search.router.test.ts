import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as FeedbackService from '~/server/services/feedback.service';
import type * as SemanticSearch from '~/server/services/semantic-image-search.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Both procedures spend (an embedding per new query) or write (a Feedback row), and the flag keeps
// them to devs, mods and testers. The one exception: search of the caller's own images (below).

const h = vi.hoisted(() => ({
  flagOn: false,
  feedOn: false,
  search: vi.fn(),
  createFeedback: vi.fn(),
  trackSearch: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ imageSearch: h.flagOn, feedSearch: h.feedOn }),
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

import {
  OWN_IMAGES_FLOOR_MS,
  OWN_IMAGES_JITTER_MS,
  semanticImageSearchRouter,
} from '~/server/routers/semantic-image-search.router';

const VIEWER = {
  id: 7,
  username: 'Fox',
  isModerator: false,
  muted: false,
  onboarding: 0x1f,
  emailVerified: new Date(),
};
const caller = (user: typeof VIEWER | null = VIEWER, credential: object = {}) =>
  semanticImageSearchRouter.createCaller({
    acceptableOrigin: true,
    user: user ?? undefined,
    tokenScope: TokenScope.Full,
    ...credential,
    req: { headers: {} },
    features: {},
    track: { search: h.trackSearch },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.search.mockResolvedValue({ items: [], nextCursor: undefined });
  h.createFeedback.mockResolvedValue({ id: 1 });
  h.trackSearch.mockResolvedValue(undefined);
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

  it('serves search to a signed-out visitor with the flag', async () => {
    h.flagOn = true;
    await caller(null).search({ query: 'fox' });
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ user: undefined }));
  });

  // The procedure takes the full scope, so the narrowed credential that reaches it is an app's
  // token: full scope, but issued to an OAuth client, never a full user credential.
  it.each([
    ['an app token', { subject: { type: 'oauth', id: 'app' }, tokenScope: TokenScope.Full }, false],
    ['a session (control)', {}, true],
  ])(
    'searches for a moderator on %s with moderator and owner views: %s',
    async (_, credential, views) => {
      h.flagOn = true;
      await caller({ ...VIEWER, isModerator: true }, credential).search({ query: 'fox' });
      expect(h.search).toHaveBeenCalledWith(
        expect.objectContaining({ asModerator: views, asOwner: views })
      );
    }
  );

  it('refuses feedback from a signed-out visitor', async () => {
    h.flagOn = true;
    await expect(caller(null).feedback({ rating: 'up' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
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

// The showcase picker searches the owner's images for users without image search. Only a request
// naming exactly the caller's own username passes, and it reaches the service as their id.
describe('semanticImageSearch router — own images without the flag', () => {
  beforeEach(() => {
    h.flagOn = false;
    h.feedOn = false;
  });

  // The viewer is 'Fox': the name is matched case-insensitively, as usernames are unique that way.
  it('serves a signed-in user their own images, narrowed to their id', async () => {
    await caller().search({ query: 'kuro', usernames: ['FOX'], limit: 7, browsingLevel: 3 });
    expect(h.search).toHaveBeenCalledTimes(1);
    const { input } = h.search.mock.calls[0][0];
    expect(input).toMatchObject({ query: 'kuro', limit: 7, browsingLevel: 3, userIds: [7] });
    expect(input.usernames).toBeUndefined();
  });

  it('passes the service only the query, page size, browsing level and their id', async () => {
    await caller().search({
      query: 'kuro',
      usernames: ['fox'],
      limit: 7,
      browsingLevel: 3,
      tagNames: ['cat'],
      baseModels: ['SDXL 1.0'],
      postedAfter: new Date('2025-01-01'),
    });
    expect(h.search.mock.calls[0][0].input).toEqual({
      query: 'kuro',
      limit: 7,
      browsingLevel: 3,
      userIds: [7],
    });
    expect(h.search.mock.calls[0][0].refuseNarrowing).toBe(true);
  });

  it('logs the search as it ran, not as it was asked', async () => {
    await caller().search({ query: 'kuro', usernames: ['fox'], tagNames: ['cat'] });
    const { filters } = h.trackSearch.mock.calls[0][0];
    expect(filters).toMatchObject({ userIds: [7] });
    expect(filters.usernames).toBeUndefined();
    expect(filters.tagNames).toBeUndefined();
  });

  it('caps the page size at the picker’s', async () => {
    await caller().search({ query: 'kuro', usernames: ['fox'], limit: 100 });
    expect(h.search.mock.calls[0][0].input.limit).toBe(25);
  });

  it('answers in the same shape whatever the search found, with no timing', async () => {
    h.search.mockResolvedValue({ items: [{ id: 1 }], nextCursor: 50, correctedQuery: 'kuro' });
    const result = await caller().search({ query: 'kuro', usernames: ['fox'] });
    expect(result).toEqual({
      items: [{ id: 1 }],
      nextCursor: undefined,
      correctedQuery: undefined,
      latencyMs: 0,
    });
  });

  it.each([
    ['another user', { usernames: ['vixen'] }],
    ['their own name mixed with another', { usernames: ['fox', 'vixen'] }],
    ['no owner at all', {}],
    ['an id beside their name', { usernames: ['fox'], userIds: [8] }],
    ['a page past the first', { usernames: ['fox'], cursor: 50 }],
    ['a similar-image search', { usernames: ['fox'], imageId: 5 }],
  ])('refuses %s', async (_, scope) => {
    await expect(caller().search({ query: 'kuro', ...scope })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('refuses a signed-out visitor, even naming a user', async () => {
    await expect(caller(null).search({ query: 'kuro', usernames: ['fox'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.search).not.toHaveBeenCalled();
  });

  it.each([
    ['imageSearch', () => (h.flagOn = true)],
    ['feedSearch', () => (h.feedOn = true)],
  ])('leaves a request with %s as it was', async (_, turnOn) => {
    turnOn();
    await caller().search({ query: 'kuro', usernames: ['vixen'] });
    const { input } = h.search.mock.calls[0][0];
    expect(input.usernames).toEqual(['vixen']);
    expect(h.search.mock.calls[0][0].refuseNarrowing).toBe(false);
    expect(input.userIds).toBeUndefined();
  });
});

// Ruled with moderation: every own-images answer waits for the same jittered floor, whatever the
// search found and however it got there (a cached search answers as fast as a refusal). Holding
// only empty answers would let a repeat of a cached query be told apart. Do not narrow it.
describe('semanticImageSearch router — own-images answer time', () => {
  const hold = OWN_IMAGES_FLOOR_MS + OWN_IMAGES_JITTER_MS * 0.5;
  const after = (ms: number, items: { id: number }[] = []) =>
    h.search.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ items }), ms))
    );
  const start = (own = true) => {
    let settled = false;
    const done = caller()
      .search({ query: 'kuro', usernames: own ? ['fox'] : undefined })
      .finally(() => (settled = true));
    return { done, settled: () => settled };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    h.flagOn = false;
    h.feedOn = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(Math.random).mockRestore();
  });

  it.each([
    ['that found images (a cached search)', [{ id: 1 }]],
    ['that found nothing (a refusal)', []],
  ])('holds an instant answer %s until the jittered floor', async (_, items) => {
    after(0, items);
    const run = start();
    await vi.advanceTimersByTimeAsync(hold - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.settled()).toBe(true);
    expect((await run.done).items).toEqual(items);
  });

  it('holds a failed search until the jittered floor too', async () => {
    h.search.mockRejectedValue(new Error('search service unavailable'));
    let settled = false;
    const done = caller()
      .search({ query: 'kuro', usernames: ['fox'] })
      .then(
        () => 'resolved',
        (error: Error) => error.message
      )
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(hold - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toBe('search service unavailable');
  });

  it('does not hold a search that took longer than the floor', async () => {
    after(hold + 300);
    const run = start();
    await vi.advanceTimersByTimeAsync(hold + 300);
    expect(run.settled()).toBe(true);
  });

  it('logs the own-images search with its time before the hold', async () => {
    after(100);
    const run = start();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.trackSearch.mock.calls[0]?.[0].filters).toMatchObject({
      ownImages: true,
      latencyMs: 100,
    });
    await vi.runAllTimersAsync();
    await run.done;
  });

  it('does not hold the flagged search', async () => {
    h.flagOn = true;
    after(0);
    const run = start(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settled()).toBe(true);
    expect(h.trackSearch.mock.calls[0][0].filters.ownImages).toBeUndefined();
  });
});
