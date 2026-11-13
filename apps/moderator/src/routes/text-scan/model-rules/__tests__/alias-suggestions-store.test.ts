import { describe, expect, it } from 'vitest';
import { parseAliases } from '$lib/model-rules';
import {
  aliasPendingKey,
  pendingClaim,
  prunePending,
  readPending,
  setPending,
  aliasSuggestionsKey,
  isStaleSuggestion,
  searchFingerprint,
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
  fingerprint: 'fp-a',
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
    expect(isStaleSuggestion(entry(), new Date('2026-01-01T00:00:00.000Z'), 'fp-a')).toBe(false);
    expect(isStaleSuggestion(entry(), '2026-01-01T00:00:00.000Z', 'fp-a')).toBe(false);
  });

  it('is stale once the rule was saved again', () => {
    expect(isStaleSuggestion(entry(), new Date('2026-01-02T00:00:00.000Z'), 'fp-a')).toBe(true);
  });

  it('is stale when it was fetched for other text than the consumer will use', () => {
    expect(isStaleSuggestion(entry(), '2026-01-01T00:00:00.000Z', 'fp-draft')).toBe(true);
  });

  it('reads an entry stored before fingerprints existed as stale, never as matching', () => {
    const raw = JSON.stringify({ 3: { updatedAt: '2026-01-01T00:00:00.000Z', suggestions: [] } });
    const read = readSuggestions(memory({ [KEY]: raw }), KEY)[3];
    expect(isStaleSuggestion(read, '2026-01-01T00:00:00.000Z', 'fp-a')).toBe(true);
    expect(isStaleSuggestion(read, '2026-01-01T00:00:00.000Z', '')).toBe(true);
  });
});

describe('pruneSuggestions', () => {
  it('forgets rules that no longer exist', () => {
    expect(Object.keys(pruneSuggestions({ 3: entry(), 4: entry() }, [{ id: 3 }]))).toEqual(['3']);
  });
});

describe('pending searches', () => {
  const PKEY = aliasPendingKey(7);
  const pending = {
    updatedAt: '2026-01-01T00:00:00.000Z',
    fingerprint: 'fp-a',
    workflowId: 'wf_0123456789',
  };

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
      4: { updatedAt: 5, fingerprint: 'fp-a', workflowId: 'wf_0123456789' },
      5: { updatedAt: pending.updatedAt, fingerprint: 'fp-a', workflowId: '../x' },
      6: { updatedAt: pending.updatedAt, workflowId: 'wf_0123456789' },
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

  it('is pruned when the rule is gone', () => {
    expect(Object.keys(prunePending({ 3: pending, 4: pending }, [{ id: 3 }]))).toEqual(['3']);
  });
});

describe('pendingClaim', () => {
  const pending = {
    updatedAt: '2026-01-01T00:00:00.000Z',
    fingerprint: 'fp-a',
    workflowId: 'wf_0123456789',
  };
  const at = new Date('2026-01-01T00:00:00.000Z');

  it('is mine only for the same rule version and the same text', () => {
    expect(pendingClaim(pending, at, 'fp-a')).toBe('mine');
  });

  it('is another consumer’s when the text differs, and is not to be deleted by this one', () => {
    expect(pendingClaim(pending, at, 'fp-draft')).toBe('other');
  });

  it('is obsolete once the rule was saved again, whoever asks', () => {
    expect(pendingClaim(pending, new Date('2026-01-02T00:00:00.000Z'), 'fp-a')).toBe('obsolete');
    expect(pendingClaim(pending, new Date('2026-01-02T00:00:00.000Z'), 'fp-draft')).toBe(
      'obsolete'
    );
  });
});

describe('searchFingerprint', () => {
  const rule = { subject: 'Alpha Beta', description: 'About', aliases: ['One', 'Two'] };

  it('is the same for the same text however the edges are spaced', () => {
    expect(searchFingerprint({ ...rule, subject: ' Alpha Beta ', description: 'About\n' })).toBe(
      searchFingerprint(rule)
    );
  });

  it('differs when the subject, description or aliases differ', () => {
    const base = searchFingerprint(rule);
    expect(searchFingerprint({ ...rule, subject: 'Alpha' })).not.toBe(base);
    expect(searchFingerprint({ ...rule, description: 'Other' })).not.toBe(base);
    expect(searchFingerprint({ ...rule, aliases: ['One'] })).not.toBe(base);
    expect(searchFingerprint({ ...rule, aliases: ['Two', 'One'] })).not.toBe(base);
  });

  it('cannot be forged by moving text between fields', () => {
    expect(searchFingerprint({ subject: 'a', description: 'b', aliases: [] })).not.toBe(
      searchFingerprint({ subject: 'a', description: '', aliases: ['b'] })
    );
  });

  it('is the same for an untouched editor as for the saved rule', () => {
    const saved = {
      subject: 'Alpha',
      description: 'About',
      aliases: ['Doe, Jane', 'Two  Spaces', 'two spaces'],
    };
    const formText = saved.aliases.join('\n');
    expect(searchFingerprint({ ...saved, aliases: parseAliases(formText) })).toBe(
      searchFingerprint(saved)
    );
    expect(searchFingerprint({ ...saved, aliases: [formText] })).toBe(searchFingerprint(saved));
  });
});
