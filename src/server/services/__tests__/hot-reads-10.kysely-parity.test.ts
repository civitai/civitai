import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getCollectionByIdRow } from '@civitai/db-queries/hot-reads-10';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import {
  readCollectionByIdViaKysely,
  readCollectionByIdViaPrisma,
  type CollectionById,
} from '~/server/services/hot-reads-10.reads';

/**
 * Parity gate for the read behind `kysely-hot-reads-10`, the collection read. Both paths run
 * against the same rows in the same database and must return the same value, `toStrictEqual`, AND
 * the same JSON text (so key order, which reaches the response, matches too). The Prisma read has
 * no `orderBy` on any relation, so tags and cosmetics are compared sorted by key; the Kysely read's
 * own order is pinned by a literal control. The collection's tags are ALSO compared in order, on a
 * fixture inserted in "createdAt" order, because that order reaches the contest category dropdown.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_10_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_10_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles the Kysely read and pins the one
 * statement it issues and the relations it names.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_10_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_10_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-10-parity-schema.sql'));

// ONE connection, so the search_path set in beforeAll holds for every Prisma statement (see there).
const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
};

// Distinct ids per table, and none equal to a level, a size or another table's id.
const C_FULL = 10101; // a tagged cover, three tags, an owner with a picture and cosmetics
const C_BARE = 10102; // no cover, no tags, NULL optional columns, an owner with nothing
const C_DANGLING = 10103; // the cover id points at a deleted image, a deleted owner
const C_OTHER = 10104; // a cover with no tags, one tag, an owner with only unequipped cosmetics
const C_GONE = 10199; // no row

const U_FULL = 10201;
const U_BARE = 10202;
const U_DANGLING = 10203; // deleted, and the picture id points at a deleted image
const U_OTHER = 10204;

const IMG_COVER = 10301;
const IMG_PICTURE = 10302;
const IMG_PLAIN = 10303;
const IMG_GONE = 10398;
const IMG_GONE_2 = 10399;

const CO_BADGE = 10401;
const CO_PLATE = 10402;
const CO_DECORATION = 10403;

const T_LANDSCAPE = 10501;
const T_HILL = 10502;
const T_HIDDEN = 10503;
const T_CONTEST = 10504;
const T_OTHER = 10505;

const SCANNED_AT = new Date('2026-06-07T08:09:10.011Z');
const IMAGE_CREATED_AT = new Date('2026-07-08T09:10:11.012Z');
const PICTURE_CREATED_AT = new Date('2026-08-09T10:11:12.013Z');
const DELETED_AT = new Date('2026-03-04T05:06:07.008Z');
const OBTAINED_AT = new Date('2026-09-10T11:12:13.140Z');
const EQUIPPED_AT = new Date('2026-10-11T12:13:14.200Z');
const TAGGED_AT = new Date('2026-11-01T01:02:03.004Z');
const TAGGED_AT_2 = new Date('2026-11-02T02:03:04.005Z');
const TAGGED_AT_3 = new Date('2026-11-03T03:04:05.006Z');

const ts = (date: Date) => `'${date.toISOString().replace('T', ' ').replace('Z', '')}'`;

// Tag attribute bits, as the "TagsOnImageDetails" view decodes them.
const AUTOMATED = 1 << 11;
const DISABLED = 1 << 10;
const NEEDS_REVIEW = 1 << 9;

const byNumber = <T>(rows: T[], key: (row: T) => number) =>
  [...rows].sort((a, b) => key(a) - key(b));

/** The unordered relations sorted by key, with every other key left where it was. */
function sorted(collection: CollectionById | null) {
  if (!collection) return collection;
  return {
    ...collection,
    image: collection.image && {
      ...collection.image,
      tags: byNumber(collection.image.tags, (t) => t.tag.id),
    },
    tags: byNumber(collection.tags, (t) => t.tag.id),
    user: {
      ...collection.user,
      cosmetics: byNumber(collection.user.cosmetics, (c) => c.cosmetic.id),
    },
  };
}

