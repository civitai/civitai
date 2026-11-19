import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  collectPage,
  MAX_CANDIDATE_LIMIT,
  MAX_CANDIDATE_OFFSET,
  searchServiceSource,
  type CandidateFilter,
  type SearchCollection,
  type ViewerGate,
  buildQdrantFilter,
  withWordMatchesFirst,
  withTagMatchesFirst,
  type CandidateSource,
} from '~/server/services/semantic-search-client';

describe('the content gate', () => {
  let sent: { must: unknown[]; must_not: unknown[] }[];
  beforeEach(() => {
    setEnv({ SEARCH_SERVICE_URL: 'http://search.test/' });
    sent = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).filter);
      return Response.json({ corrected: 'x', changes: [], hits: [] });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const search = (collection: SearchCollection, gate: unknown) =>
    searchServiceSource(collection)({
      query: { text: 'x' },
      filter: { gate } as CandidateFilter,
      offset: 0,
      limit: 10,
      viewer: { isModerator: false },
    });

  const challenge: ViewerGate = {
    kind: 'challenge',
    nsfwLevels: [1],
    domainBuzzType: 'green',
    canAccessUserChallenges: true,
    visibleBefore: '2026-11-10T00:00:00.000Z',
  };
  const crucible: ViewerGate = { kind: 'crucible', nsfwLevels: [1], allowTextNsfw: false };

  it.each([
    ['no gate', 'articles', undefined],
    ['no browsing level', 'articles', { kind: 'level' }],
    ['an empty browsing level', 'images', { kind: 'level', nsfwLevels: [] }],
    ['level 0', 'comics', { kind: 'level', nsfwLevels: [0] }],
    ['only one level for a challenge', 'challenges', { kind: 'level', nsfwLevels: [1] }],
    ['a challenge without the domain', 'challenges', { ...challenge, domainBuzzType: undefined }],
    [
      'a challenge without user-challenge access',
      'challenges',
      { ...challenge, canAccessUserChallenges: undefined },
    ],
    [
      'a challenge without the visibility cutoff',
      'challenges',
      { ...challenge, visibleBefore: '' },
    ],
    ['a crucible without textNsfw', 'crucibles', { kind: 'crucible', nsfwLevels: [1] }],
    ['a crucible with a challenge gate', 'crucibles', challenge],
  ] as const)('refuses %s, without asking the service', async (_, collection, gate) => {
    await expect(search(collection, gate)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(sent).toEqual([]);
  });

  it('sends a query that carries the browsing level', async () => {
    await search('articles', { kind: 'level', nsfwLevels: [1, 2] });
    expect(sent[0].must).toContainEqual({ key: 'nsfwLevel', match: { any: [1, 2] } });
  });

  it("requires a 3D model's thumbnail level too, and drops a point written without it", async () => {
    await search('models3d', { kind: 'level', nsfwLevels: [1] });
    // Qdrant's must/match-any, applied to stored payloads: a missing field matches nothing.
    const served = (payload: Record<string, number[]>) =>
      (sent[0].must as { key: string; match: { any: number[] } }[]).every((c) =>
        (payload[c.key] ?? []).some((v) => c.match.any.includes(v))
      );
    expect(served({ nsfwLevel: [1], thumbnailNsfwLevel: [1] })).toBe(true);
    // A PG model whose thumbnail was re-rated R.
    expect(served({ nsfwLevel: [1], thumbnailNsfwLevel: [4] })).toBe(false);
    expect(served({ nsfwLevel: [1] })).toBe(false);
  });

  it('requires both levels of a challenge, and keeps user challenges to their domain', async () => {
    await search('challenges', challenge);
    expect(sent[0].must).toEqual(
      expect.arrayContaining([
        { key: 'nsfwLevel', match: { any: [1] } },
        { key: 'coverNsfwLevel', match: { any: [1] } },
        { key: 'visibleAt', range: { lte: challenge.visibleBefore } },
      ])
    );
    expect(sent[0].must_not).toContainEqual({
      must: [{ key: 'source', match: { value: 'User' } }],
      must_not: [{ key: 'buzzType', match: { value: 'green' } }],
    });
  });

  it('drops every user challenge for a viewer who cannot access them', async () => {
    await search('challenges', { ...challenge, canAccessUserChallenges: false });
    expect(sent[0].must_not).toContainEqual({ key: 'source', match: { value: 'User' } });
  });

  it('requires both levels of a crucible, and hides NSFW text unless allowed', async () => {
    await search('crucibles', crucible);
    await search('crucibles', { ...crucible, allowTextNsfw: true });
    expect(sent[0].must).toContainEqual({ key: 'coverNsfwLevel', match: { any: [1] } });
    expect(sent[0].must_not).toContainEqual({ key: 'textNsfw', match: { value: true } });
    expect(sent[1].must_not).not.toContainEqual({ key: 'textNsfw', match: { value: true } });
  });

  it('ranks only within an id list when one is given', async () => {
    await searchServiceSource('articles')({
      query: { text: 'x' },
      filter: { gate: { kind: 'level', nsfwLevels: [1] }, ids: [3, 5] },
      offset: 0,
      limit: 10,
      viewer: { isModerator: false },
    });
    expect(sent[0].must).toContainEqual({ has_id: [3, 5] });
  });
});

describe('collectPage', () => {
  /** A ranking that records each page it was asked for. */
  function ranked(length: number) {
    const calls: { offset: number; limit: number }[] = [];
    const ranking = Array.from({ length }, (_, i) => i + 1);
    const candidates = async (offset: number, limit: number) => {
      calls.push({ offset, limit });
      return ranking.slice(offset, offset + limit);
    };
    return { candidates, calls };
  }

  it('stops after a bounded number of rounds when nothing hydrates', async () => {
    const { candidates, calls } = ranked(5000);
    const page = await collectPage({ candidates, hydrate: async () => [], offset: 0, limit: 10 });
    expect(page.items).toEqual([]);
    expect(calls.length).toBe(3);
    expect(page.nextCursor).toBe(90);
  });

  it("never asks for more candidates than the service's page maximum", async () => {
    const { candidates, calls } = ranked(5000);
    await collectPage({ candidates, hydrate: async () => [], offset: 0, limit: 50 });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.limit).toBeLessThanOrEqual(MAX_CANDIDATE_LIMIT);
  });

  it('keeps an id once when a later round repeats it', async () => {
    // Tied scores reorder between requests: the second round starts with an id the first returned.
    const rounds = [
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [3, 10, 11],
    ];
    const candidates = async () => rounds.shift() ?? [];
    const visible = new Set([1, 3, 10, 11]);
    const hydrate = async (ids: number[]) =>
      ids.filter((id) => visible.has(id)).map((id) => ({ id }));

    const page = await collectPage({ candidates, hydrate, offset: 0, limit: 3 });
    expect(page.items.map((x) => x.id)).toEqual([1, 3, 10]);
  });

  it('stops paging at the candidate offset cap', async () => {
    const { candidates, calls } = ranked(5000);
    const hydrate = async (ids: number[]) => ids.map((id) => ({ id }));

    const last = await collectPage({
      candidates,
      hydrate,
      offset: MAX_CANDIDATE_OFFSET - 5,
      limit: 10,
    });
    expect(last.items).toHaveLength(5);
    expect(calls.at(-1)).toMatchObject({ offset: MAX_CANDIDATE_OFFSET - 5, limit: 5 });
    expect(last.nextCursor).toBeUndefined();

    const beyond = await collectPage({
      candidates,
      hydrate,
      offset: MAX_CANDIDATE_OFFSET + 500,
      limit: 10,
    });
    expect(beyond).toEqual({ items: [], nextCursor: undefined });
  });
});

