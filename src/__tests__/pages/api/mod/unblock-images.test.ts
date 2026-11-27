import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

const { unblockModeratedImages } = await import('~/server/api-routes/mod/unblock-images');

// 1 shares its url with 3, a CSAM block, so it is withheld from a moderator without the grant.
const WITHHELD = 1;
const PLAIN = 2;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
    ${WITHHELD_TABLES_SQL}
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared', 'Scanned', 'moderated', 7),
      (${PLAIN}, 'plain', 'Scanned', 'moderated', 7),
      (3, 'shared', 'Blocked', 'CSAM', 8);
  `);
});

beforeEach(() => {
  vi.clearAllMocks();
  // The replica scan finds both moderated images; the primary clears what it is handed.
  vi.mocked(dbMock.dbRead.$queryRaw)
    .mockResolvedValueOnce([{ maxId: 3 }] as never)
    .mockResolvedValueOnce([{ id: WITHHELD }, { id: PLAIN }] as never);
  vi.mocked(dbMock.dbWrite.image.updateManyAndReturn).mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => args.where.id.in.map((id) => ({ id }))) as never);
});

const cleared = () =>
  vi
    .mocked(dbMock.dbWrite.image.updateManyAndReturn)
    .mock.calls.map(([args]) => (args as { where: { id: { in: number[] } } }).where.id.in);

describe('unblockModeratedImages', () => {
  it('leaves an image withheld from the moderator blocked without the grant', async () => {
    const result = await unblockModeratedImages({ id: 9 }, { csamReview: false });

    expect(cleared()).toEqual([[PLAIN]]);
    expect(result).toEqual({ updated: 1, withheld: 1 });
  });

  it('clears both for a moderator holding the grant', async () => {
    const result = await unblockModeratedImages({ id: 9 }, { csamReview: true });

    expect(cleared()).toEqual([[WITHHELD, PLAIN]]);
    expect(result).toEqual({ updated: 2, withheld: 0 });
  });
});
