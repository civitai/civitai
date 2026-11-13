import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

const h = vi.hoisted(() => ({
  fetched: [] as number[][],
  hiddenFor: [] as (number | undefined)[],
  rows: new Map<number, Record<string, unknown>>(),
  includesInappropriate:
    vi.fn<(input: { prompt?: string }, nsfw?: boolean) => 'minor' | 'poi' | false>(),
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
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async ({ userId }: { userId?: number }) => {
    h.hiddenFor.push(userId);
    return {
      hiddenUsers: [{ id: 901 }],
      blockedUsers: [{ id: 902 }],
      blockedByUsers: [{ id: 903 }],
      hiddenTags: [],
    };
  },
}));
// The index's own read: only the comics still eligible come back (the rule is the index's, and
// is tested there). Unknown ids stand for ineligible comics.
vi.mock('~/server/search-index/comics.search-index', () => ({
  getComicSearchRecords: async (_db: unknown, ids: number[]) => {
    h.fetched.push(ids);
    return ids.flatMap((id) => (h.rows.has(id) ? [h.rows.get(id)] : []));
  },
}));

const { searchSemanticComics, levelsWithin, MAX_HITS_PER_USER } = await import(
  '~/server/services/semantic-comic-search.service'
);

const { PG, PG13, R, X } = NsfwLevel;
const comic = (
  id: number,
  {
    userId = id,
    level = PG,
    cover = PG,
    deleted = false,
  }: { userId?: number; level?: number; cover?: number; deleted?: boolean } = {}
): Record<string, unknown> => ({
  id,
  userId,
  // As the index stores it: the level as its list of bits.
  nsfwLevel: parseBitwiseBrowsingLevel(level),
  coverImageUrl: `cover-${id}`,
  coverImageNsfwLevel: cover,
  user: { id: userId, deletedAt: deleted ? new Date() : null },
});

let sent: CandidateFilter[];
const ranking =
  (ids: number[], correctedQuery?: string): CandidateSource =>
  async ({ filter, offset, limit }) => {
    sent.push(filter);
    return { ids: ids.slice(offset, offset + limit), correctedQuery };
  };

const MOD = { id: 501, isModerator: true } as SessionUser;
const search = (
  ids: number[],
  {
    browsingLevel = PG,
    user,
    cap,
    genres,
    correctedQuery,
    track,
  }: {
    browsingLevel?: number;
    user?: SessionUser;
    cap?: number;
    genres?: string[];
    correctedQuery?: string;
    track?: { action: ReturnType<typeof vi.fn> };
  } = {}
) =>
  searchSemanticComics({
    input: { query: 'space pirates', browsingLevel, genres, limit: 10 },
    user,
    browsingLevelCap: cap,
    track: track as never,
    candidateSource: ranking(ids, correctedQuery),
  });
const ids = (r: { items: { id: number }[] }) => r.items.map((c) => c.id);

beforeEach(() => {
  sent = [];
  h.fetched = [];
  h.hiddenFor = [];
  h.rows = new Map();
  h.includesInappropriate.mockReset().mockReturnValue(false);
  loggingMock.logToAxiom.mockClear();
});

describe('levelsWithin', () => {
  it('is every rated level whose bits all lie inside, never 0', () => {
    expect(levelsWithin(PG | R)).toEqual([PG, R, PG | R]);
    expect(levelsWithin(PG)).toEqual([PG]);
    expect(levelsWithin(0)).toEqual([]);
    // Bits that are no level are ignored, so a wild input cannot blow up the list.
    expect(levelsWithin((2 ** 30) | PG)).toEqual([PG]);
    // Blocked is a real level: a moderator can search it.
    expect(levelsWithin(NsfwLevel.Blocked)).toEqual([NsfwLevel.Blocked]);
  });
});

