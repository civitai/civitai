import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getSimpleModelWithOwnerRow,
  listUsersWithCosmeticsRows,
} from '@civitai/db-queries/hot-reads-12';
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
import { servableProfilePictureExtension } from '~/server/db/servable-profile-picture.extension';
import {
  readResourceReviewsPageViaKysely,
  readResourceReviewsPageViaPrisma,
  readSimpleModelWithOwnerViaKysely,
  readSimpleModelWithOwnerViaPrisma,
  readUsersWithCosmeticsViaKysely,
  type ResourceReviewsPage,
  type ResourceReviewsPageArgs,
  type SimpleModelWithOwner,
} from '~/server/services/hot-reads-12.reads';

/**
 * Parity gate for the reads behind `kysely-hot-reads-12`: `userWithCosmeticsSelect` nested under
 * `model.getSimple`'s model and under each review of a `resourceReview.getInfinite` page. Both
 * paths run against the same rows in the same database and must return the same value,
 * `toStrictEqual`, AND the same JSON text (key order, which reaches the response, included). The
 * Prisma client here carries the servable-profile-picture extension, as dbRead and dbWrite do, so a
 * picture that is not Scanned, or is flagged `csam`, is `null` on the Prisma side too. Prisma's
 * nested cosmetics read has no `orderBy`, so cosmetics are compared sorted by key; the Kysely
 * order (cosmetic id, then claim key) is pinned by a literal control.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_12_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_12_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles the Kysely reads and pins the
 * one statement each issues and the relations it names.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_12_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_12_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-12-parity-schema.sql'));

// ONE connection, so the search_path set in beforeAll holds for every Prisma statement.
const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
};

// Ids pairwise distinct across tables, and none equal to a level, a size or a rating.
const U_FULL = 12201; // a Scanned picture, two equipped cosmetics (plus two that are not read)
const U_BARE = 12202; // no picture, no cosmetics, NULL username and image
const U_PENDING = 12203; // a picture not yet Scanned: served to no one
const U_CSAM = 12204; // a Scanned picture flagged csam: served to no one
const U_MINOR = 12205; // a Scanned picture held for another review: still served
const U_DANGLING = 12206; // deleted, and the picture id points at a deleted image
const U_UNREAD = 12207; // has rows of every kind, never requested

const IMG_FULL = 12301;
const IMG_PENDING = 12302;
const IMG_CSAM = 12303;
const IMG_MINOR = 12304;
const IMG_UNREAD = 12305;
const IMG_GONE = 12399;

const CO_BADGE = 12401;
const CO_PLATE = 12402;
const CO_DECORATION = 12403;

const M_FULL = 12501; // Published, locked, owner U_FULL; the reviewed model
const M_BARE = 12502; // Draft, owner U_BARE
const M_DELETED = 12503; // Deleted, owner U_DANGLING
const M_OTHER = 12504; // another model's reviews, never requested
const M_GONE = 12599; // no row

const MV_A = 12601;
const MV_B = 12602;
const MV_OTHER = 12603;

const MODEL_CREATED_AT = new Date('2026-04-05T06:07:08.009Z');
const MODEL_CREATED_AT_2 = new Date('2026-05-06T07:08:09.010Z');
const DELETED_AT = new Date('2026-03-04T05:06:07.008Z');
const OBTAINED_AT = new Date('2026-09-10T11:12:13.140Z');
const EQUIPPED_AT = new Date('2026-10-11T12:13:14.200Z');
// Review times: distinct, newest first is R_1 .. R_6.
const reviewedAt = (n: number) => new Date(Date.UTC(2026, 10, 10 - n, 1, 2, 3, 4 + n));

const ts = (date: Date) => `'${date.toISOString().replace('T', ' ').replace('Z', '')}'`;

const byNumber = <T>(rows: T[], key: (row: T) => number) =>
  [...rows].sort((a, b) => key(a) - key(b));

type User = SimpleModelWithOwner['user'];
const sortedUser = (user: User) => ({
  ...user,
  cosmetics: byNumber(user.cosmetics, (c) => c.cosmetic.id),
});
const sortedModel = (model: SimpleModelWithOwner | null) =>
  model && { ...model, user: sortedUser(model.user) };
const sortedPage = (page: ResourceReviewsPage) =>
  page.map((review) => ({ ...review, user: sortedUser(review.user) }));

/** The full user's payload, written out: never derived from either reader. */
const FULL_USER = {
  id: U_FULL,
  username: 'full-user',
  deletedAt: null,
  image: 'https://img/full',
  profilePicture: {
    id: IMG_FULL,
    name: 'avatar.png',
    url: 'full-uuid',
    nsfwLevel: 1,
    hash: 'fullhash',
    userId: U_FULL,
    ingestion: 'Scanned',
    type: 'image',
    width: 384,
    height: 512,
    metadata: { size: 11 },
  },
  // In the Kysely read's order: cosmetic id.
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
};

