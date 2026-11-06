import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getUserWithProfileRow } from '@civitai/db-queries/hot-reads-9';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import {
  readUserWithProfileViaKysely,
  readUserWithProfileViaPrisma,
  type UserWithProfile,
  type UserWithProfileWhere,
} from '~/server/services/hot-reads-9.reads';

/**
 * Parity gate for the read behind `kysely-hot-reads-9`, the user profile read. Both paths run
 * against the same rows in the same database and must return the same value, `toStrictEqual`, AND
 * the same JSON text (so key order, which reaches the response, matches too). The Prisma read has
 * no `orderBy` on any relation, so links, cosmetics and tags are compared sorted by key; the Kysely
 * read's own order (key order) is pinned by a literal control.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_9_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_9_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles the Kysely read and pins the one
 * statement it issues and the relations it names.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_9_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_9_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-9-parity-schema.sql'));

// ONE connection, so the search_path set in beforeAll holds for every Prisma statement (see there).
const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
};

// Distinct ids per table, and none equal to a level, a size, a rank or another table's id.
const U_FULL = 9101; // every relation, two cover images
const U_BARE = 9102; // no profile, picture, links, cosmetics or rank, NULL JSON columns
const U_DELETED = 9103; // deleted: not found
const U_DANGLING = 9104; // picture and cover ids point at deleted images, an all-NULL rank row
const U_OTHER = 9105; // owns cosmetics and links of its own, so a missing user filter shows
const U_GONE = 9199; // no row

const IMG_PICTURE = 9201;
const IMG_COVER = 9202;
const IMG_SFW_COVER = 9203;
const IMG_GONE = 9298;
const IMG_GONE_2 = 9299;

const L_SOCIAL = 9301;
const L_SPONSOR = 9302;
const L_OTHER = 9303;
const L_OTHER_USER = 9304;

const CO_BADGE = 9401;
const CO_PLATE = 9402;
const CO_DECORATION = 9403;

const T_LABEL = 9501;
const T_REVIEW = 9502;
const T_DISABLED = 9503;
const T_SFW = 9504;

const CREATED_AT = new Date('2026-01-02T03:04:05.006Z');
const BANNED_AT = new Date('2026-02-03T04:05:06.007Z');
const DELETED_AT = new Date('2026-03-04T05:06:07.008Z');
const MESSAGE_AT = new Date('2026-04-05T06:07:08.009Z');
const SFW_MESSAGE_AT = new Date('2026-05-06T07:08:09.010Z');
const SCANNED_AT = new Date('2026-06-07T08:09:10.011Z');
const IMAGE_CREATED_AT = new Date('2026-07-08T09:10:11.012Z');
const OBTAINED_AT = new Date('2026-08-09T10:11:12.013Z');
const OBTAINED_AT_2 = new Date('2026-09-10T11:12:13.140Z');
const EQUIPPED_AT = new Date('2026-10-11T12:13:14.200Z');

const ts = (date: Date) => `'${date.toISOString().replace('T', ' ').replace('Z', '')}'`;

// Tag attribute bits, as the "TagsOnImageDetails" view decodes them.
const AUTOMATED = 1 << 11;
const DISABLED = 1 << 10;
const NEEDS_REVIEW = 1 << 9;

const byNumber = <T>(rows: T[], key: (row: T) => number) =>
  [...rows].sort((a, b) => key(a) - key(b));

type Image = { tags: { tag: { id: number } }[] } | null;
const sortedImage = <T extends Image>(image: T) =>
  image && { ...image, tags: byNumber(image.tags, (t) => t.tag.id) };

/** The unordered relations sorted by key, with every other key left where it was. */
function sorted(user: UserWithProfile) {
  return {
    ...user,
    cosmetics: [...user.cosmetics].sort(
      (a, b) => a.cosmeticId - b.cosmeticId || a.claimKey.localeCompare(b.claimKey)
    ),
    links: byNumber(user.links, (l) => l.id),
    profile: user.profile && {
      ...user.profile,
      coverImage: sortedImage(user.profile.coverImage),
      sfwCoverImage: sortedImage(user.profile.sfwCoverImage),
    },
  };
}

