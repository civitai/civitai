import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQdrantFilter,
  MAX_HITS_PER_USER,
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
  // A row's current nsfwLevel, where it is not PG (1).
  rowLevel: new Map<number, number>(),
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
// The feed's query: ids >= 20 belong to creator 7, the rest each to its own creator. A row shows
// only when its current level is within the level it is asked for, as the feed's gate does, or
// when it is the viewer's own and own rows are exempt.
vi.mock('~/server/services/crucible.service', () => ({
  getCrucibles: async (
    args: {
      ids: number[];
      input: { browsingLevel: number };
      viewerId?: number;
      ownRowsExempt?: boolean;
    } & Record<string, unknown>
  ) => {
    h.feedCalls.push(args);
    const ownerOf = (id: number) => (id >= 20 ? 7 : id);
    const ownExempt = (id: number) => args.ownRowsExempt !== false && args.viewerId === ownerOf(id);
    return {
      items: args.ids
        .filter((id) => !h.hidden.has(id))
        .filter(
          (id) => ownExempt(id) || ((h.rowLevel.get(id) ?? 1) & args.input.browsingLevel) !== 0
        )
        // Newest first, not rank order.
        .sort((a, b) => b - a)
        .map((id) => ({ id, userId: ownerOf(id) })),
      nextCursor: undefined,
    };
  },
  withEntryCounts: async <T>(rows: T[]) => rows.map((r) => ({ ...r, entryCount: 0 })),
}));

const { searchSemanticCrucibles } = await import(
  '~/server/services/semantic-crucible-search.service'
);

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
  const result = searchSemanticCrucibles({
    input: { query: 'neon arena', browsingLevel: 31, limit: 20, ...input } as never,
    user,
    isGreen,
    browsingLevelCap: cap,
    candidateSource,
  });
  return { result, filters };
};

const moderator = { id: 1, isModerator: true } as SessionUser;
const ALL = 31;
const SAFE = 3;
const X = 16;

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

