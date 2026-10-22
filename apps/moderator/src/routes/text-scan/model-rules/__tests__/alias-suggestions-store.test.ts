import { describe, expect, it } from 'vitest';
import {
  aliasPendingKey,
  isStalePending,
  prunePending,
  readPending,
  setPending,
  aliasSuggestionsKey,
  isStaleSuggestion,
  pruneSuggestions,
  readSuggestions,
  writeSuggestions,
  type StoredSuggestions,
} from '../alias-suggestions-store';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  };
};
const KEY = aliasSuggestionsKey(7);
const entry = (over: Partial<StoredSuggestions> = {}): StoredSuggestions => ({
  updatedAt: '2026-01-01T00:00:00.000Z',
  costTotal: 3,
  suggestions: [
    { alias: 'One Name', kind: 'stage_name', note: 'n', source: 'https://example.com' },
  ],
  ...over,
});

describe('suggestion persistence', () => {
  it('round-trips what was written', () => {
    const store = memory();
    expect(writeSuggestions(store, KEY, { 3: entry() })).toBe(true);
    expect(readSuggestions(store, KEY)).toEqual({ 3: entry() });
  });

  it('is keyed per moderator', () => {
    expect(aliasSuggestionsKey(1)).not.toBe(aliasSuggestionsKey(2));
  });

  it('reads nothing from missing, corrupt or wrongly shaped storage', () => {
    expect(readSuggestions(null, KEY)).toEqual({});
    expect(readSuggestions(memory(), KEY)).toEqual({});
    expect(readSuggestions(memory({ [KEY]: '{nope' }), KEY)).toEqual({});
    expect(readSuggestions(memory({ [KEY]: '[]' }), KEY)).toEqual({});
  });

  it('drops malformed entries and unsafe links but keeps the good ones', () => {
    const raw = JSON.stringify({
      3: entry(),
      4: { updatedAt: 5, suggestions: [] },
      5: entry({
        suggestions: [{ alias: 'X Y', kind: 'bogus' as never, source: 'javascript:alert(1)' }],
      }),
      nope: entry(),
    });
    const read = readSuggestions(memory({ [KEY]: raw }), KEY);
    expect(Object.keys(read).sort()).toEqual(['3', '5']);
    expect(read[5].suggestions).toEqual([{ alias: 'X Y', kind: 'other' }]);
  });

  it('survives a store that throws on read or write', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(readSuggestions(broken, KEY)).toEqual({});
    expect(writeSuggestions(broken, KEY, { 3: entry() })).toBe(false);
    expect(writeSuggestions(null, KEY, { 3: entry() })).toBe(false);
  });

  it('removes the key once nothing is held', () => {
    const store = memory();
    writeSuggestions(store, KEY, { 3: entry() });
    expect(writeSuggestions(store, KEY, {})).toBe(true);
    expect(store.data[KEY]).toBeUndefined();
  });
});

describe('isStaleSuggestion', () => {
  it('is fresh while the rule keeps the updatedAt the suggestions were fetched for', () => {
    expect(isStaleSuggestion(entry(), new Date('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(isStaleSuggestion(entry(), '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('is stale once the rule was saved again', () => {
    expect(isStaleSuggestion(entry(), new Date('2026-01-02T00:00:00.000Z'))).toBe(true);
  });
});

describe('pruneSuggestions', () => {
  it('forgets rules that no longer exist', () => {
    expect(Object.keys(pruneSuggestions({ 3: entry(), 4: entry() }, [{ id: 3 }]))).toEqual(['3']);
  });
});

describe('pending searches', () => {
  const PKEY = aliasPendingKey(7);
  const pending = { updatedAt: '2026-01-01T00:00:00.000Z', workflowId: 'wf_0123456789' };

  it('is keyed per moderator and apart from the held suggestions', () => {
    expect(aliasPendingKey(1)).not.toBe(aliasPendingKey(2));
    expect(aliasPendingKey(7)).not.toBe(aliasSuggestionsKey(7));
  });

  it('round-trips a stored workflow id', () => {
    const store = memory();
    expect(setPending(store, PKEY, 3, pending)).toBe(true);
    expect(readPending(store, PKEY)).toEqual({ 3: pending });
  });

  it('keeps other rules’ entries when one is set or cleared', () => {
    const store = memory();
    setPending(store, PKEY, 3, pending);
    setPending(store, PKEY, 4, { ...pending, workflowId: 'wf_other_0001' });
    setPending(store, PKEY, 3, null);
    expect(Object.keys(readPending(store, PKEY))).toEqual(['4']);
    setPending(store, PKEY, 4, null);
    expect(store.data[PKEY]).toBeUndefined();
  });

  it('reads nothing from broken storage and drops malformed entries', () => {
    expect(readPending(null, PKEY)).toEqual({});
    expect(readPending(memory({ [PKEY]: '{nope' }), PKEY)).toEqual({});
    const raw = JSON.stringify({
      3: pending,
      4: { updatedAt: 5, workflowId: 'wf_0123456789' },
      5: { updatedAt: pending.updatedAt, workflowId: '../x' },
      nope: pending,
    });
    expect(Object.keys(readPending(memory({ [PKEY]: raw }), PKEY))).toEqual(['3']);
  });

  it('survives a store that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(readPending(broken, PKEY)).toEqual({});
    expect(setPending(broken, PKEY, 3, pending)).toBe(false);
  });

  it('is stale once the rule was saved again, and pruned when the rule is gone', () => {
    expect(isStalePending(pending, new Date('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(isStalePending(pending, new Date('2026-01-02T00:00:00.000Z'))).toBe(true);
    expect(Object.keys(prunePending({ 3: pending, 4: pending }, [{ id: 3 }]))).toEqual(['3']);
  });
});
