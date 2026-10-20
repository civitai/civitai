import { beforeEach, describe, expect, it } from 'vitest';
import { getImageGenerationFields, listImageReactionsMany } from './image.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

// Pins the EXACT SQL. Parity with the Prisma read it replaced (row for row, key order included) is
// covered against a real database by
// src/server/services/__tests__/image-generation-data.kysely-parity.test.ts.
describe('image.db', () => {
  it('getImageGenerationFields reads one image with its tools and techniques in one statement', async () => {
    await getImageGenerationFields(harness.db, 42);
    expect(harness.queries).toHaveLength(1);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "Image"."hideMeta", "Image"."generationProcess", "Image"."meta", "Image"."type", ' +
        // Tools are ordered INSIDE the aggregate: json_agg does not promise a sorted subquery's order.
        '(select coalesce(json_agg(json_build_object(\'notes\', "ImageTool"."notes", \'tool\', ' +
        'json_build_object(\'id\', "Tool"."id", \'name\', "Tool"."name", \'icon\', "Tool"."icon", ' +
        '\'domain\', "Tool"."domain", \'priority\', "Tool"."priority")) ' +
        'order by "Tool"."priority" asc), \'[]\') as "tools" ' +
        'from "ImageTool" inner join "Tool" on "Tool"."id" = "ImageTool"."toolId" ' +
        'where "ImageTool"."imageId" = "Image"."id") as "tools", ' +
        "(select coalesce(json_agg(agg), '[]') from (" +
        'select "ImageTechnique"."notes", ' +
        'json_build_object(\'id\', "Technique"."id", \'name\', "Technique"."name") as "technique" ' +
        'from "ImageTechnique" inner join "Technique" on "Technique"."id" = "ImageTechnique"."techniqueId" ' +
        'where "ImageTechnique"."imageId" = "Image"."id"' +
        ') as agg) as "techniques" ' +
        'from "Image" where "Image"."id" = $1'
    );
    expect(parameters).toEqual([42]);
  });

  it('getImageGenerationFields returns null, as Prisma findUnique did, when no row matches', async () => {
    // DummyDriver resolves every statement to zero rows.
    expect(await getImageGenerationFields(harness.db, 42)).toBeNull();
  });

  // Parity with the Prisma `imageReaction.findMany` it replaces is pinned against a real database in
  // src/server/db/__tests__/kysely-prisma-parity.test.ts.
  it('listImageReactionsMany reads imageId + reaction for one user across the ids, unordered', async () => {
    await listImageReactionsMany(harness.db, { imageIds: [11, 22, 33], userId: 7 });
    expect(harness.queries).toHaveLength(1);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "imageId", "reaction" from "ImageReaction" ' +
        'where "imageId" in ($1, $2, $3) and "userId" = $4'
    );
    expect(parameters).toEqual([11, 22, 33, 7]);
  });

  it('listImageReactionsMany short-circuits an empty id list without touching the DB', async () => {
    expect(await listImageReactionsMany(harness.db, { imageIds: [], userId: 7 })).toEqual([]);
    expect(harness.queries).toHaveLength(0); // `in ([])` would compile to the syntax error `IN ()`
  });
});
