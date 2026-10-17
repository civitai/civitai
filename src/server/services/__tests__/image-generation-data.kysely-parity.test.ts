import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getImageGenerationFields } from '@civitai/db-queries/image';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';

/**
 * Parity gate for the port of `getImageGenerationData`'s image read from Prisma to Kysely.
 *
 * The read takes only the image id, and everything `getImageGenerationData` does after it is a pure
 * function of the row it returns. So parity of the ROW is parity of the response: this suite runs
 * `getImageGenerationFields` and the Prisma `image.findUnique` it replaced (copied verbatim below)
 * over the same rows in the same database, and compares each pair twice. `toStrictEqual` catches
 * `undefined` vs a missing key. Serialized JSON catches key ORDER, which `toEqual` ignores and the
 * caller's spread carries into the payload.
 *
 * That the service passes `kyselyRead` (not the writer) is pinned in CI by
 * image-generation-data-visibility.behavior.test.ts. This suite only needs a client on the parity DB.
 *
 * Opt-in via `KYSELY_PARITY_DATABASE_URL`, which must point at a THROWAWAY database: the suite
 * drops and recreates its tables. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 *   docker run -d --rm --name pg-parity -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=parity \
 *     -p 54329:5432 postgres:17
 *   KYSELY_PARITY_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/parity \
 *     pnpm vitest run --project unit src/server/services/__tests__/image-generation-data.kysely-parity.test.ts
 */
const parityUrl = process.env.KYSELY_PARITY_DATABASE_URL;

const schemaStatements = loadParitySchema(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/image-generation-data-parity-schema.sql'
  )
);