describe('searchSemanticCrucibles', () => {
  it("never returns a creator on the viewer's hidden, blocked or blocked-by list", async () => {
    // Creator 7 owns ids >= 20; one list entry per kind.
    h.viewerHidden = {
      hiddenUsers: [{ id: 901 }],
      blockedUsers: [{ id: 7 }],
      blockedByUsers: [{ id: 903 }],
    };
    const { result, filters } = run([20, 1, 21], { user: { id: 42 } as SessionUser });
    const { items } = await result;
    expect(h.hiddenFor).toEqual([42]);
    expect(filters[0].excludedUserIds).toEqual([901, 7, 903]);
    // Even when the index proposes them, hydration drops the excluded creator's crucibles.
    expect(items.map((c) => c.id)).toEqual([1]);
  });

  it('sends both levels and the open statuses, and hides adult text from a safe viewer', async () => {
    const { result, filters } = run([1], { user: { id: 5 } as SessionUser });
    await result;
    const qdrant = buildQdrantFilter('crucibles', filters[0]);
    expect(qdrant.must).toEqual(
      expect.arrayContaining([
        { key: 'nsfwLevel', match: { any: [1, 2] } },
        { key: 'coverNsfwLevel', match: { any: [1, 2] } },
        { key: 'status', match: { any: ['Active', 'Pending'] } },
      ])
    );
    expect(qdrant.must_not).toContainEqual({ key: 'textNsfw', match: { value: true } });
  });

  it('lets a moderator browsing mature levels see adult text off green, never on green', async () => {
    const off = run([1], { user: moderator });
    await off.result;
    expect(buildQdrantFilter('crucibles', off.filters[0]).must_not).not.toContainEqual({
      key: 'textNsfw',
      match: { value: true },
    });
    const green = run([1], { user: moderator, isGreen: true });
    await green.result;
    expect(buildQdrantFilter('crucibles', green.filters[0]).must_not).toContainEqual({
      key: 'textNsfw',
      match: { value: true },
    });
  });

  it("holds a signed-out viewer to the site's cap", async () => {
    const { result, filters } = run([1], { cap: 1 });
    await result;
    expect((filters[0].gate as { nsfwLevels: number[] }).nsfwLevels).toEqual([1]);
    expect(h.feedCalls[0]).toMatchObject({ input: { browsingLevel: 1 } });
  });

  describe("the feed's filters", () => {
    it('narrows the index and the re-check to the picked statuses and content type', async () => {
      const { result, filters } = run([1], {
        input: { status: ['Completed'], contentType: 'video' },
      });
      await result;
      expect(filters[0].anyOf).toEqual({ status: ['Completed'], contentType: ['video'] });
      expect(h.feedCalls[0]).toMatchObject({
        input: { status: ['Completed'], contentType: 'video' },
      });
    });

    it('with no status picked, searches only running and upcoming crucibles', async () => {
      const { result, filters } = run([1]);
      await result;
      expect(filters[0].anyOf).toEqual({ status: ['Active', 'Pending'], contentType: undefined });
      expect(h.feedCalls[0]).toMatchObject({ input: { status: ['Active', 'Pending'] } });
    });
  });

  describe('the non-moderator clamp', () => {
    const viewer = { id: 500, isModerator: false } as SessionUser;

    it('holds a signed-in non-moderator to the safe levels while the switch is on', async () => {
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ input: { browsingLevel: SAFE } });
    });

    it('holds the clamp when the switch cannot be read', async () => {
      h.fliptClient = null;
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ input: { browsingLevel: SAFE } });
    });

    it('searches at their own level once the switch is disabled', async () => {
      h.evalBoolean.mockReturnValue({ enabled: false });
      const { result } = run([1], { user: viewer, input: { browsingLevel: ALL } });
      await result;
      expect(h.feedCalls[0]).toMatchObject({ input: { browsingLevel: ALL } });
    });
  });

  describe('a stale index payload', () => {
    // The index proposes 9 at the viewer's levels, but the row is now rated X.
    beforeEach(() => {
      h.rowLevel.set(9, X);
      h.evalBoolean.mockReturnValue({ enabled: false });
    });

    it("cannot show a crucible the viewer's level excludes", async () => {
      const { result } = run([9, 1], {
        user: { id: 5 } as SessionUser,
        input: { browsingLevel: SAFE },
      });
      expect((await result).items.map((c) => c.id)).toEqual([1]);
    });

    it('cannot show a crucible above the safe levels once a minor verdict narrows the query', async () => {
      h.includesInappropriate.mockReturnValue('minor');
      const { result, filters } = run([9, 1], {
        user: { id: 5 } as SessionUser,
        input: { browsingLevel: ALL },
      });
      expect((await result).items.map((c) => c.id)).toEqual([1]);
      expect((filters[0].gate as { nsfwLevels: number[] }).nsfwLevels).toEqual([1, 2]);
    });

    it("cannot show the viewer's own crucible above the safe levels after a minor verdict", async () => {
      h.includesInappropriate.mockReturnValue('minor');
      // Crucible 9 is creator 9's.
      const { result } = run([9, 1], {
        user: { id: 9 } as SessionUser,
        input: { browsingLevel: ALL },
      });
      expect((await result).items.map((c) => c.id)).toEqual([1]);
    });
  });

  it('audits a spelling correction at the level the query was narrowed to', async () => {
    h.evalBoolean.mockReturnValue({ enabled: false });
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'neon arena' ? 'minor' : false
    );
    await run([1], {
      user: { id: 5 } as SessionUser,
      input: { browsingLevel: ALL },
      correctedQuery: 'corrected',
    }).result;
    const nsfwFor = (text: string) =>
      h.includesInappropriate.mock.calls.find(([input]) => input.prompt === text)?.[1];
    expect(nsfwFor('neon arena')).toBe(true);
    // Narrowed to the safe levels, so the correction is judged as a safe search.
    expect(nsfwFor('corrected')).toBe(false);
  });

  it("re-checks every candidate through the feed's query, in rank order", async () => {
    h.hidden = new Set([2]);
    const { result } = run([3, 2, 1], { user: { id: 5 } as SessionUser, isGreen: true });
    const { items } = await result;
    expect(items.map((c) => c.id)).toEqual([3, 1]);
    expect(h.feedCalls[0]).toMatchObject({ ids: [3, 2, 1], viewerId: 5, isGreen: true });
  });

  it("caps one creator's crucibles per page", async () => {
    const { result } = run([20, 21, 22, 23, 1, 2]);
    const { items } = await result;
    expect(items.filter((c) => c.userId === 7)).toHaveLength(MAX_HITS_PER_USER);
    expect(items.map((c) => c.id)).toEqual([20, 21, 22, 1, 2]);
  });

  it('a refused query searches nothing', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    // A moderator's refusal is not narrowed; it refuses.
    const { result, filters } = run([1], { user: moderator });
    expect((await result).items).toEqual([]);
    expect(filters).toHaveLength(0);
  });

  it('a refused spelling correction returns nothing', async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const page = await run([1], { user: moderator, correctedQuery: 'corrected' }).result;
    expect(page.items).toEqual([]);
    expect(page).not.toHaveProperty('refusal');
  });
});
