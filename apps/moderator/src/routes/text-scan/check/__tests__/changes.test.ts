import { describe, expect, it } from 'vitest';
import {
  ChangesState,
  changesStorageKey,
  readChanges,
  writeChanges,
  type ChangesFields,
  type CurrentPrompts,
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

const CURRENT: CurrentPrompts = {
  content: { base: 'BASE PROMPT', 'label:scam': 'SCAM DEF' },
  ids: { base: 1, 'label:scam': 5 },
};

const stored = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.data.get(KEY) ?? '{}');

function make(store: Parameters<typeof readChanges>[0], current: CurrentPrompts | null = CURRENT) {
  const changes = new ChangesState(
    { changes: {}, current: null } satisfies ChangesFields,
    store,
    KEY
  );
  changes.restore(current);
  return changes;
}

describe('stored changes', () => {
  it('keys the store per moderator', () => {
    expect(changesStorageKey(7)).not.toBe(changesStorageKey(8));
  });

  it('reads only known keys holding text and a base version, and nothing from junk', () => {
    const store = memoryStore({
      [KEY]: JSON.stringify({
        base: { text: 'MINE', baseId: 1 },
        'label:nsfw': { text: 'N', baseId: null },
        'label:retired': { text: 'x', baseId: 1 },
        'label:scam': 'bare text',
        'label:poi': { text: 'P', baseId: 'x' },
      }),
    });
    expect(readChanges(store, KEY)).toEqual({
      base: { text: 'MINE', baseId: 1 },
      'label:nsfw': { text: 'N', baseId: null },
    });
    expect(readChanges(memoryStore({ [KEY]: 'not json' }), KEY)).toEqual({});
    expect(readChanges(memoryStore({ [KEY]: '[1]' }), KEY)).toEqual({});
    expect(readChanges(null, KEY)).toEqual({});
  });

  it('removes the entry when there are no changes', () => {
    const store = memoryStore();
    writeChanges(store, KEY, { base: { text: 'B', baseId: 1 } });
    expect(stored(store)).toEqual({ base: { text: 'B', baseId: 1 } });
    writeChanges(store, KEY, {});
    expect(store.data.has(KEY)).toBe(false);
  });

  it('survives storage that throws, keeping changes in memory', () => {
    expect(readChanges(throwing, KEY)).toEqual({});
    expect(() => writeChanges(throwing, KEY, { base: { text: 'B', baseId: 1 } })).not.toThrow();
    const changes = make(throwing);
    changes.set('base', 'MINE');
    changes.set('label:scam', 'SCAM MINE');
    expect(changes.prompts).toEqual({ base: 'MINE', 'label:scam': 'SCAM MINE' });
  });
});

describe('editing', () => {
  it('records the version an edit started from, and keeps it through later edits', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('label:scam', 'SCAM V1');
    changes.set('label:scam', 'SCAM V2');
    changes.set('label:nsfw', 'NSFW DEF');
    expect(stored(store)).toEqual({
      'label:scam': { text: 'SCAM V2', baseId: 5 },
      'label:nsfw': { text: 'NSFW DEF', baseId: null },
    });
    expect(changes.baseIds).toEqual({ 'label:nsfw': null, 'label:scam': 5 });
  });

  it('treats text equal to current as no change', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('base', 'MINE');
    changes.set('base', 'BASE PROMPT');
    expect(changes.keys).toEqual([]);
    expect(store.data.has(KEY)).toBe(false);
  });

  it('drops one key and discards all', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('base', 'B');
    changes.set('label:nsfw', 'N');
    changes.drop(['base']);
    expect(changes.keys).toEqual(['label:nsfw']);
    changes.discard();
    expect(changes.keys).toEqual([]);
    expect(store.data.has(KEY)).toBe(false);
  });

  it('names blank changes', () => {
    const changes = make(memoryStore());
    changes.set('base', '  ');
    expect(changes.blankError).toBe(
      'General instructions is empty — write it, or reset it to current.'
    );
  });
});

describe('a change written against an older version', () => {
  // Written against version 5; a colleague has since published version 6.
  const newer: CurrentPrompts = {
    content: { ...CURRENT.content, 'label:scam': 'COLLEAGUE SCAM DEF' },
    ids: { ...CURRENT.ids, 'label:scam': 6 },
  };
  const olderChange = () =>
    memoryStore({ [KEY]: JSON.stringify({ 'label:scam': { text: 'MY SCAM', baseId: 5 } }) });

  it('is stale after a reload, and still sends its own base, so publish refuses it', () => {
    const changes = make(olderChange(), newer);
    expect(changes.stale).toEqual(['label:scam']);
    expect(changes.baseIds).toEqual({ 'label:scam': 5 });
  });

  it('is current again once kept, against the newer version', () => {
    const store = olderChange();
    const changes = make(store, newer);
    changes.keepMine('label:scam');
    expect(changes.stale).toEqual([]);
    expect(stored(store)).toEqual({ 'label:scam': { text: 'MY SCAM', baseId: 6 } });
  });

  it('is never called stale while the current prompts are unknown', () => {
    expect(make(olderChange(), null).stale).toEqual([]);
  });
});

describe('after a publish', () => {
  it('drops a change whose text is now the current version', () => {
    const store = memoryStore();
    const changes = make(store);
    changes.set('base', 'NEW BASE');
    changes.set('label:scam', 'NEW SCAM');
    changes.setCurrent({
      content: { ...CURRENT.content, base: 'NEW BASE' },
      ids: { ...CURRENT.ids, base: 2 },
    });
    expect(changes.keys).toEqual(['label:scam']);
    expect(changes.stale).toEqual([]);
    expect(Object.keys(stored(store))).toEqual(['label:scam']);
  });
});

describe('two tabs', () => {
  it('merges per key on save, so neither tab overwrites the other', () => {
    const store = memoryStore();
    const a = make(store);
    const b = make(store);
    a.set('base', 'FROM A');
    b.set('label:scam', 'FROM B');
    expect(stored(store)).toEqual({
      base: { text: 'FROM A', baseId: 1 },
      'label:scam': { text: 'FROM B', baseId: 5 },
    });
    b.set('base', 'B WINS ITS OWN EDIT');
    expect(stored(store).base.text).toBe('B WINS ITS OWN EDIT');
  });

  it('picks up the other tab on reload, as the storage event triggers', () => {
    const store = memoryStore();
    const a = make(store);
    const b = make(store);
    a.set('base', 'FROM A');
    expect(b.keys).toEqual([]);
    b.reload();
    expect(b.prompts).toEqual({ base: 'FROM A' });
  });

  it('does not resurrect a key the other tab dropped when this tab saves another', () => {
    const store = memoryStore();
    const a = make(store);
    a.set('base', 'FROM A');
    const b = make(store);
    a.drop(['base']);
    b.set('label:scam', 'FROM B');
    expect(Object.keys(stored(store))).toEqual(['label:scam']);
  });
});
