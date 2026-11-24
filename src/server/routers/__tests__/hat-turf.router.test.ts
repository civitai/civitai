import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TurfService from '~/server/events/turf/turf.service';

// Rate limiting and edge caching no-op outside prod, hence the env mock.

const { mockStickers, mockSetOptIn, mockSummaries, mockWatch } = vi.hoisted(() => ({
  mockStickers: vi.fn(),
  mockSetOptIn: vi.fn(),
  mockSummaries: vi.fn(),
  mockWatch: vi.fn(),
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/events/turf/turf.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TurfService>()),
  getTurfStickersForImages: (...args: unknown[]) => mockStickers(...args),
  setTurfOptIn: (...args: unknown[]) => mockSetOptIn(...args),
  getTurfSummaries: (...args: unknown[]) => mockSummaries(...args),
  watchTurfImages: (...args: unknown[]) => mockWatch(...args),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { hatTurfRouter } from '../hat-turf.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function callerAs(user?: Record<string, unknown>) {
  const cache = { edgeTTL: 0, browserTTL: 0, canCache: true, skip: false } as Record<
    string,
    unknown
  >;
  const trackAction = vi.fn(() => Promise.resolve(true));
  const caller = hatTurfRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    ip: '203.0.113.9',
    req: { headers: { 'x-forwarded-for': '203.0.113.9' }, query: {}, url: '/api/trpc/x' },
    res: { setHeader: () => undefined },
    cache,
    features: {},
    track: { action: trackAction },
  } as never);
  return { caller, cache, trackAction };
}

beforeEach(() => {
  mockStickers.mockReset();
  mockStickers.mockResolvedValue({ 1: [] });
  mockSetOptIn.mockReset();
  mockSummaries.mockReset();
  mockSummaries.mockResolvedValue({ ...SUMMARIES, joined: true });
  mockWatch.mockReset();
  mockWatch.mockImplementation(async (_event: string, ids: number[]) => new Set(ids).size);
  redisMock.redis.packed.hGet.mockReset();
});

const SUMMARIES = { team: 'Blue', images: {}, open: {}, mine: {}, hidden: {} };

// Public, and runs a window query over up to 100 caller-chosen ids.
describe('hatTurf.getStickersForImages', () => {
  const input = { event: 'birthday2026', imageIds: [1, 2, 3], perImage: 3 };

  it('refuses a signed-out caller over 60 calls a minute', async () => {
    const now = Date.now();
    redisMock.redis.packed.hGet.mockResolvedValue(Array.from({ length: 61 }, () => now));
    const { caller } = callerAs();
    await expect(caller.getStickersForImages(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockStickers).not.toHaveBeenCalled();
  });

  it('marks the response edge cacheable', async () => {
    const { caller, cache } = callerAs();
    await caller.getStickersForImages(input);
    expect(mockStickers).toHaveBeenCalledTimes(1);
    expect(cache.edgeTTL).toBe(60);
  });
});

// A joined viewer's read marks its images watched, standing in for the page's own hatTurf.watch.
describe('hatTurf.getSummaries with watch', () => {
  const player = { id: 42, isModerator: false, username: 'player' };
  const input = { event: 'birthday2026', imageIds: [11, 12, 13], watch: true };

  it("marks a joined viewer's images, the whole page in one call, and says so", async () => {
    const { caller } = callerAs(player);
    await expect(caller.getSummaries(input)).resolves.toMatchObject({ watched: true });
    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(mockWatch).toHaveBeenCalledWith('birthday2026', [11, 12, 13], { limit: 3 });
  });

  it('marks nothing for a viewer not in Hat Turf, a signed-out caller, or a read without watch', async () => {
    mockSummaries.mockResolvedValue({ ...SUMMARIES, joined: false });
    await expect(callerAs(player).caller.getSummaries(input)).resolves.toMatchObject({
      watched: false,
    });
    mockSummaries.mockResolvedValue({ ...SUMMARIES, joined: true });
    await expect(callerAs().caller.getSummaries(input)).resolves.toMatchObject({ watched: false });
    await expect(
      callerAs(player).caller.getSummaries({ ...input, watch: undefined })
    ).resolves.toMatchObject({ watched: false });
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it("draws on the watch's 60-a-minute budget: past it, the read still answers and marks nothing", async () => {
    const now = Date.now();
    redisMock.redis.packed.hGet.mockResolvedValue(Array.from({ length: 61 }, () => now));
    const { caller } = callerAs(player);
    await expect(caller.getSummaries(input)).resolves.toMatchObject({
      team: 'Blue',
      watched: false,
    });
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it('says not watched when the set refused some of the images, so the page marks them itself', async () => {
    mockWatch.mockResolvedValue(2);
    const { caller } = callerAs(player);
    await expect(caller.getSummaries(input)).resolves.toMatchObject({ watched: false });
  });

  it('a failed mark never fails the read', async () => {
    mockWatch.mockRejectedValue(new Error('cache cluster down'));
    const { caller } = callerAs(player);
    await expect(caller.getSummaries(input)).resolves.toMatchObject({
      team: 'Blue',
      watched: false,
    });
  });
});

// The opt-in analytics count each join or leave once, so a repeated toggle must not emit.
describe('hatTurf.setOptIn tracking', () => {
  const player = { id: 42, isModerator: false, username: 'player' };
  const input = { event: 'birthday2026', optedIn: true };

  it('emits one opt_in action when the setting changed', async () => {
    mockSetOptIn.mockResolvedValue({ changed: true, event: 'birthday2026' });
    const { caller, trackAction } = callerAs(player);
    await caller.setOptIn(input);
    expect(trackAction).toHaveBeenCalledTimes(1);
    expect(trackAction).toHaveBeenCalledWith(
      { type: 'HatTurf_Action', details: { action: 'opt_in', event: 'birthday2026' } },
      { skipActorMeta: true }
    );
  });

  it('emits opt_out when the player turned it off', async () => {
    mockSetOptIn.mockResolvedValue({ changed: true, event: 'birthday2026' });
    const { caller, trackAction } = callerAs(player);
    await caller.setOptIn({ ...input, optedIn: false });
    expect(trackAction).toHaveBeenCalledWith(
      { type: 'HatTurf_Action', details: { action: 'opt_out', event: 'birthday2026' } },
      { skipActorMeta: true }
    );
  });

  it('emits nothing when the setting was already that value', async () => {
    mockSetOptIn.mockResolvedValue({ changed: false, event: 'birthday2026' });
    const { caller, trackAction } = callerAs(player);
    await caller.setOptIn(input);
    expect(mockSetOptIn).toHaveBeenCalledTimes(1);
    expect(trackAction).not.toHaveBeenCalled();
  });
});
