import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteImageForUser,
  deleteImageReactionForUser,
  updateImage,
  updateImageMany,
} from './image.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('updateImage', () => {
  it('sets the given columns plus an auto-stamped updatedAt, and returns the row', async () => {
    await updateImage(h.db, { id: 42, needsReview: 'appeal' });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Image" set "needsReview" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters[0]).toBe('appeal');
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(42);
  });
});

describe('updateImageMany', () => {
  it('short-circuits an empty id list without touching the DB', async () => {
    const result = await updateImageMany(h.db, { ids: [], needsReview: 'csam' });
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('bulk-sets the given columns plus an auto-stamped updatedAt across the ids', async () => {
    await updateImageMany(h.db, { ids: [1, 2, 3], needsReview: 'csam' });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Image" set "needsReview" = $1, "updatedAt" = $2 where "id" in ($3, $4, $5)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters[0]).toBe('csam');
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters.slice(2)).toEqual([1, 2, 3]);
  });
});

describe('image per-table deletes', () => {
  const simpleDeletes: Array<[string, (userId: number) => unknown, string]> = [
    ['ImageReaction', (u) => deleteImageReactionForUser(h.db, u), 'ImageReaction'],
    ['Image', (u) => deleteImageForUser(h.db, u), 'Image'],
  ];

  it.each(simpleDeletes)('%s: delete from table where userId', async (_name, fn, table) => {
    await fn(7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(`delete from "${table}" where "userId" = $1`);
    expect(parameters).toEqual([7]);
  });
});