describe.skipIf(!parityUrl)('hot reads 9: Kysely returns exactly what Prisma returned', () => {
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
    // citext operators (in "public"), so `"username" = $1` would compare as text, case-sensitively.
    // Prisma's default schema is "public", where the extension lives, so this puts "public" back on
    // this session's path to match a production URL that names no other schema (this suite cannot
    // check the production URL). The mixed-case case below checks the setting took.
    await exec(`SET search_path TO "${SCHEMA}", public`);
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('User')}
        (id, username, image, "createdAt", "deletedAt", muted, "bannedAt", meta, "leaderboardShowcase", "profilePictureId", settings, "publicSettings")
      VALUES
        (${U_FULL}, 'full-profile', 'https://img/full', ${ts(
      CREATED_AT
    )}, NULL, false, NULL, '{"scores":{"a":1}}', 'overall', ${IMG_PICTURE}, '{"creatorShop":{"enabled":true}}', '{"p":2}'),
        (${U_BARE}, 'bare-profile', NULL, ${ts(
      CREATED_AT
    )}, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL),
        (${U_DELETED}, 'deleted-profile', NULL, ${ts(CREATED_AT)}, ${ts(
      DELETED_AT
    )}, false, NULL, '{}', NULL, NULL, '{}', '{}'),
        (${U_DANGLING}, 'dangling-profile', 'https://img/dangling', ${ts(
      CREATED_AT
    )}, NULL, true, ${ts(BANNED_AT)}, '{}', 'flux', ${IMG_GONE}, '{"hideStickerBook":true}', '{}'),
        (${U_OTHER}, 'other-profile', NULL, ${ts(
      CREATED_AT
    )}, NULL, false, NULL, '{}', NULL, NULL, '{}', '{}')
    `);
    await exec(`
      INSERT INTO ${t('Image')}
        (id, name, url, "userId", "createdAt", meta, hash, height, width, type, metadata, "nsfwLevel", "generationProcess", "postId", "needsReview", "hideMeta", "scannedAt", ingestion, "blockedFor")
      VALUES
        (${IMG_PICTURE}, 'avatar.png', 'pic-uuid', ${U_FULL}, ${ts(
      IMAGE_CREATED_AT
    )}, NULL, 'pichash', 512, 384, 'image', '{"size":11}', 1, NULL, NULL, NULL, false, ${ts(
      SCANNED_AT
    )}, 'Scanned', NULL),
        (${IMG_COVER}, 'cover.webm', 'cover-uuid', ${U_FULL}, ${ts(
      IMAGE_CREATED_AT
    )}, '{"prompt":"a hill","steps":20}', 'coverhash', 1080, 1920, 'video', '{"duration":3}', 4, 'txt2img', 9601, 'minor', true, ${ts(
      SCANNED_AT
    )}, 'Blocked', 'csam-check'),
        (${IMG_SFW_COVER}, NULL, 'sfw-cover-uuid', ${U_OTHER}, ${ts(
      IMAGE_CREATED_AT
    )}, NULL, NULL, NULL, NULL, 'image', '{}', 2, NULL, NULL, NULL, false, NULL, 'Pending', NULL)
    `);
    await exec(`
      INSERT INTO ${t('UserRank')} VALUES
        (${U_FULL}, 7, 'overall', 'Top creator', 'gold-frame'),
        (${U_DANGLING}, NULL, NULL, NULL, NULL)
    `);
    await exec(`
      INSERT INTO ${t('UserProfile')}
        ("userId", "coverImageId", bio, message, "messageAddedAt", "sfwCoverImageId", "sfwBio", "sfwMessage", "sfwMessageAddedAt", location, nsfw, "privacySettings", "profileSectionsSettings", "showcaseItems")
      VALUES
        (${U_FULL}, ${IMG_COVER}, 'Full bio', 'Hello', ${ts(
      MESSAGE_AT
    )}, ${IMG_SFW_COVER}, 'Safe bio', 'Safe hello', ${ts(
      SFW_MESSAGE_AT
    )}, 'Lisbon', true, '{"showFollowerCount":false}', '[{"key":"showcase","enabled":true}]', '[{"entityType":"Model","entityId":11}]'),
        (${U_DANGLING}, ${IMG_GONE_2}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, '{}', '[]', '[]')
    `);
    // Out of id order on purpose.
    await exec(`
      INSERT INTO ${t('UserLink')} (id, "userId", url, type) VALUES
        (${L_OTHER}, ${U_FULL}, 'https://other.example', 'Other'),
        (${L_SOCIAL}, ${U_FULL}, 'https://social.example', 'Social'),
        (${L_OTHER_USER}, ${U_OTHER}, 'https://not-yours.example', 'Social'),
        (${L_SPONSOR}, ${U_FULL}, 'https://sponsor.example', 'Sponsorship')
    `);
    await exec(`
      INSERT INTO ${t('Cosmetic')} (id, name, description, "videoUrl", type, source, data) VALUES
        (${CO_BADGE}, 'Badge', NULL, NULL, 'Badge', 'Claim', '{"url":"b"}'),
        (${CO_PLATE}, 'Plate', 'Plain', 'https://video/plate', 'NamePlate', 'Event', '{"color":"red"}'),
        (${CO_DECORATION}, 'Decoration', 'Lit', NULL, 'ContentDecoration', 'Purchase', '{"url":"d","lights":3}')
    `);
    // Out of primary-key order, two claims of one cosmetic, one equipped, one equipped TO an entity.
    await exec(`
      INSERT INTO ${t('UserCosmetic')}
        ("userId", "cosmeticId", "obtainedAt", "equippedAt", data, "claimKey", "equippedToId")
      VALUES
        (${U_FULL}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, '{"lights":7}', 'claimed', 9701),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT_2)}, NULL, '{"a":1}', 'second', NULL),
        (${U_FULL}, ${CO_PLATE}, ${ts(OBTAINED_AT)}, ${ts(EQUIPPED_AT)}, NULL, 'claimed', NULL),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, NULL, NULL, 'claimed', NULL),
        (${U_OTHER}, ${CO_PLATE}, ${ts(OBTAINED_AT_2)}, NULL, NULL, 'claimed', NULL)
    `);
    await exec(`
      INSERT INTO ${t('Tag')} (id, name, type, "isCategory") VALUES
        (${T_LABEL}, 'landscape', 'Label', true),
        (${T_REVIEW}, 'hill', 'UserGenerated', false),
        (${T_DISABLED}, 'hidden', 'Moderation', false),
        (${T_SFW}, 'meadow', 'System', true)
    `);
    // Out of key order. The disabled tag is left out by both reads.
    await exec(`
      INSERT INTO ${t('TagsOnImageNew')} ("imageId", "tagId", attributes) VALUES
        (${IMG_COVER}, ${T_REVIEW}, ${NEEDS_REVIEW | 7}),
        (${IMG_COVER}, ${T_DISABLED}, ${DISABLED | AUTOMATED}),
        (${IMG_COVER}, ${T_LABEL}, ${AUTOMATED | 5}),
        (${IMG_SFW_COVER}, ${T_SFW}, ${AUTOMATED | NEEDS_REVIEW}),
        (${IMG_PICTURE}, ${T_LABEL}, 3)
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
    await logged.destroy();
  });

  const found: [string, UserWithProfileWhere][] = [
    ['every relation, by id', { id: U_FULL }],
    ['every relation, by username', { username: 'full-profile' }],
    ['every relation, by id and username', { id: U_FULL, username: 'full-profile' }],
    ['no relation at all, NULL JSON columns', { id: U_BARE }],
    ['a deleted picture and cover, an all-NULL rank, banned and muted', { id: U_DANGLING }],
    ['cosmetics and a link but no profile, by username', { username: 'other-profile' }],
  ];

  it.each(found)('%s', async (_, where) => {
    const viaKysely = sorted(await readUserWithProfileViaKysely(kysely, where));
    const viaPrisma = sorted(await readUserWithProfileViaPrisma(prisma, where));
    expect(viaKysely).toStrictEqual(viaPrisma);
    // Key order too: the service spreads this object into the response.
    expect(JSON.stringify(viaKysely)).toBe(JSON.stringify(viaPrisma));
  });

  // "username" is CITEXT: a lookup that differs from the stored name only in case finds the user,
  // on both paths. A path whose comparison were case-sensitive would reject with P2025 here.
  it('a mixed-case username finds the lowercase-stored user on both paths', async () => {
    const [{ search_path: prismaPath }] = await prisma.$queryRawUnsafe<{ search_path: string }[]>(
      'SHOW search_path'
    );
    expect(prismaPath).toContain('public');
    const where = { username: 'Full-PROFILE' };
    const viaKysely = await readUserWithProfileViaKysely(kysely, where);
    const viaPrisma = await readUserWithProfileViaPrisma(prisma, where);
    expect([viaKysely.id, viaKysely.username]).toStrictEqual([U_FULL, 'full-profile']);
    expect([viaPrisma.id, viaPrisma.username]).toStrictEqual([U_FULL, 'full-profile']);
    expect(sorted(viaKysely)).toStrictEqual(sorted(viaPrisma));
    expect(JSON.stringify(sorted(viaKysely))).toBe(JSON.stringify(sorted(viaPrisma)));
  });

  it.each<[string, UserWithProfileWhere]>([
    ['a deleted user', { id: U_DELETED }],
    ['a deleted user, by username', { username: 'deleted-profile' }],
    ['no such user', { id: U_GONE }],
    ['no such username', { username: 'nobody' }],
    ["an id and another user's username", { id: U_FULL, username: 'bare-profile' }],
  ])('%s: both reject with P2025', async (_, where) => {
    const codeOf = (read: Promise<unknown>) =>
      read.then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError ? error.code : String(error)
      );
    expect(await codeOf(readUserWithProfileViaPrisma(prisma, where))).toBe('P2025');
    expect(await codeOf(readUserWithProfileViaKysely(kysely, where))).toBe('P2025');
  });

  it('control: each branch reads the fixture expected, relations in key order', async () => {
    const full = await readUserWithProfileViaKysely(kysely, { id: U_FULL });
    expect(full.cosmetics.map((c) => [c.cosmeticId, c.claimKey])).toStrictEqual([
      [CO_BADGE, 'claimed'],
      [CO_BADGE, 'second'],
      [CO_PLATE, 'claimed'],
      [CO_DECORATION, 'claimed'],
    ]);
    expect(full.cosmetics[3]).toStrictEqual({
      equippedAt: EQUIPPED_AT,
      cosmeticId: CO_DECORATION,
      obtainedAt: OBTAINED_AT,
      claimKey: 'claimed',
      data: { lights: 7 },
      cosmetic: {
        id: CO_DECORATION,
        data: { url: 'd', lights: 3 },
        type: 'ContentDecoration',
        source: 'Purchase',
        name: 'Decoration',
        description: 'Lit',
        videoUrl: null,
      },
    });
    expect(full.cosmetics[1].obtainedAt).toStrictEqual(OBTAINED_AT_2);
    expect(full.cosmetics[1].equippedAt).toBeNull();
    expect(full.links).toStrictEqual([
      { id: L_SOCIAL, url: 'https://social.example', type: 'Social' },
      { id: L_SPONSOR, url: 'https://sponsor.example', type: 'Sponsorship' },
      { id: L_OTHER, url: 'https://other.example', type: 'Other' },
    ]);
    expect(full.rank).toStrictEqual({
      leaderboardRank: 7,
      leaderboardId: 'overall',
      leaderboardTitle: 'Top creator',
      leaderboardCosmetic: 'gold-frame',
    });
    expect(full.profilePicture).toStrictEqual({
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
    });
    expect(full.profile?.coverImage).toStrictEqual({
      id: IMG_COVER,
      name: 'cover.webm',
      url: 'cover-uuid',
      nsfwLevel: 4,
      width: 1920,
      height: 1080,
      hash: 'coverhash',
      meta: { prompt: 'a hill', steps: 20 },
      userId: U_FULL,
      generationProcess: 'txt2img',
      needsReview: 'minor',
      scannedAt: SCANNED_AT,
      ingestion: 'Blocked',
      blockedFor: 'csam-check',
      postId: 9601,
      type: 'video',
      metadata: { duration: 3 },
      createdAt: IMAGE_CREATED_AT,
      hideMeta: true,
      tags: [
        {
          tag: { id: T_LABEL, name: 'landscape', isCategory: true, type: 'Label' },
          automated: true,
          needsReview: false,
        },
        {
          tag: { id: T_REVIEW, name: 'hill', isCategory: false, type: 'UserGenerated' },
          automated: false,
          needsReview: true,
        },
      ],
    });
    expect(full.profile?.sfwCoverImage?.tags).toStrictEqual([
      {
        tag: { id: T_SFW, name: 'meadow', isCategory: true, type: 'System' },
        automated: true,
        needsReview: true,
      },
    ]);
    expect(full.profile?.messageAddedAt).toStrictEqual(MESSAGE_AT);
    expect(full.profile?.sfwMessageAddedAt).toStrictEqual(SFW_MESSAGE_AT);
    expect(full.settings).toStrictEqual({ creatorShop: { enabled: true } });
    expect(full.createdAt).toStrictEqual(CREATED_AT);

    const bare = await readUserWithProfileViaKysely(kysely, { id: U_BARE });
    expect([bare.profile, bare.rank, bare.profilePicture, bare.meta, bare.settings]).toStrictEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect([bare.cosmetics, bare.links]).toStrictEqual([[], []]);

    const dangling = await readUserWithProfileViaKysely(kysely, { id: U_DANGLING });
    expect(dangling.profilePicture).toBeNull();
    expect(dangling.profile?.coverImageId).toBe(IMG_GONE_2);
    expect(dangling.profile?.coverImage).toBeNull();
    expect(dangling.profile?.sfwCoverImage).toBeNull();
    expect(dangling.rank).toStrictEqual({
      leaderboardRank: null,
      leaderboardId: null,
      leaderboardTitle: null,
      leaderboardCosmetic: null,
    });
    expect(dangling.bannedAt).toStrictEqual(BANNED_AT);
  });

  // Counted by the engine, not from the `query` log: those events can land after the read's
  // promise resolves, so the log read 3 or 8 of the 13 in CI.
  const datasourceQueries = async () =>
    (await prisma.$metrics.json()).counters.find(
      (counter) => counter.key === 'prisma_datasource_queries_total'
    )?.value ?? 0;

  it('one statement where Prisma issues one per relation', async () => {
    prismaStatements.length = 0;
    const before = await datasourceQueries();
    await readUserWithProfileViaPrisma(prisma, { username: 'full-profile' });
    const prismaCount = (await datasourceQueries()) - before;
    kyselyStatements.length = 0;
    await readUserWithProfileViaKysely(logged, { username: 'full-profile' });
    expect(kyselyStatements).toHaveLength(1);
    // A counter that no longer exists reads 0 - 0, never 13.
    expect(prismaCount).toBeGreaterThan(0);
    // The user, its picture, cosmetics, their cosmetics, links, rank, profile, and each cover image
    // with its tags and their tags.
    expect(prismaCount, prismaStatements.join('\n')).toBe(13);
  });

  // "TagsOnImageDetails" is a VIEW. It is a per-row projection (no GROUP BY, no UNION), so Postgres
  // flattens it and the image id reaches the scan of its base table.
  it("the tags view is read by each cover image's id, not computed whole", async () => {
    kyselyStatements.length = 0;
    await readUserWithProfileViaKysely(logged, { id: U_FULL });
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
    // Positive control: both cover images' tag reads are in the plan.
    expect(conditions).toHaveLength(2);
    expect(conditions.filter((c) => c.includes('"CoverImage".id'))).toHaveLength(1);
    expect(conditions.filter((c) => c.includes('"SfwCoverImage".id'))).toHaveLength(1);
    for (const condition of conditions) expect(condition).toContain('imageId');
  });
});