describe('semantic comic search', () => {
  it('asks the service for comics wholly inside the viewer level, without hidden users', async () => {
    await search([], { browsingLevel: PG | PG13 | R, user: MOD, genres: ['Action'] });
    expect(sent[0]).toMatchObject({
      gate: {
        kind: 'level',
        nsfwLevels: [PG, PG13, PG | PG13, R, PG | R, PG13 | R, PG | PG13 | R],
      },
      excludedUserIds: [901, 902, 903],
      anyOf: { genre: ['Action'] },
    });
  });

  it('shows only comics the index still lists, in rank order', async () => {
    for (const id of [10, 12]) h.rows.set(id, comic(id));
    expect(ids(await search([12, 11, 10]))).toEqual([12, 10]);
    expect(h.fetched).toEqual([[12, 11, 10]]);
  });

  it("re-checks the row's level: a stale point above the viewer level, or unrated, is dropped", async () => {
    h.rows.set(10, comic(10));
    h.rows.set(11, comic(11, { level: PG | R }));
    h.rows.set(12, comic(12, { level: 0 }));
    expect(ids(await search([11, 12, 10], { browsingLevel: PG }))).toEqual([10]);
  });

  it("reads the viewer's own hidden and blocked creators", async () => {
    await search([], { user: MOD });
    expect(h.hiddenFor).toEqual([MOD.id]);
  });

  it('drops a deleted owner and a hidden owner, and caps one creator per page', async () => {
    h.rows.set(10, comic(10, { deleted: true }));
    h.rows.set(11, comic(11, { userId: 901 }));
    h.rows.set(12, comic(12, { userId: 902 }));
    h.rows.set(13, comic(13, { userId: 903 }));
    for (const id of [20, 21, 22, 23]) h.rows.set(id, comic(id, { userId: 7 }));
    h.rows.set(30, comic(30));
    const result = await search([10, 11, 12, 13, 20, 21, 22, 23, 30]);
    expect(ids(result)).toEqual([20, 21, 22, 30]);
    expect(result.items.filter((c) => c.userId === 7)).toHaveLength(MAX_HITS_PER_USER);
  });

  it("on a capped site, drops a cover that isn't wholly inside the cap; uncapped keeps it", async () => {
    h.rows.set(10, comic(10, { cover: PG }));
    h.rows.set(11, comic(11, { cover: PG | X }));
    h.rows.set(12, comic(12, { cover: 0 }));
    const covers = (r: { items: Record<string, unknown>[] }) =>
      r.items.map((c) => c.coverImageUrl ?? null);
    expect(covers(await search([10, 11, 12], { cap: PG | PG13 }))).toEqual([
      'cover-10',
      null,
      null,
    ]);
    expect(covers(await search([10, 11, 12]))).toEqual(['cover-10', 'cover-11', 'cover-12']);
  });

  it('holds a signed-in non-moderator to the safe levels whatever they ask for', async () => {
    h.rows.set(10, comic(10));
    h.rows.set(11, comic(11, { level: R }));
    const viewer = { id: 500, isModerator: false } as SessionUser;
    expect(ids(await search([11, 10], { browsingLevel: PG | R, user: viewer }))).toEqual([10]);
    expect(sent[0].gate).toEqual({ kind: 'level', nsfwLevels: [PG] });
  });

  it('logs how many candidates came back and how many survived hydration', async () => {
    h.rows.set(10, comic(10));
    await search([11, 10]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'semantic-comic-search', returned: 2, hydrated: 1 })
    );
  });
});

describe('semantic comic search: the query audit', () => {
  const tracker = () => ({ action: vi.fn(async () => undefined) });
  const csamHelp = (query: string) => ({
    type: 'CSAM_Help_Triggered',
    details: { query, index: 'comics_semantic' },
  });

  it('records a minor verdict on the query for the safety team', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const track = tracker();
    await search([10], { browsingLevel: 31, user: MOD, track });
    expect(track.action).toHaveBeenCalledWith(csamHelp('space pirates'));
  });

  it('searches a non-moderator minor query at the safe levels instead of refusing it', async () => {
    h.rows.set(10, comic(10));
    h.includesInappropriate.mockReturnValue('minor');
    const track = tracker();
    const viewer = { id: 500, isModerator: false } as SessionUser;
    const result = await search([10], { browsingLevel: PG | PG13 | R, user: viewer, track });
    expect(ids(result)).toEqual([10]);
    expect(sent[0].gate).toEqual({ kind: 'level', nsfwLevels: [PG, PG13, PG | PG13] });
    expect(track.action).toHaveBeenCalledWith(csamHelp('space pirates'));
  });

  it('records a minor verdict on the spelling correction', async () => {
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const track = tracker();
    await search([10], { browsingLevel: 31, user: MOD, correctedQuery: 'corrected', track });
    expect(track.action).toHaveBeenCalledWith(csamHelp('corrected'));
  });

  it('refuses a refused query before asking the service', async () => {
    h.includesInappropriate.mockReturnValue('minor');
    const result = await search([10], { browsingLevel: 31, user: MOD });
    expect(result).toEqual({ items: [], nextCursor: undefined, correctedQuery: undefined });
    expect(sent).toHaveLength(0);
  });

  it("refuses when the service's spelling correction fails the audit", async () => {
    h.rows.set(10, comic(10));
    h.includesInappropriate.mockImplementation(({ prompt }) =>
      prompt === 'corrected' ? 'minor' : false
    );
    const result = await search([10], {
      browsingLevel: 31,
      user: MOD,
      correctedQuery: 'corrected',
    });
    expect(result).toEqual({ items: [], nextCursor: undefined, correctedQuery: undefined });
    // The refused correction's candidates are never hydrated.
    expect(h.fetched).toEqual([]);
  });
});
