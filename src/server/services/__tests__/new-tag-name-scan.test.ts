import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A tag name is scanned only when no Tag row has it yet. Attaching an existing tag, by id or by
// name alone, is not new text: scanning it would leave everything carrying a stored tag that now
// trips a list unsavable.

const { throwOnBlockedUserContent } = vi.hoisted(() => ({
  // Stands in for the blocklist: refuses any string containing 'blocked', in any case.
  throwOnBlockedUserContent: vi.fn(async (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === 'string' && v.toUpperCase().includes('BLOCKED')))
      throw new Error('blocked');
  }),
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent }));

import { newTagNames } from '~/server/services/new-tag-names';
import { upsertQuestion } from '~/server/services/question.service';
import { addPostTag } from '~/server/services/post.service';
import { findOrCreateTagsByName } from '~/server/services/tag.service';

const STORED = 'stored blocked tag'.replace('blocked', 'BLOCKED');

beforeEach(() => {
  vi.clearAllMocks();
  // The Tag table holds one name, which the stand-in blocklist would refuse.
  dbMock.dbWrite.tag.findMany.mockImplementation((async (args: {
    where: { name: { in: string[] } };
  }) =>
    args.where.name.in
      .filter((name) => name === STORED.toLowerCase())
      .map((name) => ({ id: 1, name }))) as never);
});

describe('newTagNames', () => {
  it('returns only names no Tag row has, normalised the way writers store them', async () => {
    expect(await newTagNames([` ${STORED.toUpperCase()} `, 'Fresh', 'fresh', null])).toEqual([
      'fresh',
    ]);
  });
});

describe('a writer that appends new tag names to its own scan (questions)', () => {
  const save = (tags: { id?: number; name: string }[]) =>
    upsertQuestion({ title: 't', content: 'c', tags, userId: 1 } as never);

  beforeEach(() => {
    dbMock.dbWrite.$transaction.mockImplementation(async () => ({ id: 9, title: 't' }));
  });

  it('saves an existing tag sent by name without an id, even one the list refuses', async () => {
    await expect(save([{ name: STORED }])).resolves.toBeDefined();
  });

  it('refuses a new tag name the list refuses', async () => {
    await expect(save([{ name: 'new BLOCKED tag' }])).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('addPostTag', () => {
  beforeEach(() => {
    dbMock.dbWrite.$transaction.mockImplementation(async () => ({ id: 1, name: STORED }));
  });

  it('attaches an existing tag the list refuses', async () => {
    await expect(addPostTag({ id: 5, name: STORED })).resolves.toBeDefined();
  });

  it('refuses to create a tag the list refuses', async () => {
    await expect(addPostTag({ id: 5, name: 'new BLOCKED tag' })).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('findOrCreateTagsByName', () => {
  it('resolves an existing tag the list refuses', async () => {
    await expect(findOrCreateTagsByName([STORED])).resolves.toEqual({ [STORED.toLowerCase()]: 1 });
  });

  it('creates a new tag beside an existing one the list refuses', async () => {
    await expect(findOrCreateTagsByName([STORED, 'fresh'])).resolves.toBeDefined();
    expect(dbMock.dbWrite.tag.createMany).toHaveBeenCalledTimes(1);
  });

  it('refuses to create a tag the list refuses, before writing', async () => {
    await expect(findOrCreateTagsByName([STORED, 'new BLOCKED tag'])).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.tag.createMany).not.toHaveBeenCalled();
  });
});
