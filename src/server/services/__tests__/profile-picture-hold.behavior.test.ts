import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as UserService from '~/server/services/user.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const after = vi.hoisted(() => ({
  refresh: vi.fn(async (ids: number[]) => void ids),
  queued: [] as { index: string; ids: number[] }[],
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  refreshProfilePicturesForUsers: after.refresh,
}));
for (const [mod, name] of [
  ['~/server/search-index/users.search-index', 'usersSearchIndex'],
  ['~/server/search-index/bounties.search-index', 'bountiesSearchIndex'],
  ['~/server/search-index/collections.search-index', 'collectionsSearchIndex'],
  ['~/server/search-index/comics.search-index', 'comicsSearchIndex'],
] as const) {
  vi.doMock(mod, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    [name]: {
      queueUpdate: vi.fn(async (items: { id: number }[]) => {
        after.queued.push({ index: name, ids: items.map((i) => i.id) });
      }),
    },
  }));
}

const { isUnservableOwnImageUrl, runProfilePictureSync, syncProfilePictureForImage } = await import(
  '~/server/services/profile-picture-hold.service'
);
const { getBlockedProfilePictureNotices } = await import(
  '~/server/notifications/primary-notification-queries'
);
const { readRemovedProfilePictures } = await import(
  '~/server/services/personal-data-export/sources/profile-pictures'
);
const { getProfilePictureUserIds } = await import('~/server/services/user.service');
const { isExemptFromAiVerification } = await import('~/server/services/image-scan-result.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/** "JobQueue" and its enums as the migrations build them, ending with the ProfilePictureHold one. */
function jobQueueFromMigrations() {
  const create = migration('20240307231126_nsfw_level_update_queue');
  const start = create.indexOf('CREATE TYPE "EntityType"');
  const end = create.indexOf(');', create.indexOf('CREATE TABLE "JobQueue"')) + 2;
  const addValues = readdirSync(MIGRATIONS)
    .sort()
    .flatMap((dir) => {
      let sql: string;
      try {
        sql = migration(dir);
      } catch {
        return [];
      }
      return sql.match(/ALTER TYPE "JobQueueType" ADD VALUE[^;]*;/g) ?? [];
    });
  return [
    create.slice(start, end),
    migration('20261002210000_job_queue_data_column'),
    ...addValues,
  ].join('\n');
}

const db = new PGlite();
type Row = Record<string, unknown>;

const OWNER = 1;
const HELD_OWNER = 2; // an EvidenceHold marker
const REPORTED_OWNER = 3; // named on a pending CsamReport
const SECONDARY_OWNER = 4; // named as secondary on a sent, archived, old report
const DELETED_OWNER = 5;
const OTHER = 6;

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text,
      "blockedFor" text,
      minor boolean NOT NULL DEFAULT false,
      "updatedAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "User" (
      id int PRIMARY KEY,
      "deletedAt" timestamp(3),
      image text,
      "profilePictureId" int UNIQUE REFERENCES "Image"(id) ON DELETE SET NULL
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "EvidenceHold" (
      "userId" int NOT NULL, "releasedAt" timestamp(3), "releaseAt" timestamp(3),
      "extendedUntil" timestamp(3)
    );
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold"
      WHERE "releasedAt" IS NULL
        AND ("releaseAt" IS NULL OR "releaseAt" > now() OR "extendedUntil" > now())
      GROUP BY "userId";
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ComicProject" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "UserProfile" ("userId" int, "coverImageId" int);
    CREATE TABLE "Article" (id int, "coverId" int, "bannerId" int);
    CREATE TABLE "Challenge" (id int, "coverImageId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityType" text);
  `);
  await db.exec(jobQueueFromMigrations());
  await db.exec(migration('20261229120000_profile_picture_hold'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  after.queued.length = 0;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    return (await db.query<Row>(sql.text, sql.values)).rows;
  }) as never);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    return (await db.query(sql.text, sql.values)).affectedRows ?? 0;
  }) as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    await db.exec('BEGIN');
    try {
      const result = await fn(dbMock.dbWrite);
      await db.exec('COMMIT');
      return result;
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }
  }) as never);
  for (const model of ['bounty', 'collection', 'comicProject'] as const)
    vi.mocked(dbMock.dbWrite[model].findMany).mockImplementation((async (args: {
      where: { userId: { in: number[] } };
    }) => {
      const table = { bounty: 'Bounty', collection: 'Collection', comicProject: 'ComicProject' };
      const { rows } = await db.query<{ id: number }>(
        `SELECT id FROM "${table[model]}" WHERE "userId" = ANY($1)`,
        [args.where.userId.in]
      );
      return rows;
    }) as never);

  await db.exec(`
    TRUNCATE "ProfilePictureHold", "JobQueue", "CsamReport", "EvidenceHold", "Bounty",
      "Collection", "ComicProject";
    DELETE FROM "User";
    DELETE FROM "Image";
    INSERT INTO "Image" (id, "userId", url)
      SELECT u * 100 + n, u, 'img-' || (u * 100 + n)
      FROM generate_series(1, 6) u, generate_series(1, 3) n;
    INSERT INTO "User" (id, "profilePictureId")
      SELECT u, u * 100 + 1 FROM generate_series(1, 6) u;
    UPDATE "User" SET "deletedAt" = now() WHERE id = ${DELETED_OWNER};
    INSERT INTO "EvidenceHold" VALUES (${HELD_OWNER}, NULL, NULL, NULL);
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED_OWNER});
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${OTHER}, now() - interval '400 days', now(), '{"secondaryUserId": ${SECONDARY_OWNER}}');
  `);
});

const avatar = (user: number) => user * 100 + 1;

/** What the trigger (Migration B) does on a block, flag or clear: queue the image. */
const queue = (imageId: number, ageMinutes = 0) =>
  db.query(
    `INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt")
     VALUES ('ProfilePictureSync', 'Image', $1, now() - make_interval(mins => $2))
     ON CONFLICT DO NOTHING`,
    [imageId, ageMinutes]
  );
const setImage = async (imageId: number, set: string) => {
  await db.query(`UPDATE "Image" SET ${set}, "updatedAt" = now() WHERE id = $1`, [imageId]);
  await queue(imageId);
};
const block = (id: number, blockedFor: string | null = null) =>
  setImage(id, `ingestion = 'Blocked', "blockedFor" = ${blockedFor ? `'${blockedFor}'` : 'NULL'}`);
const unblock = (id: number) => setImage(id, `ingestion = 'Scanned'`);
const review = (id: number, needsReview: string | null) =>
  setImage(id, `"needsReview" = ${needsReview ? `'${needsReview}'` : 'NULL'}`);

const pointer = async (user: number) =>
  (
    await db.query<{ p: number | null }>(`SELECT "profilePictureId" p FROM "User" WHERE id = $1`, [
      user,
    ])
  ).rows[0].p;
const holds = async (user: number) =>
  (
    await db.query<{ imageId: number; reason: string }>(
      `SELECT "imageId", reason FROM "ProfilePictureHold" WHERE "userId" = $1 ORDER BY id`,
      [user]
    )
  ).rows;
const queued = async () =>
  (await db.query<{ id: number }>(`SELECT "entityId" id FROM "JobQueue" ORDER BY 1`)).rows.map(
    (r) => r.id
  );

describe('the queue type, on a schema built from the migrations', () => {
  it('takes a ProfilePictureSync row', async () => {
    await queue(avatar(OWNER));
    expect(await queued()).toEqual([avatar(OWNER)]);
  });
});

describe('syncProfilePictureForImage', () => {
  it('records a blocked avatar and takes it off the user, in one go', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toEqual([{ imageId: avatar(OWNER), reason: 'blocked' }]);
    expect(await queued()).toEqual([]);
  });

  it("records a csam-flagged avatar as 'flagged'", async () => {
    await review(avatar(OWNER), 'csam');
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toEqual([{ imageId: avatar(OWNER), reason: 'flagged' }]);
  });

  it.each(['minor', 'poi', 'newUser', 'appeal'])(
    "takes an avatar under %s review off its user, as 'flagged'",
    async (needsReview) => {
      await review(avatar(OWNER), needsReview);
      await runProfilePictureSync();
      expect(await pointer(OWNER)).toBeNull();
      expect(await holds(OWNER)).toEqual([{ imageId: avatar(OWNER), reason: 'flagged' }]);
      await review(avatar(OWNER), null);
      await runProfilePictureSync();
      expect(await pointer(OWNER)).toBe(avatar(OWNER));
    }
  );

  it("records a soft-deleted owner's blocked avatar too", async () => {
    await block(avatar(DELETED_OWNER));
    await runProfilePictureSync();
    expect(await pointer(DELETED_OWNER)).toBeNull();
    expect(await holds(DELETED_OWNER)).toHaveLength(1);
  });

  it('restores on unblock, and deletes the record', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBe(avatar(OWNER));
    expect(await holds(OWNER)).toEqual([]);
  });

  it('a block undone before the job runs leaves the avatar alone', async () => {
    await block(avatar(OWNER));
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBe(avatar(OWNER));
    expect(await holds(OWNER)).toEqual([]);
  });

  it('decides from the state now: an unblock then a block before the run records it', async () => {
    await unblock(avatar(OWNER));
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toHaveLength(1);
  });

  it('csam -> appeal keeps the record; appeal -> cleared restores it', async () => {
    await review(avatar(OWNER), 'csam');
    await runProfilePictureSync();
    await review(avatar(OWNER), 'appeal');
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toHaveLength(1);
    await review(avatar(OWNER), null);
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBe(avatar(OWNER));
    expect(await holds(OWNER)).toEqual([]);
  });

  it('does not restore an image unblocked with blockedFor CSAM and no flag', async () => {
    await block(avatar(OWNER), 'CSAM');
    await runProfilePictureSync();
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toHaveLength(1);
  });

  it("restores only the user's newest record", async () => {
    const second = OWNER * 100 + 2;
    await block(avatar(OWNER));
    await runProfilePictureSync();
    await db.query(`UPDATE "User" SET "profilePictureId" = $1 WHERE id = $2`, [second, OWNER]);
    await block(second);
    await runProfilePictureSync();
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect((await holds(OWNER)).map((h) => h.imageId)).toEqual([avatar(OWNER), second]);
    await unblock(second);
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBe(second);
    expect((await holds(OWNER)).map((h) => h.imageId)).toEqual([avatar(OWNER)]);
  });

  it('does not restore over an avatar the user has since chosen', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    await db.query(`UPDATE "User" SET "profilePictureId" = $1 WHERE id = $2`, [
      OWNER * 100 + 3,
      OWNER,
    ]);
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBe(OWNER * 100 + 3);
    expect(await holds(OWNER)).toHaveLength(1);
  });

  it("restores a held owner's avatar but keeps the record", async () => {
    await block(avatar(HELD_OWNER));
    await runProfilePictureSync();
    await unblock(avatar(HELD_OWNER));
    await runProfilePictureSync();
    expect(await pointer(HELD_OWNER)).toBe(avatar(HELD_OWNER));
    expect(await holds(HELD_OWNER)).toEqual([{ imageId: avatar(HELD_OWNER), reason: 'blocked' }]);
  });

  it('does not restore an image that is no longer the user’s own', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    await db.query(`UPDATE "Image" SET "userId" = $1 WHERE id = $2`, [OTHER, avatar(OWNER)]);
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect(await holds(OWNER)).toHaveLength(1);
  });

  it('does not restore a soft-deleted owner', async () => {
    await block(avatar(DELETED_OWNER));
    await runProfilePictureSync();
    await unblock(avatar(DELETED_OWNER));
    await runProfilePictureSync();
    expect(await pointer(DELETED_OWNER)).toBeNull();
    expect(await holds(DELETED_OWNER)).toHaveLength(1);
  });

  it('does nothing for an image no queue row names', async () => {
    await db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = $1`, [avatar(OWNER)]);
    const outcome = await syncProfilePictureForImage(dbMock.dbWrite as never, avatar(OWNER));
    expect(outcome).toEqual({ action: 'unclaimed' });
    expect(await pointer(OWNER)).toBe(avatar(OWNER));
  });

  describe('the legacy User.image url', () => {
    const image = async (user: number) =>
      (await db.query<{ image: string | null }>(`SELECT image FROM "User" WHERE id = $1`, [user]))
        .rows[0].image;

    it("is cleared when it is the held image's own url", async () => {
      await db.query(`UPDATE "User" SET image = $1 WHERE id = $2`, [`img-${avatar(OWNER)}`, OWNER]);
      await block(avatar(OWNER));
      await runProfilePictureSync();
      expect(await image(OWNER)).toBeNull();
    });

    it("is cleared when it is another Blocked image of the user's", async () => {
      const other = OWNER * 100 + 2;
      await db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = $1`, [other]);
      await db.query(`UPDATE "User" SET image = $1 WHERE id = $2`, [`img-${other}`, OWNER]);
      await block(avatar(OWNER));
      await runProfilePictureSync();
      expect(await image(OWNER)).toBeNull();
    });

    it('is kept when it is a url that is not one of their images', async () => {
      await db.query(`UPDATE "User" SET image = 'https://example.invalid/a.png' WHERE id = $1`, [
        OWNER,
      ]);
      await block(avatar(OWNER));
      await runProfilePictureSync();
      expect(await image(OWNER)).toBe('https://example.invalid/a.png');
    });

    it('is kept when it is a NON-blocked image of theirs', async () => {
      const other = OWNER * 100 + 2;
      await db.query(`UPDATE "User" SET image = $1 WHERE id = $2`, [`img-${other}`, OWNER]);
      await block(avatar(OWNER));
      await runProfilePictureSync();
      expect(await image(OWNER)).toBe(`img-${other}`);
    });

    it('is not brought back by a restore', async () => {
      await db.query(`UPDATE "User" SET image = $1 WHERE id = $2`, [`img-${avatar(OWNER)}`, OWNER]);
      await block(avatar(OWNER));
      await runProfilePictureSync();
      await unblock(avatar(OWNER));
      await runProfilePictureSync();
      expect(await pointer(OWNER)).toBe(avatar(OWNER));
      expect(await image(OWNER)).toBeNull();
    });
  });
});

describe('runProfilePictureSync', () => {
  it("refreshes the owner's caches and queues the search docs that show their avatar", async () => {
    await db.exec(`
      INSERT INTO "Bounty" VALUES (10, ${OWNER}), (11, ${OTHER});
      INSERT INTO "Collection" VALUES (20, ${OWNER});
      INSERT INTO "ComicProject" VALUES (30, ${OWNER});
    `);
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(after.refresh).toHaveBeenCalledWith([OWNER]);
    expect(after.queued).toEqual(
      expect.arrayContaining([
        { index: 'usersSearchIndex', ids: [OWNER] },
        { index: 'bountiesSearchIndex', ids: [10] },
        { index: 'collectionsSearchIndex', ids: [20] },
        { index: 'comicsSearchIndex', ids: [30] },
      ])
    );
  });

  it('logs a heartbeat every run, and no overdue error while the queue is fresh', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    const names = loggingMock.logToAxiom.mock.calls.map(([e]) => (e as { name: string }).name);
    expect(names).toContain('profile-picture-sync-heartbeat');
    expect(names).not.toContain('profile-picture-sync-overdue');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', processed: 1, oldestAgeMinutes: 0 })
    );
  });

  it('logs an overdue error while the oldest row is past 15 minutes', async () => {
    await db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = $1`, [avatar(OWNER)]);
    await queue(avatar(OWNER), 16);
    await runProfilePictureSync();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'profile-picture-sync-overdue' })
    );
  });

  it('a failed image keeps its queue row and its avatar, and the rest of the batch runs', async () => {
    await block(avatar(OWNER));
    await block(avatar(OTHER));
    let calls = 0;
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
      first: TemplateStringsArray | Prisma.Sql,
      ...values: unknown[]
    ) => {
      const sql = toSql(first, values);
      if (sql.text.includes('INSERT INTO "ProfilePictureHold"') && calls++ === 0)
        throw new Error('insert failed');
      return (await db.query(sql.text, sql.values)).affectedRows ?? 0;
    }) as never);
    const summary = await runProfilePictureSync();
    expect(summary).toMatchObject({ failed: 1, processed: 1 });
    expect(await queued()).toEqual([avatar(OWNER)]);
    expect(await pointer(OWNER)).toBe(avatar(OWNER));
    expect(await pointer(OTHER)).toBeNull();
  });
});