describe.skipIf(!parityUrl)('hot reads 10: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({
    datasourceUrl: parityUrl && withSchema(parityUrl),
    log: [{ emit: 'event', level: 'query' }],
  });
  const prismaStatements: string[] = [];
  prisma.$on('query', (event) => {
    prismaStatements.push(event.query);
  });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => prisma.$executeRawUnsafe(statement);

  // A logged client on its own pool, for the statement count and the EXPLAIN below.
  const pool = new Pool({ connectionString: parityUrl });
  const kyselyStatements: CompiledQuery[] = [];
  const logged = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === 'query') kyselyStatements.push(event.query);
    },
  }).withSchema(SCHEMA);

  beforeAll(async () => {
    // Prisma's `?schema=` sets the session's search_path to that schema ALONE, which hides the
    // citext type's functions and operators (in "public"). Prisma's default schema is "public",
    // where the extension lives, so this puts "public" back on this session's path to match a
    // production URL that names no other schema.
    await exec(`SET search_path TO "${SCHEMA}", public`);
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('Collection')}
        (id, name, description, nsfw, "userId", "imageId", write, read, type, mode, metadata, availability, "nsfwLevel", "archivedAt")
      VALUES
        (${C_FULL}, 'Full collection', 'Every relation', true, ${U_FULL}, ${IMG_COVER}, 'Review', 'Public', 'Image', 'Contest', '{"endsAt":"2026-12-01","submissionLimit":3}', 'Unsearchable', 28, NULL),
        (${C_BARE}, 'Bare collection', NULL, NULL, ${U_BARE}, NULL, 'Private', 'Private', NULL, NULL, '{}', 'Public', 0, NULL),
        (${C_DANGLING}, 'Dangling collection', 'Gone cover', false, ${U_DANGLING}, ${IMG_GONE}, 'Public', 'Unlisted', 'Model', 'Bookmark', '{"note":"x"}', 'Private', 6, '2026-10-01 12:34:56.789'),
        (${C_OTHER}, 'Other collection', 'Untagged cover', false, ${U_OTHER}, ${IMG_PLAIN}, 'Private', 'Public', 'Post', NULL, '[]', 'EarlyAccess', 13, NULL)
    `);
    await exec(`
      INSERT INTO ${t('User')} (id, username, image, "deletedAt", "profilePictureId") VALUES
        (${U_FULL}, 'full-owner', 'https://img/full', NULL, ${IMG_PICTURE}),
        (${U_BARE}, 'bare-owner', NULL, NULL, NULL),
        (${U_DANGLING}, 'dangling-owner', 'https://img/dangling', ${ts(DELETED_AT)}, ${IMG_GONE_2}),
        (${U_OTHER}, NULL, NULL, NULL, NULL)
    `);
    await exec(`
      INSERT INTO ${t('Image')}
        (id, name, url, "userId", "createdAt", meta, hash, height, width, type, metadata, "nsfwLevel", "generationProcess", "postId", "needsReview", "hideMeta", "scannedAt", ingestion, "blockedFor")
      VALUES
        (${IMG_COVER}, 'cover.webm', 'cover-uuid', ${U_OTHER}, ${ts(
      IMAGE_CREATED_AT
    )}, '{"prompt":"a hill","steps":20}', 'coverhash', 1080, 1920, 'video', '{"duration":3}', 4, 'txt2img', 10601, 'minor', true, ${ts(
      SCANNED_AT
    )}, 'Blocked', 'csam-check'),
        (${IMG_PICTURE}, 'avatar.png', 'pic-uuid', ${U_FULL}, ${ts(
      PICTURE_CREATED_AT
    )}, NULL, 'pichash', 512, 384, 'image', '{"size":11}', 1, NULL, NULL, NULL, false, NULL, 'Scanned', NULL),
        (${IMG_PLAIN}, NULL, 'plain-uuid', ${U_OTHER}, ${ts(
      PICTURE_CREATED_AT
    )}, NULL, NULL, NULL, NULL, 'image', '{}', 2, NULL, NULL, NULL, false, NULL, 'Pending', NULL)
    `);
    await exec(`
      INSERT INTO ${t('Tag')} (id, name, type, "isCategory") VALUES
        (${T_LANDSCAPE}, 'landscape', 'Label', true),
        (${T_HILL}, 'Hill', 'UserGenerated', false),
        (${T_HIDDEN}, 'hidden', 'Moderation', false),
        (${T_CONTEST}, 'ContestEntry', 'System', true),
        (${T_OTHER}, 'other', 'UserGenerated', false)
    `);
    // Out of key order. The disabled tag is left out by both reads. The picture's tag is never read.
    await exec(`
      INSERT INTO ${t('TagsOnImageNew')} ("imageId", "tagId", attributes) VALUES
        (${IMG_COVER}, ${T_HILL}, ${NEEDS_REVIEW | 7}),
        (${IMG_COVER}, ${T_HIDDEN}, ${DISABLED | AUTOMATED}),
        (${IMG_COVER}, ${T_LANDSCAPE}, ${AUTOMATED | 5}),
        (${IMG_PICTURE}, ${T_OTHER}, 3)
    `);
    // Inserted (so stored on the heap) in "createdAt" order, which is not tag-id order: a NULL
    // "createdAt" first, then increasing distinct values. Both values of filterableOnly.
    await exec(`
      INSERT INTO ${t(
        'TagsOnCollection'
      )} ("collectionId", "tagId", "filterableOnly", "createdAt") VALUES
        (${C_FULL}, ${T_CONTEST}, true, NULL),
        (${C_FULL}, ${T_OTHER}, false, ${ts(TAGGED_AT)}),
        (${C_FULL}, ${T_LANDSCAPE}, false, ${ts(TAGGED_AT_2)}),
        (${C_OTHER}, ${T_HILL}, true, ${ts(TAGGED_AT_3)})
    `);
    await exec(`
      INSERT INTO ${t('Cosmetic')} (id, name, type, source, data) VALUES
        (${CO_BADGE}, 'Gold badge', 'Badge', 'Claim', '{"url":"b"}'),
        (${CO_PLATE}, 'Red plate', 'NamePlate', 'Event', '{"color":"red"}'),
        (${CO_DECORATION}, 'Lit decoration', 'ContentDecoration', 'Purchase', '{"url":"d","lights":3}')
    `);
    // Out of key order. Read: equipped and not equipped TO an entity. Left out: unequipped, equipped
    // to an entity, and another user's.
    await exec(`
      INSERT INTO ${t('UserCosmetic')}
        ("userId", "cosmeticId", "obtainedAt", "equippedAt", data, "claimKey", "equippedToId")
      VALUES
        (${U_FULL}, ${CO_PLATE}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, '{"lights":7}', 'claimed', NULL),
        (${U_FULL}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', 10701),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, ${ts(EQUIPPED_AT)}, NULL, 'claimed', NULL),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, NULL, '{"a":1}', 'second', NULL),
        (${U_OTHER}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, NULL, NULL, 'claimed', NULL),
        (${U_DANGLING}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', NULL)
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
    await logged.destroy();
  });

  it.each<[string, number]>([
    ['a tagged cover, three tags, an owner with a picture and cosmetics', C_FULL],
    ['no cover, no tags, NULL optional columns, an owner with nothing', C_BARE],
    ['a deleted cover, a deleted owner whose picture is gone', C_DANGLING],
    ['an untagged cover, one tag, an owner with no equipped cosmetic', C_OTHER],
    ['no such collection', C_GONE],
  ])('%s', async (_, id) => {
    const viaKysely = sorted(await readCollectionByIdViaKysely(kysely, id));
    const viaPrisma = sorted(await readCollectionByIdViaPrisma(prisma, id));
    expect(viaKysely).toStrictEqual(viaPrisma);
    // Key order too: the service spreads this object into the response.
    expect(JSON.stringify(viaKysely)).toBe(JSON.stringify(viaPrisma));
  });

  // ORDER-SENSITIVE, unlike the cases above: the collection's tags reach the contest category
  // dropdown in the order the read returns them. The Kysely read orders them by "createdAt" (NULLs
  // first), then tag id. Prisma's read has no orderBy and returns heap order, which on this fixture
  // is insertion order, so the two agree here; the literal pins the Kysely order against the
  // fixture's "createdAt" order directly, whatever Prisma's plan returns.
  it("the collection's tags come back in the order they were added, on both paths", async () => {
    const viaKysely = await readCollectionByIdViaKysely(kysely, C_FULL);
    const viaPrisma = await readCollectionByIdViaPrisma(prisma, C_FULL);
    const ADDED_ORDER = [T_CONTEST, T_OTHER, T_LANDSCAPE];
    // Control: the added order is not tag-id order, so a read ordered by id cannot pass.
    expect([...ADDED_ORDER].sort((a, b) => a - b)).not.toStrictEqual(ADDED_ORDER);
    expect(viaKysely?.tags.map((t) => t.tag.id)).toStrictEqual(ADDED_ORDER);
    expect(viaPrisma?.tags.map((t) => t.tag.id)).toStrictEqual(ADDED_ORDER);
    expect(viaKysely?.tags).toStrictEqual(viaPrisma?.tags);
    expect(JSON.stringify(viaKysely?.tags)).toBe(JSON.stringify(viaPrisma?.tags));
  });

  it("control: each branch reads the fixture expected, relations in the read's order", async () => {
    const full = await readCollectionByIdViaKysely(kysely, C_FULL);
    expect(full).not.toBeNull();
    if (!full) return;
    expect([full.read, full.write, full.type, full.mode, full.availability]).toStrictEqual([
      'Public',
      'Review',
      'Image',
      'Contest',
      'Unsearchable',
    ]);
    expect(full.metadata).toStrictEqual({ endsAt: '2026-12-01', submissionLimit: 3 });
    expect(full.image).toStrictEqual({
      id: IMG_COVER,
      name: 'cover.webm',
      url: 'cover-uuid',
      nsfwLevel: 4,
      width: 1920,
      height: 1080,
      hash: 'coverhash',
      meta: { prompt: 'a hill', steps: 20 },
      userId: U_OTHER,
      generationProcess: 'txt2img',
      needsReview: 'minor',
      scannedAt: SCANNED_AT,
      ingestion: 'Blocked',
      blockedFor: 'csam-check',
      postId: 10601,
      type: 'video',
      metadata: { duration: 3 },
      createdAt: IMAGE_CREATED_AT,
      hideMeta: true,
      tags: [
        {
          tag: { id: T_LANDSCAPE, name: 'landscape', isCategory: true, type: 'Label' },
          automated: true,
          needsReview: false,
        },
        {
          tag: { id: T_HILL, name: 'Hill', isCategory: false, type: 'UserGenerated' },
          automated: false,
          needsReview: true,
        },
      ],
    });
    // The collection's tags in the order they were added (see the case above).
    expect(full.tags).toStrictEqual([
      { tag: { id: T_CONTEST, name: 'ContestEntry' }, filterableOnly: true },
      { tag: { id: T_OTHER, name: 'other' }, filterableOnly: false },
      { tag: { id: T_LANDSCAPE, name: 'landscape' }, filterableOnly: false },
    ]);
    expect(full.user).toStrictEqual({
      id: U_FULL,
      username: 'full-owner',
      deletedAt: null,
      image: 'https://img/full',
      profilePicture: {
        id: IMG_PICTURE,
        name: 'avatar.png',
        url: 'pic-uuid',
        nsfwLevel: 1,
        hash: 'pichash',
        userId: U_FULL,
        ingestion: 'Scanned',
        type: 'image',
        width: 384,
        height: 512,
        metadata: { size: 11 },
      },
      cosmetics: [
        {
          data: null,
          cosmetic: {
            id: CO_BADGE,
            data: { url: 'b' },
            type: 'Badge',
            source: 'Claim',
            name: 'Gold badge',
          },
        },
        {
          data: { lights: 7 },
          cosmetic: {
            id: CO_PLATE,
            data: { color: 'red' },
            type: 'NamePlate',
            source: 'Event',
            name: 'Red plate',
          },
        },
      ],
    });

    const bare = await readCollectionByIdViaKysely(kysely, C_BARE);
    expect([bare?.description, bare?.nsfw, bare?.type, bare?.mode, bare?.image]).toStrictEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect([bare?.tags, bare?.user.cosmetics, bare?.user.profilePicture]).toStrictEqual([
      [],
      [],
      null,
    ]);

    const dangling = await readCollectionByIdViaKysely(kysely, C_DANGLING);
    expect(dangling?.image).toBeNull();
    expect(dangling?.user.profilePicture).toBeNull();
    expect(dangling?.user.deletedAt).toStrictEqual(DELETED_AT);
    expect(dangling?.user.cosmetics.map((c) => c.cosmetic.id)).toStrictEqual([CO_DECORATION]);

    const other = await readCollectionByIdViaKysely(kysely, C_OTHER);
    expect(other?.image?.tags).toStrictEqual([]);
    expect(other?.metadata).toStrictEqual([]);
    expect(other?.user.username).toBeNull();
    expect(other?.user.cosmetics).toStrictEqual([]);

    expect(await readCollectionByIdViaKysely(kysely, C_GONE)).toBeNull();
  });

  it('one statement where Prisma issues one per relation', async () => {
    prismaStatements.length = 0;
    await readCollectionByIdViaPrisma(prisma, C_FULL);
    kyselyStatements.length = 0;
    await readCollectionByIdViaKysely(logged, C_FULL);
    expect(kyselyStatements).toHaveLength(1);
    // Prisma's query events lag the awaited read (8 of 10 seen at once): wait for them, then count.
    await vi.waitFor(() => expect(prismaStatements.length).toBeGreaterThanOrEqual(10));
    await new Promise((done) => setTimeout(done, 50));
    // The collection, its cover image, the cover's tags and their tags, the collection's tags and
    // their tags, the owner, the owner's picture, and the owner's cosmetics and their cosmetics.
    expect(prismaStatements.length, prismaStatements.join('\n')).toBe(10);
  });

  // "TagsOnImageDetails" is a VIEW. It is a per-row projection (no GROUP BY, no UNION), so Postgres
  // flattens it and the image id reaches the scan of its base table.
  it("the tags view is read by the cover image's id, not computed whole", async () => {
    kyselyStatements.length = 0;
    await readCollectionByIdViaKysely(logged, C_FULL);
    const [statement] = kyselyStatements;
    const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${statement.sql}`, [
      ...statement.parameters,
    ]);
    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const keys = ['Index Cond', 'Filter', 'Recheck Cond', 'Hash Cond', 'Join Filter'];
    const scans = (node: PlanNode): string[] => [
      ...(node['Relation Name'] === 'TagsOnImageNew'
        ? [keys.map((key) => String(node[key] ?? '')).join(' ')]
        : []),
      ...(node.Plans ?? []).flatMap(scans),
    ];
    const conditions = scans((rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0].Plan);
    // Positive control: the cover image's tag read is in the plan.
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain('"CoverImage".id');
    expect(conditions[0]).toContain('imageId');
  });
});

// Offline: the statement is compiled, not run.

describe('hot reads 10: the one statement and the relations it reads', () => {
  it('control: the view list is read from the schema', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ImageTag', 'TagsOnImageDetails'])
      expect(views.has(known), known).toBe(true);
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it.each<[string, (db: never) => Promise<unknown>]>([
    ['the collection read', (db) => readCollectionByIdViaKysely(db, 1)],
    ['the row', (db) => getCollectionByIdRow(db, 1)],
  ])('%s', async (_, read) => {
    const relations = await compiledRelations(read);
    // An exact ledger: any extra relation or statement fails here.
    expect(relations).toEqual([
      [
        'Collection',
        'Cosmetic',
        'Image',
        'Image',
        'Tag',
        'Tag',
        'TagsOnCollection',
        'TagsOnImageDetails',
        'User',
        'UserCosmetic',
      ],
    ]);
    // The only `/// @view` relation: the tags projection view, whose base-table scan the EXPLAIN
    // above checks.
    const views = declaredViews();
    expect([...new Set(relations.flat().filter((r) => views.has(r)))].sort()).toEqual([
      'TagsOnImageDetails',
    ]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
