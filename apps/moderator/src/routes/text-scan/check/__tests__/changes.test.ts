import { describe, expect, it } from 'vitest';
import {
  ChangesState,
  changesStorageKey,
  readChanges,
  writeChanges,
  type ChangesFields,
} from '../changes';

const KEY = changesStorageKey(7);

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const make = (store: Parameters<typeof readChanges>[0]) =>
  new ChangesState({ prompts: {} } satisfies ChangesFields, store, KEY);

describe('stored changes', () => {
  it('keys the store per moderator', () => {
    expect(changesStorageKey(7)).not.toBe(changesStorageKey(8));
  });

  it('reads only known keys with string text, and nothing from junk', () => {
    const store = memoryStore({
      [KEY]: JSON.stringify({ base: 'BASE PROMPT', 'label:retired': 'x', 'label:scam': 3 }),
    });
    expect(readChanges(store, KEY)).toEqual({ base: 'BASE PROMPT' });
    expect(readChanges(memoryStore({ [KEY]: 'not json' }), KEY)).toEqual({});
    expect(readChanges(memoryStore({ [KEY]: '[1]' }), KEY)).toEqual({});
    expect(readChanges(null, KEY)).toEqual({});
  });

  it('removes the entry when there are no changes', () => {
    const store = memoryStore();
    writeChanges(store, KEY, { base: 'B' });
    expect(store.data.get(KEY)).toBe('{"base":"B"}');
    writeChanges(store, KEY, {});
    expect(store.data.has(KEY)).toBe(false);
  });

  it('survives storage that throws, keeping changes in memory', () => {
    expect(readChanges(throwing, KEY)).toEqual({});
    expect(() => writeChanges(throwing, KEY, { base: 'B' })).not.toThrow();
    const changes = make(throwing);
    changes.restore({});
    changes.set('base', 'MINE', 'CURRENT');
    expect(changes.prompts).toEqual({ base: 'MINE' });
  });
});

describe('ChangesState', () => {
  it('saves each edit, and treats text equal to current as no change', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('label:scam', 'SCAM DEF', 'CURRENT');
    expect(changes.keys).toEqual(['label:scam']);
    expect(JSON.parse(store.data.get(KEY)!)).toEqual({ 'label:scam': 'SCAM DEF' });
    changes.set('label:scam', 'CURRENT', 'CURRENT');
    expect(changes.keys).toEqual([]);
    expect(store.data.has(KEY)).toBe(false);
  });

  it('restores stored changes, dropping those now equal to current', () => {
    const store = memoryStore({
      [KEY]: JSON.stringify({ base: 'PUBLISHED', 'label:scam': 'SCAM DEF' }),
    });
    const changes = make(store);
    changes.restore({ base: 'PUBLISHED', 'label:scam': 'OLD' });
    expect(changes.prompts).toEqual({ 'label:scam': 'SCAM DEF' });
    expect(JSON.parse(store.data.get(KEY)!)).toEqual({ 'label:scam': 'SCAM DEF' });
  });

  it('resets one key and discards all', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('base', 'B', undefined);
    changes.set('label:nsfw', 'N', undefined);
    changes.resetKey('base');
    expect(changes.keys).toEqual(['label:nsfw']);
    changes.discard();
    expect(changes.keys).toEqual([]);
    expect(store.data.has(KEY)).toBe(false);
  });

  it('names blank changes', () => {
    const changes = make(memoryStore());
    changes.set('base', '  ', 'CURRENT');
    expect(changes.blankError).toBe(
      'General instructions is empty — write it, or reset it to current.'
    );
  });
});
