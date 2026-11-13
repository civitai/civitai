import { describe, expect, test } from 'vitest';
import { crucibleDomain, crucibleRefFromEvent } from '@/vector-sync/crucibles/domain';
import { getCrucibleDocs } from '@/vector-sync/crucibles/source';

// Eligibility itself is pinned to the site's rule by the site's crucible-eligibility parity test.
describe('crucible payload, against the real query', () => {
  test('carries the fields the site filters on, both levels as bits', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "CrucibleStatus" AS ENUM ('Pending', 'Active', 'Completed', 'Cancelled');
      CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
      CREATE TABLE "User" (id int PRIMARY KEY, username text);
      CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int, ingestion text);
      CREATE TABLE "Crucible" (id int PRIMARY KEY, name text, description text,
        status "CrucibleStatus", "contentType" "MediaType", "nsfwLevel" int, "textNsfw" boolean,
        "buzzType" text, "userId" int, "imageId" int, ingestion text, "takenDownAt" timestamp);
      INSERT INTO "User" VALUES (7, 'someone');
      INSERT INTO "Image" VALUES (70, 6, 'Scanned'), (80, 1, 'Scanned');
      INSERT INTO "Crucible" VALUES
        (1, 'Neon  Arena', '<p>Bright <b>duels</b></p>', 'Active', 'video', 3, true, 'green', 7,
          70, 'Scanned', NULL),
        (2, 'Gone', NULL, 'Completed', 'image', 1, false, 'yellow', 7, 80, 'Scanned', now());
    `);
    try {
      const docs = await getCrucibleDocs(
        pg as unknown as Parameters<typeof getCrucibleDocs>[0],
        [1, 2]
      );
      // A taken-down crucible gets no point.
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'neon arena',
        name: 'Neon  Arena',
        status: 'Active',
        contentType: 'video',
        nsfwLevel: [1, 2],
        coverNsfwLevel: [2, 4],
        textNsfw: true,
        buzzType: 'green',
        userId: 7,
        username: 'someone',
        imageId: 70,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Name: Neon Arena\nCreator: someone\nDescription: Bright duels'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('crucible change signals', () => {
  test('a crucible change or delete names the crucible; a snapshot read does not', () => {
    expect(crucibleRefFromEvent('postgres.Crucible', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      crucibleRefFromEvent('postgres.Crucible', { op: 'd', before: { id: 4 }, after: null })
    ).toEqual({ id: 4 });
    expect(crucibleRefFromEvent('postgres.Crucible', { op: 'r', after: { id: 5 } })).toBeNull();
  });
});

describe('crucible embedding switch', () => {
  test('stays off until VECTOR_CRUCIBLE_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_CRUCIBLE_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_CRUCIBLE_EMBED_ENABLED;
      expect(domainEmbedEnabled(crucibleDomain.name, crucibleDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_CRUCIBLE_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(crucibleDomain.name, crucibleDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_CRUCIBLE_EMBED_ENABLED;
      else process.env.VECTOR_CRUCIBLE_EMBED_ENABLED = own;
    }
  });
});