/** The Prisma read the port replaced, VERBATIM from image.service.ts before the port. */
const viaPrisma = (prisma: PrismaClient, id: number) =>
  prisma.image.findUnique({
    where: { id },
    select: {
      hideMeta: true,
      generationProcess: true,
      meta: true,
      type: true,
      tools: {
        orderBy: { tool: { priority: 'asc' } },
        select: {
          notes: true,
          tool: {
            select: {
              id: true,
              name: true,
              icon: true,
              domain: true,
              priority: true,
            },
          },
        },
      },
      techniques: {
        select: {
          notes: true,
          technique: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

type Row = Awaited<ReturnType<typeof viaPrisma>>;

/** Every image row the comparison runs, labelled by what that row varies. */
const IMAGES: Array<[label: string, id: number]> = [
  ['with meta, ordered tools (one disabled, one null priority) and techniques', 1],
  ['with no meta, tools or techniques (a video)', 2],
  ['with hidden meta', 3],
  ['whose meta is not an object', 4],
  ['with an on-site comfy graph', 5],
  ['with media links in its meta (inpainting)', 6],
  ['whose meta records a source image', 7],
  ['whose tool and technique both carry notes', 8],
  ['with one tool and a technique without notes', 9],
  ['with one tool and no techniques', 10],
  ['with only a disabled tool, plus a technique', 11],
  ['whose meta is a JSON null (audio)', 12],
  ['with an engine-recorded process', 13],
  ['that does not exist', 999],
];

describe.skipIf(!parityUrl)('getImageGenerationFields returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl });
  const { db: kysely } = createKyselyClients<DB>({
    connectionString: parityUrl,
    singleClient: true,
  });

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    // Two precision probes are spliced in as raw JSON text: a 64-bit seed past 2^53 and a decimal
    // with a trailing zero, which a JS literal could not carry into the row unchanged.
    const json = (value: unknown) =>
      `'${JSON.stringify(value)
        .replace('"__BIG_SEED__"', '18446744073709551615')
        .replace('"__DECIMAL__"', '0.50')
        .replace(/'/g, "''")}'::jsonb`;
    const RICH_META = {
      prompt: 'a lighthouse at dusk, “quoted”, ünïcødé',
      negativePrompt: 'blurry',
      cfgScale: 7,
      steps: 30,
      seed: 3141592653,
      bigSeed: '__BIG_SEED__',
      denoise: '__DECIMAL__',
      'Clip skip': 2,
      external: { source: { name: 'Tool', homepage: 'https://tool.example' } },
      extra: { remixOfId: 77, nested: [1, [2, { three: null }]] },
    };

    await prisma.$executeRawUnsafe(`
      INSERT INTO "Image" (id, meta, type, "nsfwLevel", "generationProcess", "needsReview", "hideMeta") VALUES
        (1, ${json(RICH_META)}, 'image', 1, 'txt2imgHiRes', NULL, false),
        (2, NULL, 'video', 2, 'img2img', NULL, false),
        (3, ${json(RICH_META)}, 'image', 1, 'txt2img', NULL, true),
        (4, ${json([1, 'two', { three: 3 }])}, 'image', 1, NULL, NULL, false),
        (5, ${json({
          prompt: 'comfy',
          comfy: '{"prompt":{}}',
          civitaiResources: [],
        })}, 'image', 1, NULL, NULL, false),
        (6, ${json({
          prompt: 'media',
          images: [{ url: 'https://image.example/a.png' }],
        })}, 'image', 4, 'inpainting', NULL, false),
        (7, ${json({
          prompt: 'an edit',
          extra: { sourceImageIds: [8] },
        })}, 'image', 1, 'img2img', NULL, false),
        (8, ${json({ prompt: 'the source' })}, 'image', 4, NULL, NULL, false),
        (9, ${json({ prompt: 'under review' })}, 'image', 1, NULL, 'minor', false),
        (10, ${json({ prompt: 'blocked' })}, 'image', 32, NULL, NULL, false),
        (11, ${json({ prompt: 'postless' })}, 'image', 1, NULL, NULL, false),
        (12, 'null'::jsonb, 'audio', 1, 'txt2img', NULL, false),
        (13, ${json({
          prompt: 'a clip',
          engine: 'veo3',
          type: 'txt2vid',
        })}, 'video', 1, NULL, NULL, false),
        (14, ${json({ prompt: 'ties' })}, 'image', 1, NULL, NULL, false),
        (15, '{"seed": 1e400}'::jsonb, 'image', 1, NULL, NULL, false)
    `);
    // Distinct priorities on image 1, with a single null that sorts last, so its tool order is fully
    // determined on both paths. Inserted out of order, so a lost ORDER BY shows. One tool is
    // disabled and unlisted, which neither path filters.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Tool" (id, name, icon, domain, priority, type, enabled, unlisted) VALUES
        (1, 'Alpha', 'alpha.png', 'alpha.example', 3, 'Image', true, false),
        (2, 'Bravo', NULL, NULL, 1, 'Image', true, false),
        (3, 'Charlie', 'charlie.png', NULL, NULL, 'Video', true, false),
        (4, 'Delta (retired)', NULL, 'delta.example', 2, 'Editor', false, true),
        (5, 'Echo', NULL, NULL, 5, 'Image', true, false),
        (6, 'Foxtrot', NULL, NULL, 5, 'Image', true, false),
        (7, 'Golf', NULL, NULL, NULL, 'Image', true, false)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Technique" (id, name, type, enabled) VALUES
        (1, 'txt2img', 'Image', true), (2, 'inpainting', 'Image', true), (3, 'retired', 'Video', false)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImageTool" ("imageId", "toolId", notes) VALUES
        (1, 3, 'last: null priority'), (1, 1, NULL), (1, 4, 'disabled tool'), (1, 2, 'first'),
        (5, 1, NULL), (6, 2, 'r-rated'), (7, 3, NULL), (8, 1, 'source image tool'),
        (9, 2, 'review'), (10, 1, 'blocked'), (11, 4, NULL),
        (14, 6, 'tie a'), (14, 5, 'tie b'), (14, 7, 'null a'), (14, 3, 'null b'), (14, 2, 'first')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImageTechnique" ("imageId", "techniqueId", notes) VALUES
        (1, 2, 'masked'), (1, 3, NULL), (5, 1, NULL), (6, 2, 'r-rated'), (8, 1, 'source'),
        (9, 1, NULL), (11, 2, 'postless')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await kysely.destroy();
  });

  // Techniques have no ORDER BY on either path (as in the source), so their order is not part of
  // the contract. Everything else, key order included, is compared as returned.
  const withSortedTechniques = (row: Row): Row =>
    row && {
      ...row,
      techniques: [...row.techniques].sort((a, b) => a.technique.id - b.technique.id),
    };

  async function bothReads(id: number) {
    const [kyselyRow, prismaRow] = await Promise.all([
      getImageGenerationFields(kysely, id),
      viaPrisma(prisma, id),
    ]);
    return { kyselyRow, prismaRow };
  }

  it.each(IMAGES)('an image %s: the row matches Prisma, key order included', async (_label, id) => {
    const { kyselyRow, prismaRow } = await bothReads(id);
    const [k, p] = [withSortedTechniques(kyselyRow as Row), withSortedTechniques(prismaRow)];
    expect(k).toStrictEqual(p);
    expect(JSON.stringify(k)).toBe(JSON.stringify(p));
    if (id === 999) expect(kyselyRow).toBeNull();
    else expect(kyselyRow).not.toBeNull();
  });

  // Positive controls: the comparison above compares like with like, so it would also pass if both
  // sides lost the same data. These pin that the rows carry what is under test.
  it('carries the rich image ordered by priority, nulls last, with its notes and precision probes', async () => {
    const { kyselyRow } = await bothReads(1);
    expect(kyselyRow?.tools).toStrictEqual([
      {
        notes: 'first',
        tool: { id: 2, name: 'Bravo', icon: null, domain: null, priority: 1 },
      },
      {
        notes: 'disabled tool',
        tool: { id: 4, name: 'Delta (retired)', icon: null, domain: 'delta.example', priority: 2 },
      },
      {
        notes: null,
        tool: { id: 1, name: 'Alpha', icon: 'alpha.png', domain: 'alpha.example', priority: 3 },
      },
      {
        notes: 'last: null priority',
        tool: { id: 3, name: 'Charlie', icon: 'charlie.png', domain: null, priority: null },
      },
    ]);
    expect(kyselyRow?.techniques.map((t) => t.technique.id).sort()).toEqual([2, 3]);
    expect(kyselyRow?.hideMeta).toBe(false);
    expect(kyselyRow?.generationProcess).toBe('txt2imgHiRes');
    const meta = kyselyRow?.meta as Record<string, unknown>;
    expect(meta.bigSeed).toBe(2 ** 64); // what 18446744073709551615 parses to as a double
    expect(meta.denoise).toBe(0.5);
    expect((await bothReads(3)).kyselyRow?.hideMeta).toBe(true);
    expect((await bothReads(2)).kyselyRow?.type).toBe('video');
  });

  // Ties in `Tool.priority` (including several nulls) have no defined order on either path — the
  // Prisma query orders by priority alone — so for those the order WITHIN a tie is compared as a
  // set, and the order BETWEEN priority groups exactly.
  it('orders tied tools between priority groups exactly, and within a tie as a set', async () => {
    const { kyselyRow, prismaRow } = await bothReads(14);
    const groups = (row: Row) =>
      (row?.tools ?? []).reduce<Array<{ priority: number | null; ids: number[] }>>(
        (acc, { tool }) => {
          const last = acc[acc.length - 1];
          if (last && last.priority === tool.priority) last.ids.push(tool.id);
          else acc.push({ priority: tool.priority, ids: [tool.id] });
          return acc;
        },
        []
      );
    const normalise = (row: Row) =>
      groups(row).map((g) => ({ ...g, ids: [...g.ids].sort((a, b) => a - b) }));
    expect(normalise(kyselyRow as Row)).toStrictEqual([
      { priority: 1, ids: [2] },
      { priority: 5, ids: [5, 6] },
      { priority: null, ids: [3, 7] },
    ]);
    expect(normalise(kyselyRow as Row)).toStrictEqual(normalise(prismaRow));
    const byTool = (row: Row) => [...(row?.tools ?? [])].sort((a, b) => a.tool.id - b.tool.id);
    expect(byTool(kyselyRow as Row)).toStrictEqual(byTool(prismaRow));
  });

  // The one KNOWN divergence at the row. A stored meta number outside double range made Prisma's
  // engine throw (the request failed). node-postgres's JSON.parse reads it as Infinity instead.
  // What the endpoint then does with it is pinned in image-generation-data-visibility.behavior.test.ts:
  // in a schema-typed field such as `seed`, the meta fails to parse and the whole meta is dropped
  // (`meta` undefined, `canRemix` false). In an untyped key, Infinity passes through to the response.
  it('reads a meta number outside double range as Infinity, where Prisma threw', async () => {
    await expect(viaPrisma(prisma, 15)).rejects.toThrow(/number out of range/);
    const row = await getImageGenerationFields(kysely, 15);
    expect((row?.meta as { seed: number }).seed).toBe(Infinity);
  });
});
