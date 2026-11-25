import { describe, expect, test } from 'vitest';
import { bountyRefFromEvent } from '@/vector-sync/bounties/domain';
import { getBountyDocs } from '@/vector-sync/bounties/source';
import { collectionRefFromEvent } from '@/vector-sync/collections/domain';
import { getCollectionDocs } from '@/vector-sync/collections/source';

// Eligibility itself is pinned to the site's rules by the site's eligibility parity tests.
type Pg = Parameters<typeof getCollectionDocs>[0];

describe('collection payload, against the real query', () => {
  test('keeps public, rated, unblocked collections with an accepted item, of active owners, held or not', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp,
        "deletedAt" timestamp);
      CREATE TABLE "Collection" (id int PRIMARY KEY, name text, description text, type text,
        mode text, read text, availability text, "nsfwLevel" int, "userId" int, "imageId" int);
      CREATE TABLE "CollectionItem" (id int PRIMARY KEY, "collectionId" int, status text);
      CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int, details jsonb, images jsonb);
      INSERT INTO "CsamReport" VALUES (1, 9, '{}', '[]');
      INSERT INTO "User" VALUES (7, 'someone', NULL, NULL), (8, 'banned', now(), NULL),
        (9, 'held', NULL, NULL);
      INSERT INTO "Collection" VALUES
        (1, 'Neon  Cities', '<p>Bright <b>towers</b></p>', 'Image', NULL, 'Public', 'Public', 3, 7, 70),
        (2, 'Unlisted', NULL, 'Image', NULL, 'Unlisted', 'Public', 1, 7, NULL),
        (3, 'Empty', NULL, 'Image', NULL, 'Public', 'Public', 1, 7, NULL),
        (4, 'Unrated', NULL, 'Image', NULL, 'Public', 'Public', 0, 7, NULL),
        (5, 'Banned owner', NULL, 'Image', NULL, 'Public', 'Public', 1, 8, NULL),
        (6, 'Hidden', NULL, 'Image', NULL, 'Public', 'Unsearchable', 1, 7, NULL),
        (7, 'Blocked', NULL, 'Image', NULL, 'Public', 'Public', 33, 7, NULL),
        (8, 'Held owner', NULL, 'Image', NULL, 'Public', 'Public', 1, 9, NULL),
        (9, 'Only pending entries', NULL, 'Image', 'Contest', 'Public', 'Public', 1, 7, NULL);
      INSERT INTO "CollectionItem" VALUES (10, 1, 'ACCEPTED'), (11, 1, 'REJECTED'),
        (20, 2, 'ACCEPTED'), (40, 4, 'ACCEPTED'), (50, 5, 'ACCEPTED'), (60, 6, 'ACCEPTED'),
        (70, 7, 'ACCEPTED'), (80, 8, 'ACCEPTED'), (90, 9, 'REVIEW'), (91, 9, 'REJECTED');
    `);
    try {
      const docs = await getCollectionDocs(pg as unknown as Pg, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // 8's owner is held. A held owner does not hide the row.
      expect([...docs.keys()]).toEqual([1, 8]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'neon cities',
        type: 'Image',
        mode: null,
        nsfwLevel: [1, 2],
        userId: 7,
        username: 'someone',
      });
      // The point surfaces no image: the site picks a servable cover at hydration.
      expect(docs.get(1)).not.toHaveProperty('imageId');
      expect(docs.get(1)?.search_text).toBe(
        'Name: Neon Cities\nCreator: someone\nType: Image\nDescription: Bright towers'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('bounty payload, against the real query', () => {
  test('keeps visible, rated, unblocked, non-poi bounties of active owners, held or not, with their feed fields', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    // event-engine's node10 resolution can't see pglite's exports map, so the subpath is untyped.
    const citextPath = '@electric-sql/pglite/contrib/citext';
    const { citext } = (await import(citextPath)) as {
      citext: import('@electric-sql/pglite').Extension;
    };
    // Tag.name is citext in prod; node-pg-style clients return a citext[] unparsed.
    const pg = new PGlite({ extensions: { citext } });
    await pg.exec(`
      CREATE EXTENSION citext;
      CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp,
        "deletedAt" timestamp);
      CREATE TABLE "Bounty" (id int PRIMARY KEY, name text, description text, type text, mode text,
        "entryMode" text, details jsonb, "nsfwLevel" int, "startsAt" date, "expiresAt" date,
        complete boolean, refunded boolean, poi boolean, availability text, "userId" int,
        nsfw boolean DEFAULT false);
      CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int);
      CREATE TABLE "Tag" (id int PRIMARY KEY, name citext);
      CREATE TABLE "TagsOnBounty" ("bountyId" int, "tagId" int);
      CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int, details jsonb, images jsonb);
      INSERT INTO "CsamReport" VALUES (1, 9, '{}', '[]');
      INSERT INTO "User" VALUES (7, 'someone', NULL, NULL), (8, 'banned', now(), NULL),
        (9, 'held', NULL, NULL);
      INSERT INTO "Tag" VALUES (1, 'style'), (2, 'anime');
      INSERT INTO "Bounty" VALUES
        (1, 'Anime  LoRA', '<p>Need a <b>style</b></p>', 'LoraCreation', 'Split', 'Open',
          '{"baseModel": "SDXL 1.0"}', 1, '2026-11-01', '2026-11-30', false, false, false, 'Public', 7),
        (2, 'Private', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, false, 'Private', 7),
        (3, 'Poi', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, true, 'Public', 7),
        (4, 'Unrated', '', 'Other', 'Individual', 'Open', NULL, 0, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', 7),
        (5, 'Banned owner', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', 8),
        (6, 'No owner', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', NULL),
        (7, 'Blocked', '', 'Other', 'Individual', 'Open', NULL, 33, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', 7),
        (8, 'Held owner', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', 9),
        (9, 'Marked nsfw', '', 'Other', 'Individual', 'Open', NULL, 1, '2026-11-01', '2026-11-30',
          false, false, false, 'Public', 7);
      UPDATE "Bounty" SET nsfw = true WHERE id = 9;
      INSERT INTO "TagsOnBounty" VALUES (1, 1), (1, 2);
      INSERT INTO "BountyEntry" VALUES (100, 1);
    `);
    try {
      const docs = await getBountyDocs(pg as unknown as Pg, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // 8's owner is held. A held owner does not hide the row.
      expect([...docs.keys()]).toEqual([1, 8, 9]);
      // The feed serves a bounty marked nsfw at XXX, whatever its rated level.
      expect(docs.get(9)?.nsfwLevel).toEqual([16]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'anime lora',
        type: 'LoraCreation',
        mode: 'Split',
        entryMode: 'Open',
        baseModel: 'SDXL 1.0',
        nsfwLevel: [1],
        startsAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2026-11-30T00:00:00.000Z',
        complete: false,
        refunded: false,
        hasEntries: true,
        userId: 7,
      });
      expect(docs.get(1)?.search_text).toBe(
        'Name: Anime LoRA\nCreator: someone\nType: LoraCreation\nBase model: SDXL 1.0\n' +
          'Tags: anime, style\nDescription: Need a style'
      );
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('change signals', () => {
  test('a collection change or delete names the collection; a snapshot read does not', () => {
    expect(collectionRefFromEvent('postgres.Collection', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      collectionRefFromEvent('postgres.Collection', { op: 'd', before: { id: 4 }, after: null })
    ).toEqual({ id: 4 });
    expect(collectionRefFromEvent('postgres.Collection', { op: 'r', after: { id: 5 } })).toBeNull();
  });

  test('a bounty, its tag or its entry names the bounty', () => {
    expect(bountyRefFromEvent('postgres.Bounty', { op: 'u', after: { id: 3 } })).toEqual({ id: 3 });
    expect(
      bountyRefFromEvent('postgres.TagsOnBounty', {
        op: 'd',
        before: { bountyId: 4, tagId: 1 },
        after: null,
      })
    ).toEqual({ id: 4 });
    expect(
      bountyRefFromEvent('postgres.BountyEntry', { op: 'c', after: { id: 100, bountyId: 6 } })
    ).toEqual({ id: 6 });
    // A key-only entry delete carries no bountyId: the refresh walk covers it.
    expect(
      bountyRefFromEvent('postgres.BountyEntry', { op: 'd', before: { id: 100 }, after: null })
    ).toBeNull();
    expect(bountyRefFromEvent('postgres.Bounty', { op: 'r', after: { id: 5 } })).toBeNull();
  });
});
