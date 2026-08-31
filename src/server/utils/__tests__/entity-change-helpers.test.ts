import { describe, expect, it } from 'vitest';
import { diffEntityChanges, resolveActorRole, stableStringify } from '../entity-change-helpers';

const base = {
  entityType: 'Model' as const,
  entityId: 42,
  ownerId: 7,
  actorRole: 'owner' as const,
};

describe('stableStringify', () => {
  it('is insensitive to object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('is insensitive to primitive array order', () => {
    expect(stableStringify(['b', 'a'])).toBe(stableStringify(['a', 'b']));
  });

  it('encodes undefined as unset and null as null', () => {
    expect(stableStringify(undefined)).toBe('');
    expect(stableStringify(null)).toBe('null');
  });

  it('drops undefined object entries', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('diffEntityChanges', () => {
  it('emits nothing on creation (before null)', () => {
    expect(diffEntityChanges({ ...base, before: null, after: { nsfw: true } })).toEqual([]);
  });

  it('emits one row per changed scalar field and skips unchanged/absent ones', () => {
    const rows = diffEntityChanges({
      ...base,
      before: { nsfw: false, poi: false, minor: false },
      after: { nsfw: true, poi: false }, // minor absent = untouched
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'nsfw',
      oldValue: 'false',
      newValue: 'true',
      truncated: 0,
      actorRole: 'owner',
      reason: '',
    });
  });

  it('ignores fields not in the watched registry', () => {
    const rows = diffEntityChanges({
      ...base,
      before: { gallerySettings: { a: 1 } },
      after: { gallerySettings: { a: 2 } },
    });
    expect(rows).toEqual([]);
  });

  it('does not emit for array order changes, but does for content changes', () => {
    const unchanged = diffEntityChanges({
      ...base,
      before: { lockedProperties: ['nsfw', 'poi'] },
      after: { lockedProperties: ['poi', 'nsfw'] },
    });
    expect(unchanged).toEqual([]);

    const changed = diffEntityChanges({
      ...base,
      before: { lockedProperties: ['poi'] },
      after: { lockedProperties: ['poi', 'nsfw'] },
    });
    expect(changed).toHaveLength(1);
    expect(changed[0].field).toBe('lockedProperties');
  });

  it('expands JSON-object fields into dotted leaf rows', () => {
    const rows = diffEntityChanges({
      ...base,
      entityType: 'ModelVersion',
      before: {
        paidAccess: { permanent: false, timeframeDays: 3, terms: { download: { price: 100 } } },
      },
      after: {
        paidAccess: { permanent: false, timeframeDays: 7, terms: { download: { price: 100 } } },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'paidAccess.timeframeDays',
      oldValue: '3',
      newValue: '7',
    });
  });

  it('diffs object-vs-null per leaf (gate cleared)', () => {
    const rows = diffEntityChanges({
      ...base,
      entityType: 'ModelVersion',
      before: { paidAccess: { timeframeDays: 3 } },
      after: { paidAccess: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'paidAccess.timeframeDays',
      oldValue: '3',
      newValue: 'null',
    });
  });

  it('shares one batchId across all rows of a save', () => {
    const rows = diffEntityChanges({
      ...base,
      before: { nsfw: false, poi: false },
      after: { nsfw: true, poi: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].batchId).toBe(rows[1].batchId);
    expect(rows[0].batchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('caps oversized values and flags truncated', () => {
    const huge = 'x'.repeat(70 * 1024);
    const rows = diffEntityChanges({
      ...base,
      before: { description: 'small' },
      after: { description: huge },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].truncated).toBe(1);
    expect(rows[0].newValue.length).toBe(64 * 1024);
    expect(rows[0].oldValue).toBe('"small"');
  });

  it('overrides attribution per row via systemFields', () => {
    const rows = diffEntityChanges({
      ...base,
      before: { nsfw: false, name: 'old' },
      after: { nsfw: true, name: 'new' },
      systemFields: { nsfw: 'profanity-filter' },
    });
    const nsfwRow = rows.find((r) => r.field === 'nsfw');
    const nameRow = rows.find((r) => r.field === 'name');
    expect(nsfwRow).toMatchObject({ actorRole: 'system', reason: 'profanity-filter' });
    expect(nameRow).toMatchObject({ actorRole: 'owner', reason: '' });
  });

  it('treats undefined before-values as unset (hash first write)', () => {
    const rows = diffEntityChanges({
      ...base,
      entityType: 'ModelFile',
      before: { 'hash.SHA256': undefined },
      after: { 'hash.SHA256': 'ABC123' },
      actorRole: 'system',
      reason: 'file-scan',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'hash.SHA256',
      oldValue: '',
      newValue: '"ABC123"',
      actorRole: 'system',
      reason: 'file-scan',
    });
  });
});

describe('resolveActorRole', () => {
  it('is owner for self-edits even by moderators', () => {
    expect(resolveActorRole({ actorUserId: 7, ownerId: 7, isModerator: true })).toBe('owner');
  });
  it('is moderator when a mod edits someone else', () => {
    expect(resolveActorRole({ actorUserId: 1, ownerId: 7, isModerator: true })).toBe('moderator');
  });
  it('is owner for non-mods', () => {
    expect(resolveActorRole({ actorUserId: 1, ownerId: 7 })).toBe('owner');
  });
});
