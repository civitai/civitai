import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import {
  cleanWord,
  isUsableBlockedEntry,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { BlocklistType } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';
import type * as WordRules from '@civitai/mod-utils/profanity/word-rules';

const h = vi.hoisted(() => ({
  flagOn: true,
  rows: new Map<string, { id?: number; data: string[] } | Error>(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => h.flagOn,
}));

// The floor rule must be decided by `managedProfanityEntries` alone: this override makes it refuse a
// full list, and the test that sets it goes red if this caller writes the rule out inline again.
const managedRule = vi.hoisted(() => ({ refuseAll: false }));
vi.mock('@civitai/mod-utils/profanity/word-rules', async (importOriginal) => {
  const original = await importOriginal<typeof WordRules>();
  return {
    ...original,
    managedProfanityEntries: (entries: readonly string[]) => {
      const result = original.managedProfanityEntries(entries);
      return managedRule.refuseAll ? { ...result, enforced: false } : result;
    },
  };
});
import {
  ensureRegisterProfanityListMetrics,
  profanityEntryId,
} from '~/server/metrics/profanity-list.metrics';
import {
  createProfanityListReader,
  getServerProfanityFilter,
  isProfaneSearch,
  setProfanityListReaderForTests,
  siteSearchQueries,
} from '~/server/services/profanity-list.service';

// The reader's one read, injected: the rows each test sets, or the error it throws.
const freshReader = () =>
  setProfanityListReaderForTests(
    createProfanityListReader({
      readRow: async (type) => {
        const row = h.rows.get(type) ?? { data: [] };
        if (row instanceof Error) throw row;
        return { dto: { type, ...row }, source: 'cache' };
      },
    })
  );

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
  loggingMock.logToAxiom.mockClear();
  h.flagOn = true;
  h.rows.clear();
  freshReader();
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
      freshReader();
      setBlocked({ id: 1, data });
      expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
    }
  });

  it('decides the floor through managedProfanityEntries', async () => {
    setBlocked({ id: 1, data: MANAGED });
    managedRule.refuseAll = true;
    try {
      expect((await verdicts()).source).toBe('fallback');
    } finally {
      managedRule.refuseAll = false;
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
    expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
  });

  // A rollback: flag off, the row fixed, flag back on, then an outage. The pod enforced the
  // shipped list in between, so that is what it falls back to, not the list from before.
  it('a read error after the flag was off falls back to the shipped list, not the older managed one', async () => {
    setBlocked({ id: 1, data: MANAGED });
    await verdicts();
    h.flagOn = false;
    await verdicts();
    h.flagOn = true;
    setBlocked(new Error('redis and db down'));
    expect(await verdicts()).toEqual({ source: 'fallback', managed: false, shipped: true });
  });

  it('logs a lasting fault once a minute, not on every read', async () => {
    setBlocked({ id: 1, data: MANAGED.slice(0, 3) });
    await verdicts();
    await verdicts();
    expect(
      loggingMock.logToAxiom.mock.calls.filter(
        (call) => (call[0] as { name: string }).name === 'profanity-blocklist-below-floor'
      )
    ).toHaveLength(1);
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

describe('shared reads', () => {
  it('serves one list read to every check within a few seconds', async () => {
    const read = vi.fn(async () => ({ blocked: null, allowed: null, source: 'shipped' as const }));
    setProfanityListReaderForTests({ read }, 5_000);
    await Promise.all([getServerProfanityFilter(), getServerProfanityFilter()]);
    await getServerProfanityFilter();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed read', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ blocked: null, allowed: null, source: 'shipped' });
    setProfanityListReaderForTests({ read }, 5_000);
    await expect(getServerProfanityFilter()).rejects.toThrow('down');
    await getServerProfanityFilter();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('isProfaneSearch', () => {
  it('refuses a search that matches the managed list', async () => {
    setBlocked({ id: 1, data: MANAGED });
    expect(await isProfaneSearch(['hello', `a ${MANAGED_WORD} b`])).toBe(true);
    expect(await isProfaneSearch(['hello', SHIPPED_WORD])).toBe(false);
  });

  // The browser leaves these searches to the server whatever the flag says.
  it('checks against what the browser checks while profanity-managed-list is off', async () => {
    h.flagOn = false;
    expect(await isProfaneSearch([SHIPPED_WORD])).toBe(true);
    expect(await isProfaneSearch(['hello'])).toBe(false);
  });

  it("flag off: allows the moderators' benign words, from the shared read, not a read per search", async () => {
    h.flagOn = false;
    // A word that contains a shipped entry and is profane until the moderators allow it.
    const benignWord = `zq${SHIPPED_WORD}zq`;
    expect(await isProfaneSearch([benignWord])).toBe(true);
    h.rows.set(BlocklistType.ProfanityBenignWord, { id: 2, data: [benignWord] });
    const readRow = vi.fn(async (type: string) => {
      const row = h.rows.get(type) ?? { data: [] };
      if (row instanceof Error) throw row;
      return { dto: { type, ...row }, source: 'cache' as const };
    });
    setProfanityListReaderForTests(createProfanityListReader({ readRow: readRow as never }), 5_000);
    expect([
      await isProfaneSearch([benignWord]),
      await isProfaneSearch([benignWord]),
      await isProfaneSearch([SHIPPED_WORD]),
    ]).toEqual([false, false, true]);
    expect(readRow).toHaveBeenCalledTimes(1);
  });

  // The flip is measured against the refusal rate with the flag off; uncounted, there is none.
  it('counts a refusal with the flag off, or with the list unreadable, by source only', async () => {
    const { hits } = ensureRegisterProfanityListMetrics();
    const count = async (source: string) =>
      (await hits.get()).values
        .filter((v) => v.labels.surface === 'search' && v.labels.source === source)
        .reduce((sum, v) => sum + v.value, 0);
    h.flagOn = false;
    const shipped = await count('shipped');
    expect([await isProfaneSearch([SHIPPED_WORD]), await isProfaneSearch(['hello'])]).toEqual([
      true,
      false,
    ]);
    expect(await count('shipped')).toBe(shipped + 1);

    setProfanityListReaderForTests({ read: () => Promise.reject(new Error('list down')) });
    const fallback = await count('fallback');
    expect(await isProfaneSearch([SHIPPED_WORD])).toBe(true);
    expect(await count('fallback')).toBe(fallback + 1);
  });

  // The label is how moderators find which entry drives refusals. If it ever carried the query,
  // user text would land in Prometheus and its cardinality would be unbounded.
  async function labelsMovedBy(source: string, query: string) {
    const { hits } = ensureRegisterProfanityListMetrics();
    const entries = async () =>
      new Map(
        (await hits.get()).values
          .filter((v) => v.labels.surface === 'search' && v.labels.source === source)
          .map((v) => [v.labels.entry as string, v.value])
      );
    const before = await entries();
    expect(await isProfaneSearch(['hello', query])).toBe(true);
    const after = await entries();
    return [...after]
      .filter(([entry, value]) => value !== (before.get(entry) ?? 0))
      .map(([entry, value]) => [entry, value - (before.get(entry) ?? 0)]);
  }

  it('labels a search refusal with the matched list entry id, never the query', async () => {
    setBlocked({ id: 1, data: MANAGED });
    const typed = `zqvunique${MANAGED_WORD}zqv`;
    const moved = await labelsMovedBy('managed', `left ${typed} right`);
    expect(moved).toEqual([[profanityEntryId(MANAGED_WORD), 1]]);
    expect(moved.flat()).not.toContain(profanityEntryId(typed));
  });

  it('labels a fallback refusal with the matched list entry id, never the query', async () => {
    setProfanityListReaderForTests({ read: () => Promise.reject(new Error('list down')) });
    const typed = `zqvunique${SHIPPED_WORD}zqv`;
    const moved = await labelsMovedBy('fallback', `left ${typed} right`);
    expect(moved).toEqual([[profanityEntryId(SHIPPED_WORD), 1]]);
    expect(moved.flat()).not.toContain(profanityEntryId(typed));
  });

  it('keys an entry id on the entry without its boundary markers or case', () => {
    expect(profanityEntryId('|Zqvox|')).toBe(profanityEntryId('zqvox'));
    expect(profanityEntryId('zqvox')).toMatch(/^[0-9a-f]{8}$/);
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