describe('withTagMatchesFirst', () => {
  const gate: ViewerGate = { kind: 'level', nsfwLevels: [1] };
  const TAG = 900;
  // `tagged` is what the index holds with the tag; `semantic` is the ranking.
  const index = (tagged: number[], semantic: number[]) => {
    const calls: Parameters<CandidateSource>[0][] = [];
    const source: CandidateSource = async (args) => {
      calls.push(args);
      const excluded = new Set(args.filter.excludedIds ?? []);
      const pool = args.filter.tagIds?.includes(TAG)
        ? tagged
        : semantic.filter((id) => !excluded.has(id));
      return { ids: pool.slice(args.offset, args.offset + args.limit) };
    };
    return { source, calls };
  };
  const page = (source: CandidateSource, offset: number, limit: number, tagIds?: number[]) =>
    source({
      query: { text: 'tiefling' },
      filter: { gate, userIds: [5], tagIds },
      offset,
      limit,
      viewer: { isModerator: false },
    });

  it('puts the tagged points first, then the ranking without them', async () => {
    const { source } = index([7, 3], [1, 2, 3, 4, 5, 6, 7]);
    expect((await page(withTagMatchesFirst(source, TAG), 0, 4)).ids).toEqual([7, 3, 1, 2]);
  });

  it('pages on past the tagged points without repeating them', async () => {
    const { source } = index([7, 3], [1, 2, 3, 4, 5, 6, 7]);
    const ranked = withTagMatchesFirst(source, TAG);
    expect((await page(ranked, 1, 3)).ids).toEqual([3, 1, 2]);
    expect((await page(ranked, 4, 3)).ids).toEqual([4, 5, 6]);
  });

  it('narrows the first pass within the same filter, keeping the tags already chosen', async () => {
    const { source, calls } = index([7], [1, 7]);
    await page(withTagMatchesFirst(source, TAG), 0, 2, [42]);
    const first = calls.find((call) => call.filter.tagIds?.includes(TAG));
    expect(first?.filter.tagIds).toEqual([42, TAG]);
    expect(first?.filter.userIds).toEqual([5]);
  });

  it('is the plain ranking when nothing carries the tag', async () => {
    const { source } = index([], [1, 2, 3]);
    expect((await page(withTagMatchesFirst(source, TAG), 0, 3)).ids).toEqual([1, 2, 3]);
  });
});

