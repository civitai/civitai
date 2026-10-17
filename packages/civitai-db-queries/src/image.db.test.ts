import { beforeEach, describe, expect, it } from 'vitest';
import { getImageGenerationFields } from './image.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

// Pins the EXACT SQL. Behaviour parity with the Prisma read it replaced — the whole
// getImageGenerationData response, compared against the Prisma original over the same rows — is
// covered against a real database by
// src/server/services/__tests__/image-generation-data.kysely-parity.test.ts.
describe('image.db', () => {
  it('getImageGenerationFields reads one image with its tools and techniques in one statement', async () => {
    await getImageGenerationFields(harness.db, 42);
    expect(harness.queries).toHaveLength(1);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "Image"."hideMeta", "Image"."generationProcess", "Image"."meta", "Image"."type", ' +
        "(select coalesce(json_agg(agg), '[]') from (" +
        'select "ImageTool"."notes", ' +
        'json_build_object(\'id\', "Tool"."id", \'name\', "Tool"."name", \'icon\', "Tool"."icon", ' +
        '\'domain\', "Tool"."domain", \'priority\', "Tool"."priority") as "tool" ' +
        'from "ImageTool" inner join "Tool" on "Tool"."id" = "ImageTool"."toolId" ' +
        'where "ImageTool"."imageId" = "Image"."id" order by "Tool"."priority" asc' +
        ') as agg) as "tools", ' +
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
});