const pageArgs = (overrides: Partial<ResourceReviewsPageArgs> = {}): ResourceReviewsPageArgs => ({
  take: 10,
  cursor: undefined,
  where: { AND: [{ modelId: M_FULL }, { details: { not: null } }] },
  orderBy: [{ createdAt: 'desc' }],
  includeModel: false,
  ...overrides,
});

describe.skipIf(!parityUrl)('hot reads 12: Kysely returns exactly what Prisma returned', () => {
  const base = new PrismaClient({
    datasourceUrl: parityUrl && withSchema(parityUrl),
    log: [{ emit: 'event', level: 'query' }],
  });
  const prismaStatements: string[] = [];
  base.$on('query', (event) => {
    prismaStatements.push(event.query);
  });
  // As dbRead and dbWrite are built (src/server/db/client.ts).
  const prisma = base.$extends(
    servableProfilePictureExtension(() => undefined)
  ) as unknown as Prisma.TransactionClient;
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => base.$executeRawUnsafe(statement);

  // A logged client on its own pool, for the statement counts.
  const pool = new Pool({ connectionString: parityUrl });
  const kyselyStatements: CompiledQuery[] = [];
  const logged = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === 'query') kyselyStatements.push(event.query);
    },
  }).withSchema(SCHEMA);

  /** Prisma's query events lag the awaited read: wait for at least `min`, then settle. */
  const settledPrismaStatements = async (min: number) => {
    await vi.waitFor(() => expect(prismaStatements.length).toBeGreaterThanOrEqual(min));
    await new Promise((done) => setTimeout(done, 50));
    return [...prismaStatements];
  };

  beforeAll(async () => {
    // Prisma's `?schema=` sets the session's search_path to that schema ALONE, which hides the
    // citext type's functions and operators (in "public"): put "public" back on this session.
    await exec(`SET search_path TO "${SCHEMA}", public`);
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('User')} (id, username, image, "deletedAt", "profilePictureId") VALUES
        (${U_FULL}, 'full-user', 'https://img/full', NULL, ${IMG_FULL}),
        (${U_BARE}, NULL, NULL, NULL, NULL),
        (${U_PENDING}, 'pending-user', NULL, NULL, ${IMG_PENDING}),
        (${U_CSAM}, 'csam-user', 'https://img/csam', NULL, ${IMG_CSAM}),
        (${U_MINOR}, 'minor-user', NULL, NULL, ${IMG_MINOR}),
        (${U_DANGLING}, 'dangling-user', 'https://img/dangling', ${ts(DELETED_AT)}, ${IMG_GONE}),
        (${U_UNREAD}, 'unread-user', NULL, NULL, ${IMG_UNREAD})
    `);
    await exec(`
      INSERT INTO ${t('Image')}
        (id, name, url, "userId", hash, height, width, type, metadata, "nsfwLevel", "needsReview", ingestion)
      VALUES
        (${IMG_FULL}, 'avatar.png', 'full-uuid', ${U_FULL}, 'fullhash', 512, 384, 'image', '{"size":11}', 1, NULL, 'Scanned'),
        (${IMG_PENDING}, 'pending.png', 'pending-uuid', ${U_PENDING}, NULL, NULL, NULL, 'image', '{}', 0, NULL, 'Pending'),
        (${IMG_CSAM}, 'csam.png', 'csam-uuid', ${U_CSAM}, 'csamhash', 64, 64, 'image', '{}', 2, 'csam', 'Scanned'),
        (${IMG_MINOR}, NULL, 'minor-uuid', ${U_MINOR}, NULL, 128, 96, 'video', '{"duration":3}', 4, 'minor', 'Scanned'),
        (${IMG_UNREAD}, 'unread.png', 'unread-uuid', ${U_UNREAD}, NULL, NULL, NULL, 'image', '{}', 8, NULL, 'Scanned')
    `);
    await exec(`
      INSERT INTO ${t('Cosmetic')} (id, name, type, source, data) VALUES
        (${CO_BADGE}, 'Gold badge', 'Badge', 'Claim', '{"url":"b"}'),
        (${CO_PLATE}, 'Red plate', 'NamePlate', 'Event', '{"color":"red"}'),
        (${CO_DECORATION}, 'Lit decoration', 'ContentDecoration', 'Purchase', '{"url":"d","lights":3}')
    `);
    // Out of key order. Read: equipped and not equipped TO an entity. Left out: unequipped, equipped
    // to an entity, and the unread user's.
    await exec(`
      INSERT INTO ${t('UserCosmetic')}
        ("userId", "cosmeticId", "obtainedAt", "equippedAt", data, "claimKey", "equippedToId")
      VALUES
        (${U_FULL}, ${CO_PLATE}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, '{"lights":7}', 'claimed', NULL),
        (${U_FULL}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', 12701),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, ${ts(EQUIPPED_AT)}, NULL, 'claimed', NULL),
        (${U_FULL}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, NULL, '{"a":1}', 'second', NULL),
        (${U_DANGLING}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', NULL),
        (${U_UNREAD}, ${CO_PLATE}, ${ts(OBTAINED_AT)}, ${ts(EQUIPPED_AT)}, NULL, 'claimed', NULL)
    `);
    await exec(`
      INSERT INTO ${t('Model')} (id, name, "createdAt", "userId", status, locked) VALUES
        (${M_FULL}, 'Full Model', ${ts(MODEL_CREATED_AT)}, ${U_FULL}, 'Published', true),
        (${M_BARE}, 'bare model', ${ts(MODEL_CREATED_AT_2)}, ${U_BARE}, 'Draft', false),
        (${M_DELETED}, 'Deleted model', ${ts(MODEL_CREATED_AT_2)}, ${U_DANGLING}, 'Deleted', false),
        (${M_OTHER}, 'Other model', ${ts(MODEL_CREATED_AT)}, ${U_UNREAD}, 'Published', false)
    `);
    await exec(`
      INSERT INTO ${t('ModelVersion')} (id, name) VALUES
        (${MV_A}, 'v1'), (${MV_B}, 'v2'), (${MV_OTHER}, 'other')
    `);
    // Six reviews of M_FULL with details (U_FULL twice, on two versions), one without details (left
    // out by the filter), and one of another model.
    await exec(`
      INSERT INTO ${t('ResourceReview')}
        (id, "modelId", "modelVersionId", rating, recommended, details, "userId", "createdAt")
      VALUES
        (12801, ${M_FULL}, ${MV_A}, 5, true, 'great', ${U_FULL}, ${ts(reviewedAt(1))}),
        (12802, ${M_FULL}, ${MV_A}, 1, false, 'bad', ${U_BARE}, ${ts(reviewedAt(2))}),
        (12803, ${M_FULL}, ${MV_B}, 4, true, 'fine', ${U_PENDING}, ${ts(reviewedAt(3))}),
        (12804, ${M_FULL}, ${MV_B}, 3, true, 'ok', ${U_CSAM}, ${ts(reviewedAt(4))}),
        (12805, ${M_FULL}, ${MV_B}, 2, false, 'meh', ${U_MINOR}, ${ts(reviewedAt(5))}),
        (12806, ${M_FULL}, ${MV_B}, 5, true, 'again', ${U_FULL}, ${ts(reviewedAt(6))}),
        (12807, ${M_FULL}, ${MV_A}, 4, true, NULL, ${U_DANGLING}, ${ts(reviewedAt(7))}),
        (12808, ${M_OTHER}, ${MV_OTHER}, 5, true, 'elsewhere', ${U_UNREAD}, ${ts(reviewedAt(8))})
    `);
  });

  afterAll(async () => {
    await base.$disconnect();
    await db.destroy();
    await logged.destroy();
  });

  // --- model.getSimple ---

  it.each<[string, number]>([
    ['a published, locked model whose owner has a picture and cosmetics', M_FULL],
    ['a draft whose owner has nothing', M_BARE],
    ['a deleted model whose deleted owner has a dangling picture', M_DELETED],
    ['no such model', M_GONE],
  ])('model.getSimple, %s: both paths agree', async (_, id) => {
    const viaKysely = sortedModel(await readSimpleModelWithOwnerViaKysely(kysely, id));
    const viaPrisma = sortedModel(await readSimpleModelWithOwnerViaPrisma(prisma, id));
    expect(viaKysely).toStrictEqual(viaPrisma);
    expect(JSON.stringify(viaKysely)).toBe(JSON.stringify(viaPrisma));
  });

  it('control: model.getSimple reads the expected model, in the Kysely order', async () => {
    expect(await readSimpleModelWithOwnerViaKysely(kysely, M_FULL)).toStrictEqual({
      id: M_FULL,
      name: 'Full Model',
      createdAt: MODEL_CREATED_AT,
      locked: true,
      status: 'Published',
      user: FULL_USER,
    });
    const deleted = await readSimpleModelWithOwnerViaKysely(kysely, M_DELETED);
    expect(deleted?.status).toBe('Deleted');
    expect(deleted?.user.deletedAt).toStrictEqual(DELETED_AT);
    expect(deleted?.user.profilePicture).toBeNull();
    expect(deleted?.user.cosmetics.map((c) => c.cosmetic.id)).toStrictEqual([CO_DECORATION]);
    expect(await readSimpleModelWithOwnerViaKysely(kysely, M_GONE)).toBeNull();
  });

  it('model.getSimple: one statement where Prisma issues one per relation', async () => {
    prismaStatements.length = 0;
    await readSimpleModelWithOwnerViaPrisma(prisma, M_FULL);
    // Control only: the model, the user, its picture, its cosmetics, their cosmetic rows (the
    // exact count is Prisma-internal, so it is not pinned).
    expect((await settledPrismaStatements(4)).length).toBeGreaterThanOrEqual(4);
    kyselyStatements.length = 0;
    await readSimpleModelWithOwnerViaKysely(logged, M_FULL);
    expect(kyselyStatements).toHaveLength(1);
  });

  // --- the users read ---

  it('control: the users read builds every picture case, and only the requested users', async () => {
    const users = await readUsersWithCosmeticsViaKysely(kysely, [
      U_MINOR,
      U_FULL,
      U_BARE,
      U_PENDING,
      U_CSAM,
      U_DANGLING,
      U_FULL,
      12298, // no such user
    ]);
    expect([...users.keys()].sort((a, b) => a - b)).toStrictEqual([
      U_FULL,
      U_BARE,
      U_PENDING,
      U_CSAM,
      U_MINOR,
      U_DANGLING,
    ]);
    expect(users.get(U_FULL)).toStrictEqual(FULL_USER);
    expect(users.get(U_BARE)).toStrictEqual({
      id: U_BARE,
      username: null,
      deletedAt: null,
      image: null,
      profilePicture: null,
      cosmetics: [],
    });
    expect(users.get(U_PENDING)?.profilePicture).toBeNull();
    expect(users.get(U_CSAM)?.profilePicture).toBeNull();
    expect(users.get(U_MINOR)?.profilePicture).toStrictEqual({
      id: IMG_MINOR,
      name: null,
      url: 'minor-uuid',
      nsfwLevel: 4,
      hash: null,
      userId: U_MINOR,
      ingestion: 'Scanned',
      type: 'video',
      width: 96,
      height: 128,
      metadata: { duration: 3 },
    });
    expect(users.get(U_DANGLING)?.profilePicture).toBeNull();
  });

  it('the users read issues no statement for no ids', async () => {
    kyselyStatements.length = 0;
    expect(await readUsersWithCosmeticsViaKysely(logged, [])).toStrictEqual(new Map());
    expect(kyselyStatements).toHaveLength(0);
  });

  // --- resourceReview.getInfinite ---

  it.each<[string, ResourceReviewsPageArgs]>([
    ['a page with every picture case and a repeated user', pageArgs()],
    ['the same page with its models and versions', pageArgs({ includeModel: true })],
    ['a short page', pageArgs({ take: 2 })],
    ['a page after a cursor', pageArgs({ take: 3, cursor: { id: 12802 } })],
    [
      'by a version, oldest first',
      pageArgs({ where: { modelVersionId: MV_B }, orderBy: [{ createdAt: 'asc' }] }),
    ],
    ['no reviews', pageArgs({ where: { modelId: M_GONE } })],
  ])('resourceReview.getInfinite, %s: both paths agree', async (_, args) => {
    const viaKysely = sortedPage(await readResourceReviewsPageViaKysely(prisma, kysely, args));
    const viaPrisma = sortedPage(await readResourceReviewsPageViaPrisma(prisma, args));
    expect(viaKysely).toStrictEqual(viaPrisma);
    // Key order too: the service spreads each review into the response.
    expect(JSON.stringify(viaKysely)).toBe(JSON.stringify(viaPrisma));
  });

  it('control: the page reads the expected reviews, in order, with their users', async () => {
    const page = await readResourceReviewsPageViaKysely(prisma, kysely, pageArgs());
    expect(page.map((review) => [review.id, review.user.id])).toStrictEqual([
      [12801, U_FULL],
      [12802, U_BARE],
      [12803, U_PENDING],
      [12804, U_CSAM],
      [12805, U_MINOR],
      [12806, U_FULL],
    ]);
    expect(page[0]).toStrictEqual({
      id: 12801,
      modelId: M_FULL,
      modelVersionId: MV_A,
      details: 'great',
      createdAt: reviewedAt(1),
      rating: 5,
      recommended: true,
      user: FULL_USER,
    });
    expect(Object.keys(page[0])).not.toContain('model');
    const withModel = await readResourceReviewsPageViaKysely(
      prisma,
      kysely,
      pageArgs({ take: 1, includeModel: true })
    );
    expect(withModel[0]).toStrictEqual({
      ...page[0],
      model: { id: M_FULL, name: 'Full Model' },
      modelVersion: { id: MV_A, name: 'v1' },
    });
  });

  it('resourceReview.getInfinite: the users are one Kysely statement, and Prisma reads no user relation', async () => {
    prismaStatements.length = 0;
    await readResourceReviewsPageViaPrisma(prisma, pageArgs());
    // Control: the nested read reaches every user relation (the reviews, the users, their pictures,
    // their cosmetics and the cosmetic rows; the exact count is Prisma-internal).
    const nested = await settledPrismaStatements(4);
    for (const table of ['User', 'Image', 'UserCosmetic', 'Cosmetic'])
      expect(
        nested.some((sql) => sql.includes(`"${SCHEMA}"."${table}"`)),
        table
      ).toBe(true);

    prismaStatements.length = 0;
    kyselyStatements.length = 0;
    await readResourceReviewsPageViaKysely(prisma, logged, pageArgs());
    expect(kyselyStatements).toHaveLength(1);
    const reviewsOnly = await settledPrismaStatements(1);
    for (const table of ['User', 'Image', 'UserCosmetic', 'Cosmetic'])
      expect(
        reviewsOnly.some((sql) => sql.includes(`"${SCHEMA}"."${table}"`)),
        table
      ).toBe(false);
  });
});

// Offline: the statements are compiled, not run.

describe('hot reads 12: the one statement and the relations it reads', () => {
  it('control: the view list is read from the schema', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ImageTag', 'TagsOnImageDetails'])
      expect(views.has(known), known).toBe(true);
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  const USER_RELATIONS = ['Cosmetic', 'Image', 'User', 'UserCosmetic'];

  it.each<[string, (db: never) => Promise<unknown>, string[]]>([
    ['the users read', (db) => readUsersWithCosmeticsViaKysely(db, [1, 2]), USER_RELATIONS],
    ['the users row', (db) => listUsersWithCosmeticsRows(db, [1, 2]), USER_RELATIONS],
    [
      'the simple model read',
      (db) => readSimpleModelWithOwnerViaKysely(db, 1),
      ['Cosmetic', 'Image', 'Model', 'User', 'UserCosmetic'],
    ],
    [
      'the simple model row',
      (db) => getSimpleModelWithOwnerRow(db, 1),
      ['Cosmetic', 'Image', 'Model', 'User', 'UserCosmetic'],
    ],
  ])('%s', async (_, read, expected) => {
    const relations = await compiledRelations(read);
    // An exact ledger: any extra relation or statement fails here.
    expect(relations).toEqual([expected]);
    const views = declaredViews();
    expect(relations.flat().filter((r) => views.has(r))).toEqual([]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
