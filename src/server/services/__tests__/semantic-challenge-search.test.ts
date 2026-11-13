import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQdrantFilter,
  type CandidateFilter,
  type CandidateSource,
} from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockImplementation(async () => undefined);

const h = vi.hoisted(() => ({
  feedCalls: [] as Record<string, unknown>[],
  // Ids the feed's own query drops (its visibility rule says no).
  hidden: new Set<number>(),
  includesInappropriate: vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | false>(),
  evalBoolean: vi.fn<() => { enabled: unknown }>(),
  fliptClient: null as null | { evaluateBoolean: () => { enabled: unknown } },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureFliptInitialized: async () => undefined,
  getFliptClientSync: () => h.fliptClient,
}));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/utils/metadata/audit', () => ({
  includesInappropriate: h.includesInappropriate,
  includesPoi: () => false,
  includesMinor: () => false,
}));
vi.mock('~/server/services/system-cache', () => ({ getBrowsingSettingAddons: async () => [] }));
// The feed's query: ids >= 20 are user challenges by creator 7, the rest System challenges.
vi.mock('~/server/services/challenge.service', () => ({
  getInfiniteChallenges: async (input: { ids: number[] } & Record<string, unknown>) => {
    h.feedCalls.push(input);
    return {
      items: input.ids
        .filter((id) => !h.hidden.has(id))
        // Newest first, not rank order.
        .sort((a, b) => b - a)
        .map((id) => ({
          id,
          source: id >= 20 ? 'User' : 'System',
          createdById: id >= 20 ? 7 : -1,
        })),
      nextCursor: undefined,
    };
  },
}));

const { searchSemanticChallenges, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-challenge-search.service'
);

const NOW = new Date('2026-11-13T00:00:00Z');
const run = (
  ranked: number[],
  {
    input = {},
    user,
    isGreen = false,
    cap,
    correctedQuery,
  }: {
    input?: Record<string, unknown>;
    user?: SessionUser;
    isGreen?: boolean;
    cap?: number;
    correctedQuery?: string;
  } = {}
) => {
  const filters: CandidateFilter[] = [];
  const candidateSource: CandidateSource = async ({ filter, offset, limit }) => {
    filters.push(filter);
    return { ids: ranked.slice(offset, offset + limit), correctedQuery };
  };
  const result = searchSemanticChallenges({
    input: {
      query: 'neon cities',
      browsingLevel: 31,
      includeEnded: false,
      excludeEventChallenges: false,
      limit: 20,
      ...input,
    } as never,
    user,
    isGreen,
    canAccessUserChallenges: true,
    browsingLevelCap: cap,
    candidateSource,
    now: () => NOW,
  });
  return { result, filters };
};

beforeEach(() => {
  h.feedCalls = [];
  h.hidden = new Set();
  h.includesInappropriate.mockReset().mockReturnValue(false);
  // The containment switch reads enabled (clamped) unless a test lifts it.
  h.evalBoolean.mockReset().mockReturnValue({ enabled: true });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
});

describe('searchSemanticChallenges', () => {
  it('sends the full challenge gate, with the open statuses by default', async () => {
    const { result, filters } = run([1]);
    await result;
    const qdrant = buildQdrantFilter('challenges', filters[0]);
    expect(qdrant.must).toEqual(
      expect.arrayContaining([
        { key: 'nsfwLevel', match: { any: [1, 2] } },
        { key: 'coverNsfwLevel', match: { any: [1, 2] } },
        { key: 'visibleAt', range: { lte: NOW.toISOString() } },
        { key: 'status', match: { any: ['Active', 'Scheduled'] } },
      ])
    );
    // A user challenge paid in the other currency is excluded.
    expect(qdrant.must_not).toContainEqual({
      must: [{ key: 'source', match: { value: 'User' } }],
      must_not: [{ key: 'buzzType', match: { value: 'yellow' } }],
    });
  });

  it("holds a signed-out viewer to the site's cap", async () => {
    const { result, filters } = run([1], { cap: 1 });
    await result;
    expect((filters[0].gate as { nsfwLevels: number[] }).nsfwLevels).toEqual([1]);
    expect(h.feedCalls[0]).toMatchObject({ browsingLevel: 1 });
  });

  describe('the non-moderator clamp', () => {
    const viewer = { id: 500, isModerator: false } as SessionUser;
    const ALL = 31;
    const SAFE = 3;

    it('holds a signed-in non-moderator to the safe levels while the switch is on', async () => {
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ browsingLevel: SAFE });
    });

    it('holds the clamp when the switch cannot be read', async () => {
      h.fliptClient = null;
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ browsingLevel: SAFE });
    });

    it('searches at their own level once the switch is disabled', async () => {
      h.evalBoolean.mockReturnValue({ enabled: false });
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ browsingLevel: ALL });
    });
  });

  it('on green, user challenges must be paid in green', async () => {
    const { result, filters } = run([1], { isGreen: true });
    await result;
    expect((filters[0].gate as { domainBuzzType: string }).domainBuzzType).toBe('green');
    expect(h.feedCalls[0]).toMatchObject({ isGreen: true });
  });

  it('keeps only challenges outside an event when asked', async () => {
    const { result, filters } = run([1], { input: { excludeEventChallenges: true } });
    await result;
    expect(buildQdrantFilter('challenges', filters[0]).must_not).toContainEqual({
      must_not: [{ is_null: { key: 'eventId' } }],
    });
  });

  it("re-checks every candidate through the feed's own query, in rank order", async () => {
    h.hidden = new Set([2]);
    const user = { id: 5 } as SessionUser;
    // Not id order: the feed returns newest first, the page keeps the search's ranking.
    const { result } = run([1, 3, 2], { user });
    const { items } = await result;
    expect(items.map((c) => c.id)).toEqual([1, 3]);
    expect(h.feedCalls[0]).toMatchObject({
      ids: [1, 3, 2],
      currentUserId: 5,
      canAccessUserChallenges: true,
      status: ['Active', 'Scheduled'],
    });
  });

  it("caps one creator's user challenges per page, but not System ones", async () => {
    const ranked = [20, 21, 22, 23, 24, 1, 2, 3, 4, 5];
    const { result } = run(ranked);
    const { items } = await result;
    expect(items.filter((c) => c.source === 'User')).toHaveLength(MAX_HITS_PER_USER);
    expect(items.map((c) => c.id)).toEqual([20, 21, 22, 1, 2, 3, 4, 5]);
  });

  it('a refused query searches nothing', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    // A moderator's refusal is not narrowed; it refuses.
    const { result, filters } = run([1], { user: { id: 1, isModerator: true } as SessionUser });
    expect((await result).items).toEqual([]);
    expect(filters).toHaveLength(0);
  });

  it('a refused spelling correction returns nothing', async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const { result } = run([1], {
      user: { id: 1, isModerator: true } as SessionUser,
      correctedQuery: 'corrected',
    });
    const page = await result;
    expect(page.items).toEqual([]);
    expect(page).not.toHaveProperty('refusal');
  });
});
