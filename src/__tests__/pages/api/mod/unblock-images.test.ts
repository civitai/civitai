import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  /** Run just before the update reaches the primary: a mark that lands after the chunk check. */
  beforeUpdate: null as null | (() => Promise<unknown>),
}));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

const { unblockModeratedImages } = await import('~/server/api-routes/mod/unblock-images');

// 1 shares its url with 3, a CSAM block, so it is withheld from a moderator without the grant.
const WITHHELD = 1;
const PLAIN = 2;
// Not withheld when the chunk is checked; a CSAM block lands on its url before the update.
const MARKED_MID_RUN = 4;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked');
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion "ImageIngestionStatus",
      "needsReview" text, "blockedFor" text, "nsfwLevel" int NOT NULL DEFAULT 1,
      "updatedAt" timestamp(3), "userId" int, "pHash" bigint, "postId" int);
    ${WITHHELD_TABLES_SQL}
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.beforeUpdate = null;
  await holder.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared', 'Scanned', 'moderated', 7),
      (${PLAIN}, 'plain', 'Scanned', 'moderated', 7),
      (3, 'shared', 'Blocked', 'CSAM', 8),
      (${MARKED_MID_RUN}, 'later', 'Scanned', 'moderated', 7);
  `);
  // The replica scan finds every moderated image; the update runs on the primary (PGlite).
  vi.mocked(dbMock.dbRead.$queryRaw)
    .mockResolvedValueOnce([{ maxId: 4 }] as never)
    .mockResolvedValueOnce([{ id: WITHHELD }, { id: PLAIN }, { id: MARKED_MID_RUN }] as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    // The follow-ups (delete queue, search index) are not this test's subject.
    if (!strings.join('').includes('UPDATE "Image"')) return [];
    await holder.beforeUpdate?.();
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
});

const blockedFor = async () =>
  (
    await holder.db.query<{ id: number; blockedFor: string | null }>(
      `SELECT id, "blockedFor" FROM "Image" WHERE id = ANY($1) ORDER BY id`,
      [[WITHHELD, PLAIN, MARKED_MID_RUN]]
    )
  ).rows.map((row) => [row.id, row.blockedFor]);

describe('unblockModeratedImages', () => {
  it('leaves an image withheld from the moderator blocked without the grant', async () => {
    const result = await unblockModeratedImages({ id: 9 }, { csamReview: false });

    expect(await blockedFor()).toEqual([
      [WITHHELD, 'moderated'],
      [PLAIN, null],
      [MARKED_MID_RUN, null],
    ]);
    expect(result).toEqual({ updated: 2, withheld: 1 });
  });

  it('leaves blocked an image a CSAM block reaches after its chunk was checked', async () => {
    holder.beforeUpdate = () =>
      holder.db.exec(
        `INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES (5, 'later', 'Blocked', 'CSAM', 8)`
      );

    const result = await unblockModeratedImages({ id: 9 }, { csamReview: false });

    expect(await blockedFor()).toEqual([
      [WITHHELD, 'moderated'],
      [PLAIN, null],
      [MARKED_MID_RUN, 'moderated'],
    ]);
    expect(result).toEqual({ updated: 1, withheld: 1 });
  });

  it('writes in chunks, each re-checking its own rows', async () => {
    const result = await unblockModeratedImages({ id: 9 }, { csamReview: false, updateChunk: 1 });

    const updates = vi
      .mocked(dbMock.dbWrite.$queryRaw)
      .mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray).join('').includes('UPDATE "Image"')
      );
    expect(updates).toHaveLength(2);
    expect(await blockedFor()).toEqual([
      [WITHHELD, 'moderated'],
      [PLAIN, null],
      [MARKED_MID_RUN, null],
    ]);
    expect(result).toEqual({ updated: 2, withheld: 1 });
  });

  it('records each slice as it commits, so a later slice that throws leaves the earlier ones audited', async () => {
    let updates = 0;
    holder.beforeUpdate = async () => {
      if (++updates === 2) throw new Error('slice 2 failed');
    };

    await expect(
      unblockModeratedImages({ id: 9 }, { csamReview: false, updateChunk: 1 })
    ).rejects.toThrow('slice 2 failed');

    const activity = vi
      .mocked(dbMock.dbWrite.$executeRaw)
      .mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray).join('').includes('INSERT INTO "ModActivity"')
      );
    expect(activity.map(([, ...values]) => values.at(-1))).toEqual([[PLAIN]]);
    expect(await blockedFor()).toEqual([
      [WITHHELD, 'moderated'],
      [PLAIN, null],
      [MARKED_MID_RUN, 'moderated'],
    ]);
  });

  it('clears every one for a moderator holding the grant', async () => {
    const result = await unblockModeratedImages({ id: 9 }, { csamReview: true });

    expect(await blockedFor()).toEqual([
      [WITHHELD, null],
      [PLAIN, null],
      [MARKED_MID_RUN, null],
    ]);
    expect(result).toEqual({ updated: 3, withheld: 0 });
  });
});