// Offline: the statement is compiled, not run.

describe('hot reads 9: the one statement and the relations it reads', () => {
  it('control: the view list is read from the schema', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ImageTag', 'TagsOnImageDetails', 'UserRank'])
      expect(views.has(known), known).toBe(true);
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it.each<[string, (db: never) => Promise<unknown>]>([
    ['the profile read', (db) => readUserWithProfileViaKysely(db, { id: 1 })],
    ['the row', (db) => getUserWithProfileRow(db, { username: 'a' })],
  ])('%s', async (_, read) => {
    const relations = await compiledRelations(read);
    // An exact ledger: any extra relation or statement fails here.
    expect(relations).toEqual([
      [
        'Cosmetic',
        'Image',
        'Image',
        'Image',
        'Tag',
        'Tag',
        'TagsOnImageDetails',
        'TagsOnImageDetails',
        'User',
        'UserCosmetic',
        'UserLink',
        'UserProfile',
        'UserRank',
      ],
    ]);
    // The only `/// @view` relations: "UserRank" (a table in fact) and the tags projection view,
    // whose base-table scan the EXPLAIN above checks.
    const views = declaredViews();
    expect([...new Set(relations.flat().filter((r) => views.has(r)))].sort()).toEqual([
      'TagsOnImageDetails',
      'UserRank',
    ]);
  });

  it('a where with neither an id nor a username issues no statement', async () => {
    expect(await compiledRelations((db) => readUserWithProfileViaKysely(db, {}))).toEqual([]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
