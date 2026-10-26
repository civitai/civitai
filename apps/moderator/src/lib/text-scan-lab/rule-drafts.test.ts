import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  RuleDraftsState,
  fieldsOf,
  ruleDraftsStorageKey,
  type RuleDraftsFields,
  type SavedRule,
} from './rule-drafts';

const KEY = ruleDraftsStorageKey(7);

function memoryStore() {
  const data = new Map<string, string>();
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
const make = (store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = memoryStore()) =>
  new RuleDraftsState({ drafts: {} } as RuleDraftsFields, store, KEY);

const UPDATED = new Date('2026-09-01T10:00:00.000Z');
const saved = (patch: Partial<SavedRule> = {}): SavedRule => ({
  id: 3,
  legacy: false,
  subject: 'Example',
  description: 'Desc',
  aliases: ['One'],
  note: '',
  enabled: true,
  updatedAt: UPDATED,
  ...patch,
});

describe('editing a saved rule', () => {
  it('records the version the edit started from and keeps it through later edits', () => {
    const drafts = make();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    drafts.edit(saved({ updatedAt: new Date('2026-09-02T00:00:00.000Z') }), {
      ...fieldsOf(saved()),
      subject: 'Edited again',
    });
    expect(drafts.get(3)).toMatchObject({
      subject: 'Edited again',
      baseUpdatedAt: UPDATED.toISOString(),
    });
  });

  it('drops the draft when the text is back to the saved text', () => {
    const drafts = make();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    drafts.edit(saved(), fieldsOf(saved()));
    expect(drafts.ids).toEqual([]);
  });

  it('is stale once the saved rule changes, and current again once kept', () => {
    const drafts = make();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    const newer = saved({ updatedAt: new Date('2026-09-03T00:00:00.000Z') });
    expect(drafts.isStale(newer)).toBe(true);
    drafts.keepMine(newer);
    expect(drafts.isStale(newer)).toBe(false);
  });
});

describe('new rules', () => {
  it('allocates distinct negative ids across two tabs sharing storage', () => {
    const store = memoryStore();
    const a = make(store);
    const b = make(store);
    expect(a.add()).toBe(-1);
    expect(b.add()).toBe(-2);
    a.reload();
    expect(a.ids).toEqual([-2, -1]);
  });

  it('never reuses an id in this tab when storage is unavailable', () => {
    const drafts = make(throwing);
    expect([drafts.add(), drafts.add()]).toEqual([-1, -2]);
  });
});

describe('what a try sends', () => {
  it('sends edited and new rules with trimmed text and parsed aliases, skipping what cannot be judged', () => {
    const drafts = make();
    const rules = [saved(), saved({ id: 4, enabled: false }), saved({ id: 5, legacy: true })];
    drafts.edit(rules[0], { ...fieldsOf(rules[0]), subject: ' Edited ', aliases: 'A\nB\na' });
    drafts.edit(rules[1], { ...fieldsOf(rules[1]), description: 'Changed' });
    drafts.edit(rules[2], { ...fieldsOf(rules[2]), subject: 'Regex edited' });
    const blank = drafts.add();
    const named = drafts.add();
    drafts.editNew(named, { ...EMPTY, subject: 'New rule' });
    expect(blank).toBe(-1);
    expect(drafts.overrides(rules)).toEqual([
      { id: -2, subject: 'New rule', description: '', aliases: [], enabled: true },
      { id: 3, subject: 'Edited', description: 'Desc', aliases: ['A', 'B'], enabled: true },
      { id: 4, subject: 'Example', description: 'Changed', aliases: ['One'], enabled: false },
    ]);
  });

  it('skips the draft of a rule that no longer exists', () => {
    const drafts = make();
    drafts.edit(saved({ id: 9 }), { ...fieldsOf(saved()), subject: 'Gone' });
    expect(drafts.overrides([saved()])).toEqual([]);
  });
});

describe('Save all', () => {
  it('sends drafted rules with their base version, and no untouched new rule', () => {
    const drafts = make();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    drafts.add();
    const named = drafts.add();
    drafts.editNew(named, { ...EMPTY, subject: 'New rule', aliases: 'X' });
    expect(drafts.saveAllPayload([saved()])).toEqual([
      {
        draftId: -2,
        subject: 'New rule',
        description: '',
        aliases: 'X',
        category: '',
        references: [],
        note: '',
      },
      {
        draftId: 3,
        id: 3,
        subject: 'Edited',
        description: 'Desc',
        aliases: 'One',
        category: '',
        references: [],
        note: '',
        baseUpdatedAt: UPDATED.toISOString(),
      },
    ]);
  });
});

describe('prune', () => {
  it('drops drafts of deleted rules and drafts the reload made current, keeping new rules', () => {
    const drafts = make();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    drafts.edit(saved({ id: 9 }), { ...fieldsOf(saved()), subject: 'Gone' });
    const id = drafts.add();
    drafts.prune([saved({ subject: 'Edited' })]);
    expect(drafts.ids).toEqual([id]);
  });
});

describe('your own write to a rule', () => {
  const edited = { ...fieldsOf(saved()), subject: 'Edited' };
  const toggled = saved({ enabled: false, updatedAt: new Date('2026-09-04T00:00:00.000Z') });

  it('rebases a draft that was current onto the rule the write produced', () => {
    const drafts = make();
    drafts.edit(saved(), edited);
    drafts.rebaseOwnWrite(saved(), toggled);
    expect(drafts.isStale(toggled)).toBe(false);
    expect(drafts.get(3)).toMatchObject({
      subject: 'Edited',
      baseUpdatedAt: '2026-09-04T00:00:00.000Z',
    });
  });

  it('leaves a draft that was already stale stale', () => {
    const drafts = make();
    drafts.edit(saved(), edited);
    const theirs = saved({ updatedAt: new Date('2026-09-02T00:00:00.000Z') });
    drafts.rebaseOwnWrite(theirs, toggled);
    expect(drafts.isStale(toggled)).toBe(true);
    expect(drafts.get(3)?.baseUpdatedAt).toBe(UPDATED.toISOString());
  });
});

describe('storage that reads but cannot write', () => {
  it('keeps drafts that never reached storage, alongside drafts other tabs stored', () => {
    const store = memoryStore();
    store.data.set(
      KEY,
      JSON.stringify({ 9: { ...fieldsOf(saved()), subject: 'Other tab', baseUpdatedAt: null } })
    );
    const drafts = make({
      ...store,
      setItem: () => {
        throw new Error('quota');
      },
    });
    drafts.reload();
    drafts.edit(saved(), { ...fieldsOf(saved()), subject: 'Edited' });
    drafts.edit(saved({ id: 4 }), { ...fieldsOf(saved()), subject: 'Also edited' });
    drafts.reload();
    expect(drafts.ids).toEqual([3, 4, 9]);
    expect(drafts.get(3)?.subject).toBe('Edited');
  });
});

describe('category and references', () => {
  const withRefs = saved({
    category: 'artist',
    references: [{ url: 'https://example.com/a', label: 'Portfolio' }, { url: 'https://example.com/b' }],
  });

  it('reads them from the saved rule, and a rule without them reads as none', () => {
    expect(fieldsOf(withRefs)).toMatchObject({
      category: 'artist',
      references: [
        { url: 'https://example.com/a', label: 'Portfolio' },
        { url: 'https://example.com/b', label: '' },
      ],
    });
    expect(fieldsOf(saved())).toMatchObject({ category: '', references: [] });
  });

  it('counts a change to either as an edit, and an unchanged copy as none', () => {
    const drafts = make();
    drafts.edit(withRefs, fieldsOf(withRefs));
    expect(drafts.get(3)).toBeUndefined();
    drafts.edit(withRefs, { ...fieldsOf(withRefs), category: 'ip' });
    expect(drafts.get(3)).toMatchObject({ category: 'ip' });
    drafts.edit(withRefs, { ...fieldsOf(withRefs), references: [] });
    expect(drafts.get(3)?.references).toEqual([]);
  });

  it('loads a draft stored before the two fields existed', () => {
    const store = memoryStore();
    store.data.set(
      KEY,
      JSON.stringify({
        '3': {
          subject: 'Old',
          description: '',
          aliases: '',
          note: '',
          baseUpdatedAt: UPDATED.toISOString(),
        },
        '4': { subject: 'Odd', description: '', aliases: '', note: '', category: 'bogus', references: [5, { url: 'https://example.com' }], baseUpdatedAt: null },
      })
    );
    const drafts = make(store);
    drafts.reload();
    expect(drafts.get(3)).toMatchObject({ subject: 'Old', category: '', references: [] });
    expect(drafts.get(4)).toMatchObject({
      category: '',
      references: [{ url: 'https://example.com', label: '' }],
    });
  });

  it('does not send blank reference rows to Save all, and a row-only draft is not empty', () => {
    const drafts = make();
    const id = drafts.add();
    drafts.editNew(id, { ...EMPTY, references: [{ url: '  ', label: 'x' }] });
    expect(drafts.saveAllPayload([])).toEqual([]);
    drafts.editNew(id, {
      ...EMPTY,
      subject: 'S',
      references: [
        { url: 'https://example.com', label: ' ' },
        { url: '', label: '' },
      ],
    });
    expect(drafts.saveAllPayload([])[0].references).toEqual([{ url: 'https://example.com' }]);
  });
});
