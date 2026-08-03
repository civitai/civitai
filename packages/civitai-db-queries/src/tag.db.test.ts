import { beforeEach, describe, expect, it } from 'vitest';
import { createTag, deleteTag, getTagById, updateTag, upsertTagsByName } from './tag.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('tag.db', () => {
  it('createTag inserts name + target (enum array) + nsfw (scalar enum) + updatedAt', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is logged first.
    await createTag(harness.db, { name: 'test', target: ['Model', 'Image'], nsfw: 'None' }).catch(
      () => {}
    );
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('insert into "Tag"');
    expect(sql).toContain('"name"');
    expect(sql).toContain('"target"');
    expect(sql).toContain('"nsfw"');
    expect(sql).toContain('"updatedAt"');
    expect(sql).toContain('returning *');
    expect(parameters).toContainEqual(['Model', 'Image']); // the enum array binds as one param
    expect(parameters[parameters.length - 1]).toBeInstanceOf(Date); // explicit updatedAt on insert
  });

  it('createTag omits nsfw when not provided (DB default applies)', async () => {
    await createTag(harness.db, { name: 'test', target: ['Model'] }).catch(() => {});
    const { sql } = harness.lastQuery();
    expect(sql).not.toContain('"nsfw"');
  });

  it('getTagById selects the enum + enum-array fields', async () => {
    await getTagById(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "id", "name", "target", "nsfw", "nsfwLevel", "createdAt", "updatedAt" ' +
        'from "Tag" where "id" = $1'
    );
    expect(parameters).toEqual([7]);
  });

  it('updateTag sets the given columns and the plugin auto-stamps updatedAt (Tag is @updatedAt)', async () => {
    await updateTag(harness.db, { id: 7, target: ['Article', 'Post'], nsfw: 'Soft' });
    const { sql } = harness.lastQuery();
    expect(sql).toBe(
      'update "Tag" set "target" = $1, "nsfw" = $2, "updatedAt" = $3 where "id" = $4 returning *'
    );
  });

  it('deleteTag deletes by id', async () => {
    await deleteTag(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "Tag" where "id" = $1');
    expect(parameters).toEqual([7]);
  });

  it('upsertTagsByName batch-inserts (do nothing on name) then resolves ids by name', async () => {
    await upsertTagsByName(harness.db, ['anime', 'cat'], ['Model', 'Image']);
    // [0] the batched on-conflict insert; [1] the id lookup covering created + pre-existing
    expect(harness.queries[0].sql).toBe(
      'insert into "Tag" ("name", "target", "updatedAt") values ($1, $2, $3), ($4, $5, $6) ' +
        'on conflict ("name") do nothing'
    );
    expect(harness.queries[0].parameters[0]).toBe('anime');
    expect(harness.queries[0].parameters[1]).toEqual(['Model', 'Image']); // enum array binds as one param
    expect(harness.queries[1].sql).toBe('select "id" from "Tag" where "name" in ($1, $2)');
    expect(harness.queries[1].parameters).toEqual(['anime', 'cat']);
  });

  it('upsertTagsByName short-circuits an empty name list (no queries)', async () => {
    const ids = await upsertTagsByName(harness.db, [], ['Model']);
    expect(ids).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });
});