describe('withWordMatchesFirst', () => {
  const gate: ViewerGate = { kind: 'level', nsfwLevels: [1] };
  // The index: `words` holds the points whose text has every query word; `semantic` is the ranking.
  const index = (words: number[], semantic: number[]) => {
    const calls: Parameters<CandidateSource>[0][] = [];
    const source: CandidateSource = async (args) => {
      calls.push(args);
      const excluded = new Set(args.filter.excludedIds ?? []);
      const pool = args.filter.allWords ? words : semantic.filter((id) => !excluded.has(id));
      return { ids: pool.slice(args.offset, args.offset + args.limit) };
    };
    return { source, calls };
  };
  const page = (source: CandidateSource, offset: number, limit: number, text = 'civetai') =>
    source({ query: { text }, filter: { gate }, offset, limit, viewer: { isModerator: false } });

  it('puts the points holding every word first, then the ranking without them', async () => {
    const { source } = index([7, 3], [1, 2, 3, 4, 5, 6, 7]);
    const ranked = withWordMatchesFirst(source, 'search_text');
    expect((await page(ranked, 0, 4)).ids).toEqual([7, 3, 1, 2]);
  });

  it('pages on past the word matches without repeating them', async () => {
    const { source } = index([7, 3], [1, 2, 3, 4, 5, 6, 7]);
    const ranked = withWordMatchesFirst(source, 'search_text');
    expect((await page(ranked, 1, 3)).ids).toEqual([3, 1, 2]);
    expect((await page(ranked, 4, 3)).ids).toEqual([4, 5, 6]);
  });

  it('asks for the word matches once per search, on the given key', async () => {
    const { source, calls } = index([7], [1, 2, 7]);
    const ranked = withWordMatchesFirst(source, 'search_text');
    await page(ranked, 0, 2);
    await page(ranked, 2, 2);
    const wordCalls = calls.filter((call) => call.filter.allWords);
    expect(wordCalls).toHaveLength(1);
    expect(wordCalls[0].filter.allWords).toEqual({ key: 'search_text', text: 'civetai' });
  });

  it('asks for no word matches for blank text or "more like this"', async () => {
    const { source, calls } = index([7], [1, 2]);
    const ranked = withWordMatchesFirst(source, 'search_text');
    expect((await page(ranked, 0, 2, '  ')).ids).toEqual([1, 2]);
    await ranked({
      query: { similarTo: 5 },
      filter: { gate },
      offset: 0,
      limit: 2,
      viewer: { isModerator: false },
    });
    expect(calls.filter((call) => call.filter.allWords)).toEqual([]);
  });

  it('is the plain ranking when nothing holds every word', async () => {
    const { source } = index([], [1, 2, 3]);
    expect((await page(withWordMatchesFirst(source, 'search_text'), 0, 3)).ids).toEqual([1, 2, 3]);
  });

  it('sends the words as a full-text match in the Qdrant filter', () => {
    const filter = buildQdrantFilter('models', {
      gate,
      allWords: { key: 'search_text', text: 'kiyami kuro' },
    });
    expect(filter.must).toContainEqual({ key: 'search_text', match: { text: 'kiyami kuro' } });
  });
});
