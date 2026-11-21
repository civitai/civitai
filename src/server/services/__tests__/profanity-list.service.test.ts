import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import {
  cleanWord,
  isUsableBlockedEntry,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { BlocklistType } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';

const h = vi.hoisted(() => ({
  flagOn: true,
  rows: new Map<string, { id?: number; data: string[] } | Error>(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => h.flagOn,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  readBlocklistWithSource: async (type: string) => {
    const row = h.rows.get(type) ?? { data: [] };
    if (row instanceof Error) throw row;
    return { dto: { type, ...row }, source: 'cache' };
  },
}));

import {
  getServerProfanityFilter,
  isProfaneSearch,
  setProfanityListReaderForTests,
  siteSearchQueries,
} from '~/server/services/profanity-list.service';

// Synthetic entries, on no real list: a match on one can only come from the managed row.
const letters = (n: number) =>
  n.toString(26).replace(/./g, (d) => String.fromCharCode(97 + parseInt(d, 26)));
const synthetic = (count: number) => Array.from({ length: count }, (_, i) => `zqvox${letters(i)}`);
const MANAGED = synthetic(MIN_MANAGED_PROFANITY_ENTRIES);
const MANAGED_WORD = MANAGED[7];
// A shipped entry read at runtime, never written down: this repository is public.
const SHIPPED_WORD = blockedWords
  .map(cleanWord)
  .find(
    (word) =>
      isUsableBlockedEntry(word) &&
      !word.includes('|') &&
      createProfanityFilter().analyze(word).isProfane
  ) as string;

const setBlocked = (row: { id?: number; data: string[] } | Error) =>
  h.rows.set(BlocklistType.ProfanityWord, row);

async function verdicts() {
  const { filter, source } = await getServerProfanityFilter();
  return {
    source,
    managed: filter.analyze(MANAGED_WORD).isProfane,
    shipped: filter.analyze(SHIPPED_WORD).isProfane,
  };
}

beforeEach(() => {
  h.flagOn = true;
  h.rows.clear();
  setProfanityListReaderForTests();
});

describe('getServerProfanityFilter', () => {
  it('controls: the shipped word is on the shipped list and the synthetic one is not', () => {
    expect(SHIPPED_WORD).toBeTruthy();
    expect(createProfanityFilter().analyze(MANAGED_WORD).isProfane).toBe(false);
  });

  it('flag off: the shipped list, whatever the row holds', async () => {
    h.flagOn = false;
    setBlocked({ id: 1, data: MANAGED });
    expect(await verdicts()).toEqual({ source: 'shipped', managed: false, shipped: true });
  });

  it('flag on with a row at the floor: the row REPLACES the shipped list', async () => {
    setBlocked({ id: 1, data: MANAGED });
    expect(await verdicts()).toEqual({ source: 'managed', managed: true, shipped: false });
  });

  it('profanity block list: an empty or too-small row falls back to the shipped list, unlike the benign list', async () => {
    // To whoever wants this to match ProfanityBenignWord (where an emptied row is honoured): an
    // honoured empty BLOCK list filters nothing anywhere, which is what the floor exists to stop.
    for (const data of [[], MANAGED.slice(0, MIN_MANAGED_PROFANITY_ENTRIES - 1)]) {
      setProfanityListReaderForTests();
      setBlocked({ id: 1, data });
      expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
    }
  });

  it('counts only usable entries toward the floor', async () => {
    setBlocked({ id: 1, data: [...MANAGED.slice(0, -1), 'ab', 'x*y', 'a|b|c'] });
    expect((await verdicts()).source).toBe('fallback');
  });

  it('a missing row falls back to the shipped list', async () => {
    expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
  });

  it('a read error after a good read keeps enforcing the last good list', async () => {
    setBlocked({ id: 1, data: MANAGED });
    await verdicts();
    setBlocked(new Error('redis and db down'));
    expect(await verdicts()).toEqual({ source: 'stale', managed: true, shipped: false });
  });

  it('a read error after a below-floor read still enforces the shipped list, never the tiny row', async () => {
    setBlocked({ id: 1, data: MANAGED.slice(0, 3) });
    await verdicts();
    setBlocked(new Error('redis and db down'));
    expect(await verdicts()).toEqual({ source: 'stale', managed: false, shipped: true });
  });

  it('a read error with nothing held falls back to the shipped list', async () => {
    setBlocked(new Error('redis and db down'));
    expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
  });

  it("applies the moderators' allow list", async () => {
    const benign = `${MANAGED_WORD}tail`;
    setBlocked({ id: 1, data: MANAGED });
    expect((await getServerProfanityFilter()).filter.analyze(benign).isProfane).toBe(true);
    h.rows.set(BlocklistType.ProfanityBenignWord, { id: 2, data: [benign] });
    expect((await getServerProfanityFilter()).filter.analyze(benign).isProfane).toBe(false);
  });

  it('reuses the built filter while the lists are unchanged', async () => {
    setBlocked({ id: 1, data: [...MANAGED] });
    const first = (await getServerProfanityFilter()).filter;
    setBlocked({ id: 1, data: [...MANAGED] });
    expect((await getServerProfanityFilter()).filter).toBe(first);
    setBlocked({ id: 1, data: [...MANAGED, 'zqvoxextra'] });
    expect((await getServerProfanityFilter()).filter).not.toBe(first);
  });
});

describe('isProfaneSearch', () => {
  it('refuses a search that matches the managed list', async () => {
    setBlocked({ id: 1, data: MANAGED });
    expect(await isProfaneSearch(['hello', `a ${MANAGED_WORD} b`])).toBe(true);
    expect(await isProfaneSearch(['hello', SHIPPED_WORD])).toBe(false);
  });

  // The browser's check is today's rule while the flag is off; see the function's comment.
  it('refuses nothing while profanity-managed-list is off', async () => {
    h.flagOn = false;
    expect(await isProfaneSearch([SHIPPED_WORD])).toBe(false);
  });

  it('reads the query of a single search and of each search in a multi-search', () => {
    expect(siteSearchQueries({ q: 'one' })).toEqual(['one']);
    expect(siteSearchQueries({ queries: [{ q: 'a' }, { indexUid: 'x' }, { q: 'b' }] })).toEqual([
      'a',
      'b',
    ]);
    expect(siteSearchQueries(null)).toEqual([]);
    expect(siteSearchQueries({ q: 7 })).toEqual([]);
  });
});