describe('the profile-picture-blocked notice', () => {
  const since = () => new Date(Date.now() - 60_000);
  const noticed = async () => (await getBlockedProfilePictureNotices(since())).map((n) => n.userId);

  it('is sent for an ordinary block before the job runs (the pointer path)', async () => {
    await block(avatar(OWNER));
    expect(await noticed()).toEqual([OWNER]);
  });

  it('is sent once for an ordinary block after the job runs (the record path)', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await noticed()).toEqual([OWNER]);
  });

  // Red on the old query, which joined the pointer and nothing else.
  it('is not sent to a held owner', async () => {
    await block(avatar(HELD_OWNER));
    expect(await noticed()).toEqual([]);
    await runProfilePictureSync();
    expect(await noticed()).toEqual([]);
  });

  it('is not sent for a CSAM block or a csam flag', async () => {
    await block(avatar(OWNER), 'CSAM');
    await db.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "needsReview" = 'csam' WHERE id = $1`,
      [avatar(OTHER)]
    );
    await runProfilePictureSync();
    expect(await noticed()).toEqual([]);
  });

  it('is not sent for a restore', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    await unblock(avatar(OWNER));
    await runProfilePictureSync();
    expect(await noticed()).toEqual([]);
  });
});

describe('the personal-data export of removed profile pictures', () => {
  const exported = async (user: number) =>
    (await readRemovedProfilePictures(user)).map((r) => r.imageId);

  it('includes a blocked avatar of an owner who is not held', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    const [row] = await readRemovedProfilePictures(OWNER);
    expect(row).toEqual({ imageId: avatar(OWNER), removedAt: expect.any(Date) });
  });

  // A csam flag also holds the owner, so this record leaves only by its reason.
  it("leaves out a 'flagged' record whose image has gone to appeal", async () => {
    await review(avatar(OWNER), 'csam');
    await runProfilePictureSync();
    await review(avatar(OWNER), 'appeal');
    await runProfilePictureSync();
    expect(await holds(OWNER)).toEqual([{ imageId: avatar(OWNER), reason: 'flagged' }]);
    expect(await exported(OWNER)).toEqual([]);
  });

  it("leaves out a 'flagged' record", async () => {
    await review(avatar(OWNER), 'csam');
    await runProfilePictureSync();
    expect(await exported(OWNER)).toEqual([]);
  });

  // The owner is also held by the CSAM block itself; the image clause is defence in depth.
  it("leaves out a 'blocked' record whose image is CSAM-blocked", async () => {
    await block(avatar(OWNER), 'CSAM');
    await runProfilePictureSync();
    expect(await holds(OWNER)).toEqual([{ imageId: avatar(OWNER), reason: 'blocked' }]);
    expect(await exported(OWNER)).toEqual([]);
  });

  it('keeps a row an earlier export showed after the owner is held', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await exported(OWNER)).toEqual([avatar(OWNER)]);
    await db.exec(`INSERT INTO "EvidenceHold" VALUES (${OWNER}, NULL, NULL, NULL)`);
    await db.query(`UPDATE "Image" SET "needsReview" = 'appeal' WHERE id = $1`, [avatar(OWNER)]);
    expect(await exported(OWNER)).toEqual([avatar(OWNER)]);
  });

  it('the notice and the export agree on whom they tell', async () => {
    const owners = [OWNER, HELD_OWNER, REPORTED_OWNER, SECONDARY_OWNER, OTHER];
    for (const o of owners) await block(avatar(o));
    await runProfilePictureSync();
    const noticed = (await getBlockedProfilePictureNotices(new Date(Date.now() - 60_000))).map(
      (n) => n.userId
    );
    const exportedTo: number[] = [];
    for (const o of owners) if ((await exported(o)).length) exportedTo.push(o);
    expect(noticed.sort()).toEqual(exportedTo.sort());
    expect(exportedTo).toEqual([OWNER]);
  });

  it('leaves out a held owner, wholesale', async () => {
    await block(avatar(HELD_OWNER));
    await runProfilePictureSync();
    await db.query(`UPDATE "User" SET "profilePictureId" = $1 WHERE id = $2`, [
      HELD_OWNER * 100 + 2,
      HELD_OWNER,
    ]);
    await block(HELD_OWNER * 100 + 2);
    await runProfilePictureSync();
    expect(await holds(HELD_OWNER)).toHaveLength(2);
    expect(await exported(HELD_OWNER)).toEqual([]);
  });

  // OTHER's only report was sent and archived over a year ago: no longer a hold, still a report.
  it('leaves out an owner who is the subject of an old, closed CsamReport', async () => {
    await block(avatar(OTHER));
    await runProfilePictureSync();
    expect(await holds(OTHER)).toHaveLength(1);
    expect(await exported(OTHER)).toEqual([]);
  });

  it('leaves out an owner named on any CsamReport, as subject or secondary', async () => {
    await block(avatar(REPORTED_OWNER));
    await block(avatar(SECONDARY_OWNER));
    await runProfilePictureSync();
    expect(await holds(REPORTED_OWNER)).toHaveLength(1);
    expect(await holds(SECONDARY_OWNER)).toHaveLength(1);
    expect(await exported(REPORTED_OWNER)).toEqual([]);
    expect(await exported(SECONDARY_OWNER)).toEqual([]);
  });
});

describe('isUnservableOwnImageUrl (verifyAvatar)', () => {
  const KEY = '5c4d0f2e-7a91-4b6d-8e33-2f1c9ab07d54';
  beforeEach(async () => {
    await db.query(`UPDATE "Image" SET url = $1 WHERE id = $2`, [KEY, OWNER * 100 + 2]);
  });

  it("is true for the url, or a url carrying the key, of the user's own Blocked image", async () => {
    await db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = $1`, [OWNER * 100 + 2]);
    expect(await isUnservableOwnImageUrl(OWNER, KEY)).toBe(true);
    expect(await isUnservableOwnImageUrl(OWNER, `https://image.civitai.com/x/${KEY}/w=96`)).toBe(
      true
    );
  });

  // Every review kind alike: refusing only a csam flag would tell the owner which kind it is.
  it.each(['csam', 'minor', 'poi', 'appeal'])(
    "is true for the user's own image under %s review",
    async (needsReview) => {
      await db.query(`UPDATE "Image" SET "needsReview" = $1 WHERE id = $2`, [
        needsReview,
        OWNER * 100 + 2,
      ]);
      expect(await isUnservableOwnImageUrl(OWNER, KEY)).toBe(true);
    }
  );

  it('is false for a servable image, and for another user', async () => {
    expect(await isUnservableOwnImageUrl(OWNER, KEY)).toBe(false);
    await db.query(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = $1`, [OWNER * 100 + 2]);
    expect(await isUnservableOwnImageUrl(OTHER, KEY)).toBe(false);
  });
});

describe('other readers of the record', () => {
  it('getProfilePictureUserIds finds the user a removed avatar was taken from', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await pointer(OWNER)).toBeNull();
    expect((await getProfilePictureUserIds([avatar(OWNER), avatar(OTHER)])).sort()).toEqual([
      OWNER,
      OTHER,
    ]);
  });

  it('a removed avatar stays exempt from AI verification', async () => {
    await block(avatar(OWNER));
    await runProfilePictureSync();
    expect(await isExemptFromAiVerification(avatar(OWNER))).toBe(true);
    expect(await isExemptFromAiVerification(OWNER * 100 + 2)).toBe(false);
  });
});
