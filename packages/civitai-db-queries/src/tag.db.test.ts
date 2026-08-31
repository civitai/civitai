import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTag,
  deleteTag,
  getTagById,
  listImageTagVotes,
  listImageTagVotesMany,
  listModelTagVotes,
  updateTag,
  upsertTagsByName,
} from './tag.db';
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

// The votable-tag vote lookups. These pin the EXACT SQL because the whole point of the port is that
// the statement is unchanged: a dropped `userId` predicate here would leak other users' votes, and
// the compiled SQL is the cheapest place to catch it. Behaviour parity against the Prisma originals
// is covered separately, against a real database, by
// src/server/db/__tests__/kysely-prisma-parity.test.ts.
describe('tag.db votable-tag vote lookups', () => {
  it('listImageTagVotes filters by BOTH imageId and userId, selecting only tagId + vote', async () => {
    await listImageTagVotes(harness.db, { imageId: 42, userId: 7 });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "tagId", "vote" from "TagsOnImageVote" where "imageId" = $1 and "userId" = $2'
    );
    expect(parameters).toEqual([42, 7]);
    expect(sql).not.toContain('order by'); // the source query had none; adding one changes the plan
  });

  it('listModelTagVotes filters by BOTH modelId and userId, selecting only tagId + vote', async () => {
    await listModelTagVotes(harness.db, { modelId: 42, userId: 7 });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "tagId", "vote" from "TagsOnModelsVote" where "modelId" = $1 and "userId" = $2'
    );
    expect(parameters).toEqual([42, 7]);
  });

  it('listImageTagVotesMany expands the id list and keeps the userId predicate', async () => {
    await listImageTagVotesMany(harness.db, { imageIds: [1, 2, 3], userId: 7 });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "tagId", "vote" from "TagsOnImageVote" ' +
        'where "imageId" in ($1, $2, $3) and "userId" = $4'
    );
    expect(parameters).toEqual([1, 2, 3, 7]);
    expect(sql).not.toContain('in ()');
  });

  it('listImageTagVotesMany short-circuits an empty id list without touching the DB', async () => {
    const rows = await listImageTagVotesMany(harness.db, { imageIds: [], userId: 7 });
    expect(rows).toEqual([]);
    expect(harness.queries).toHaveLength(0); // `in ([])` would compile to the syntax error `IN ()`
  });

  it('listImageTagVotesMany does not select imageId — the caller keys votes by tagId alone', async () => {
    // Preserved from the source query verbatim. Widening the select would change what the
    // votable-tag endpoint returns, which is a behaviour change, not a fix.
    await listImageTagVotesMany(harness.db, { imageIds: [1], userId: 7 });
    expect(harness.lastQuery().sql).not.toContain('"imageId",');
  });
});
