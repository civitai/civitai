import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQdrantFilter,
  MAX_HITS_PER_USER,
  type CandidateFilter,
  type CandidateSource,
} from '~/server/services/semantic-search-client';
import type { GuardRead } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockImplementation(async () => undefined);

const h = vi.hoisted(() => ({
  feedCalls: [] as Record<string, unknown>[],
  // Ids the feed's own query drops (its visibility rule says no).
  hidden: new Set<number>(),
  // A row's current level, when not PG: the feed shows it only within the level it is asked for.
  rowLevel: new Map<number, number>(),
  // The viewer's hidden, blocked and blocked-by users (getAllHiddenForUser).
  viewerHidden: { hiddenUsers: [], blockedUsers: [], blockedByUsers: [] } as Record<
    'hiddenUsers' | 'blockedUsers' | 'blockedByUsers',
    { id: number }[]
  >,
  hiddenFor: [] as (number | undefined)[],
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
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));
vi.mock('~/utils/metadata/audit', () => ({
  includesNsfw: () => false,
  includesInappropriate: h.includesInappropriate,
  includesPoi: () => false,
  includesMinor: () => false,
}));
vi.mock('~/server/services/system-cache', () => ({ getBrowsingSettingAddons: async () => [] }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async ({ userId }: { userId?: number }) => {
    h.hiddenFor.push(userId);
    return { ...h.viewerHidden, hiddenTags: [], hiddenModels: [], hiddenImages: [] };
  },
}));
// The feed's query: ids >= 20 are user challenges by creator 7, the rest System challenges. A row
// shows only within the level it is asked for, as the feed's gate does, or when it is the viewer's
// own and own rows are exempt.
vi.mock('~/server/services/challenge.service', () => ({
  getInfiniteChallenges: async (
    input: {
      ids: number[];
      browsingLevel: number;
      currentUserId?: number;
      ownRowsExempt?: boolean;
    } & Record<string, unknown>
  ) => {
    h.feedCalls.push(input);
    const ownExempt = (id: number) =>
      input.ownRowsExempt !== false && id >= 20 && input.currentUserId === 7;
    return {
      items: input.ids
        .filter((id) => !h.hidden.has(id))
        .filter((id) => ownExempt(id) || ((h.rowLevel.get(id) ?? 1) & input.browsingLevel) !== 0)
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

const { searchSemanticChallenges } = await import(
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
    guard,
  }: {
    input?: Record<string, unknown>;
    user?: SessionUser;
    isGreen?: boolean;
    cap?: number;
    correctedQuery?: string;
    guard?: GuardRead;
  } = {}
) => {
  const filters: CandidateFilter[] = [];
  const candidateSource: CandidateSource = async ({ filter, offset, limit }) => {
    filters.push(filter);
    return { ids: ranked.slice(offset, offset + limit), correctedQuery, guard };
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
  h.rowLevel = new Map();
  h.viewerHidden = { hiddenUsers: [], blockedUsers: [], blockedByUsers: [] };
  h.hiddenFor = [];
  h.includesInappropriate.mockReset().mockReturnValue(false);
  // The containment switch reads enabled (clamped) unless a test lifts it.
  h.evalBoolean.mockReset().mockReturnValue({ enabled: true });
  h.fliptClient = { evaluateBoolean: () => h.evalBoolean() };
});

describe('searchSemanticChallenges', () => {
  it("never returns a creator on the viewer's hidden, blocked or blocked-by list", async () => {
    // Creator 7 owns every user challenge (ids >= 20); one list entry per kind.
    h.viewerHidden = {
      hiddenUsers: [{ id: 901 }],
      blockedUsers: [{ id: 7 }],
      blockedByUsers: [{ id: 903 }],
    };
    const viewer = { id: 42 } as SessionUser;
    const { result, filters } = run([20, 1, 21], { user: viewer });
    const { items } = await result;
    expect(h.hiddenFor).toEqual([42]);
    expect(filters[0].excludedUserIds).toEqual([901, 7, 903]);
    // Even when the index proposes them, hydration drops the excluded creator's challenges.
    expect(items.map((c) => c.id)).toEqual([1]);
  });

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

  describe("the feed's filters", () => {
    const filters = {
      source: ['User'],
      userId: 7,
      modelVersionId: 42,
      challengeEventId: 9,
      excludeEventChallenges: true,
      includeEnded: true,
      participation: 'entered',
    };

    it('narrows the index by creator, source, model and event', async () => {
      const { result, filters: sent } = run([1], { input: filters });
      await result;
      expect(sent[0]).toMatchObject({
        userIds: [7],
        anyOf: { source: ['User'], modelVersionIds: [42], eventId: [9] },
      });
      const qdrant = buildQdrantFilter('challenges', sent[0]);
      expect(qdrant.must_not).toContainEqual({ must_not: [{ is_null: { key: 'eventId' } }] });
    });

    it('with ended challenges, searches every status but Cancelled', async () => {
      const { result, filters: sent } = run([1], { input: { includeEnded: true } });
      await result;
      const status = (sent[0].anyOf as { status: string[] }).status;
      expect(status).toContain('Completed');
      expect(status).not.toContain('Cancelled');
    });

    it('searches exactly the statuses picked', async () => {
      const { result, filters: sent } = run([1], { input: { status: ['Completed'] } });
      await result;
      expect((sent[0].anyOf as { status: string[] }).status).toEqual(['Completed']);
    });

    // participation is per viewer and not in the index: only the feed's query can apply it.
    it("hands every filter, participation included, to the feed's re-check", async () => {
      const { result } = run([1], { input: filters });
      await result;
      expect(h.feedCalls[0]).toMatchObject(filters);
    });
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
    const userIds = [20, 21, 22, 23, 24];
    const systemIds = [1, 2, 3, 4, 5];
    const { result } = run([...userIds, ...systemIds]);
    const { items } = await result;
    // The creator's best-ranked user challenges up to the cap, then every System one.
    expect(items.map((c) => c.id)).toEqual([...userIds.slice(0, MAX_HITS_PER_USER), ...systemIds]);
  });

  it("cannot show the viewer's own challenge above the safe levels after a minor verdict", async () => {
    // Challenge 20 is creator 7's, its cover re-rated R after it was indexed.
    h.rowLevel.set(20, 4);
    // With the clamp lifted and no verdict, the owner browsing R does see it.
    h.evalBoolean.mockReturnValue({ enabled: false });
    const unnarrowed = run([20, 1], { user: { id: 7 } as SessionUser }).result;
    expect((await unnarrowed).items.map((c) => c.id)).toEqual([20, 1]);

    h.includesInappropriate.mockReturnValue('minor');
    const { result } = run([20, 1], { user: { id: 7 } as SessionUser });
    expect((await result).items.map((c) => c.id)).toEqual([1]);
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
  });
});

describe('challenges: a refused page', () => {
  const MOD = { id: 1, isModerator: true } as SessionUser;
  const VIEWER = { id: 7 } as SessionUser;
  const NO_MATCH = { items: [], nextCursor: undefined, correctedQuery: undefined };
  const enforceFlag: GuardRead = {
    outcome: 'flag',
    rules: ['block:rule_a'],
    mode: 'enforce',
    version: 'v1',
    refused: true,
  };
  const minusRefused = ({ refused, ...rest }: { refused?: unknown }) => rest;

  it('marks a page with no matches as not refused', async () => {
    expect(await run([], { user: VIEWER }).result).toEqual({ ...NO_MATCH, refused: false });
  });

  it.each([
    ['by the word audit', () => h.includesInappropriate.mockReturnValue('poi'), undefined],
    ['by the search service', () => undefined, enforceFlag],
  ])('is, %s, a no-match page plus `refused` for a non-moderator', async (_, setup, guard) => {
    setup();
    const page = await run(guard ? [] : [1], { user: VIEWER, guard }).result;
    expect(page).toMatchObject({ refused: true });
    expect(minusRefused(page)).toEqual(NO_MATCH);
    expect(Object.hasOwn(page, 'refusedBy')).toBe(false);
  });

  it('names the check to a moderator', async () => {
    h.includesInappropriate.mockReturnValue('poi');
    expect(await run([1], { user: MOD }).result).toMatchObject({
      refused: true,
      refusedBy: 'real people',
    });
  });

  it("names the search service's check to a moderator", async () => {
    expect(await run([], { user: MOD, guard: enforceFlag }).result).toMatchObject({
      refused: true,
      refusedBy: 'query guard',
    });
  });

  it('names a refused spelling correction to a moderator', async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'blocked' : false
    );
    expect(await run([1], { user: MOD, correctedQuery: 'corrected' }).result).toMatchObject({
      refused: true,
      refusedBy: 'blocked words',
    });
  });
});
