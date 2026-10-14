import { PGlite } from '@electric-sql/pglite';
import { DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: null,
}));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const { copyScanLabelImages } = await import('~/server/jobs/scan-label-copy');
const { createScanLabelSweepStore, scanLabelSweepStoreFromEnv, sweepScanLabelCopies } =
  await import('~/server/jobs/scan-label-copy-sweep');

const MIGRATIONS = [
  '20261022130000_scan_label_queue',
  '20261022140000_scan_label_outcomes',
  '20261023130000_scan_label_reasons_copy',
  '20261023140000_scan_label_copy_sweep',
  '20261024130000_scan_label_copy_removed_at',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
);

// The real eligibility view is applied separately and is not in this repository.
const STAND_IN_VIEW = `
  CREATE VIEW "ScanLabelCopyEligibility" AS
    SELECT "itemId", ok AS "eligibleForCopy" FROM test_eligibility;
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL DEFAULT 7, "url" text NOT NULL,
      "pHash" bigint, "blockedFor" text, "needsReview" text
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE test_eligibility ("itemId" integer PRIMARY KEY, ok boolean NOT NULL);
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
  await holder.db.exec(STAND_IN_VIEW);
});

beforeEach(async () => {
  vi.mocked(loggingMock.logToAxiom).mockClear();
  await holder.db.exec(
    `TRUNCATE "ScanLabelItem", "ScanLabelCopyObject", "Image", "CsamReport", test_eligibility CASCADE`
  );
});

const removing = () => {
  const removed: string[] = [];
  return { removed, store: { remove: async (key: string) => void removed.push(key) } };
};

/** Copies item `id` (image `id`, eligible) through the real copy job. */
async function copied(id: number) {
  await holder.db.query(`INSERT INTO "Image" ("id", "url") VALUES ($1, $2)`, [id, `key-${id}`]);
  await holder.db.query(
    `INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt", "status", "votes", "outcome", "decidedAt")
     VALUES ($1, $1, now(), 'decided', 3, 'clear', now())`,
    [id]
  );
  await holder.db.query(`INSERT INTO test_eligibility VALUES ($1, true)`, [id]);
  await copyScanLabelImages({ store: { put: async () => undefined } });
}

const ledger = async () =>
  (
    await holder.db.query<{ key: string; withdrawReason: string | null }>(
      `SELECT key, "withdrawReason" FROM "ScanLabelCopyObject" ORDER BY key`
    )
  ).rows;
const item = async (id: number) =>
  (
    await holder.db.query<{ copyState: string; copyKey: string | null }>(
      `SELECT "copyState", "copyKey" FROM "ScanLabelItem" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe('sweepScanLabelCopies', () => {
  it('withdraws a copy whose image entered the CSAM path after it was copied', async () => {
    await copied(1);
    await copied(2);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    const { removed, store } = removing();

    expect(await sweepScanLabelCopies({ store })).toMatchObject({ withdrawn: 1, failed: 0 });
    expect(removed).toEqual(['1/key-1']);
    expect(await item(1)).toEqual({ copyState: 'withdrawn', copyKey: null });
    expect(await item(2)).toEqual({ copyState: 'copied', copyKey: '2/key-2' });
    expect(await ledger()).toEqual([
      { key: '1/key-1', withdrawReason: 'excluded' },
      { key: '2/key-2', withdrawReason: null },
    ]);
  });

  it('leaves a copy that still qualifies untouched', async () => {
    await copied(1);
    const { removed, store } = removing();
    expect(await sweepScanLabelCopies({ store })).toMatchObject({ withdrawn: 0 });
    expect(removed).toEqual([]);
  });

  it('withdraws a copy whose stored object another excluded image shares', async () => {
    await copied(1);
    await holder.db.exec(
      `INSERT INTO "Image" ("id", "url", "blockedFor") VALUES (9, 'key-1', 'CSAM')`
    );
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('withdraws a copy the eligibility view no longer allows', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE test_eligibility SET ok = false`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
    expect((await ledger())[0].withdrawReason).toBe('ineligible');
  });

  it('withdraws a copy whose image row was deleted, though the item went with it', async () => {
    await copied(1);
    await holder.db.exec(`DELETE FROM "Image" WHERE id = 1`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
    expect((await ledger())[0].withdrawReason).toBe('gone');
  });

  it('is idempotent: a withdrawn copy is never deleted again, and never re-copied', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = NULL`);
    const put = vi.fn(async () => undefined);
    await copyScanLabelImages({ store: { put } });
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps a failed withdrawal pending and retries it', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    const failing = {
      remove: async () => {
        throw new Error('b2 down');
      },
    };
    expect(await sweepScanLabelCopies({ store: failing })).toMatchObject({ failed: 1 });
    expect(await item(1)).toMatchObject({ copyState: 'copied' });
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('still withdraws excluded copies when the eligibility view is missing', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    await holder.db.exec(`DROP VIEW "ScanLabelCopyEligibility"`);
    try {
      const { removed, store } = removing();
      expect(await sweepScanLabelCopies({ store })).toMatchObject({
        eligibilityRead: false,
        withdrawn: 1,
      });
      expect(removed).toEqual(['1/key-1']);
    } finally {
      await holder.db.exec(STAND_IN_VIEW);
    }
  });

  it('withdraws a failed copy for good, so it is never retried once it no longer qualifies', async () => {
    await holder.db.query(`INSERT INTO "Image" ("id", "url") VALUES (1, 'key-1')`);
    await holder.db.query(
      `INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt", "status", "votes", "outcome", "decidedAt")
       VALUES (1, 1, now(), 'decided', 3, 'clear', now())`
    );
    await holder.db.query(`INSERT INTO test_eligibility VALUES (1, true)`);
    const failingPut = {
      put: async () => {
        throw new Error('b2 down');
      },
    };
    await copyScanLabelImages({ store: failingPut });
    await holder.db.exec(`UPDATE test_eligibility SET ok = false`);
    const { store } = removing();
    await sweepScanLabelCopies({ store });
    expect(await item(1)).toEqual({ copyState: 'withdrawn', copyKey: null });
    await holder.db.exec(`UPDATE test_eligibility SET ok = true`);
    const put = vi.fn(async () => undefined);
    await copyScanLabelImages({ store: { put } });
    expect(put).not.toHaveBeenCalled();
  });

  it('re-arms a ledger row a sweep withdrew while its upload was in flight', async () => {
    await holder.db.query(`INSERT INTO "Image" ("id", "url") VALUES (1, 'key-1')`);
    await holder.db.query(
      `INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt", "status", "votes", "outcome", "decidedAt")
       VALUES (1, 1, now(), 'decided', 3, 'clear', now())`
    );
    await holder.db.query(`INSERT INTO test_eligibility VALUES (1, true)`);
    await copyScanLabelImages({
      store: {
        put: async () => {
          await holder.db.exec(
            `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'ineligible'`
          );
        },
      },
    });
    expect(await ledger()).toEqual([{ key: '1/key-1', withdrawReason: null }]);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('keeps a copy tracked when its upload lands after the delete and before the withdrawal mark', async () => {
    // The copy job has ledgered the key and is uploading; the image becomes excluded meanwhile.
    await holder.db.query(
      `INSERT INTO "Image" ("id", "url", "needsReview") VALUES (1, 'key-1', 'csam')`
    );
    await holder.db.query(
      `INSERT INTO "ScanLabelItem" ("id", "imageId", "firstFlaggedAt", "status", "votes", "outcome", "decidedAt")
       VALUES (1, 1, now(), 'decided', 3, 'clear', now())`
    );
    await holder.db.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('1/key-1', 1, 1)`
    );
    const removed: string[] = [];
    // remove() finds nothing; the upload then lands and runs the copy job's own bookkeeping.
    const racing = {
      remove: async (key: string) => {
        removed.push(key);
        await holder.db.exec(
          `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = NULL, "withdrawReason" = NULL WHERE key = '1/key-1'`
        );
        await holder.db.exec(
          `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = '1/key-1' WHERE id = 1`
        );
      },
    };
    await sweepScanLabelCopies({ store: racing });
    expect(await ledger()).toEqual([{ key: '1/key-1', withdrawReason: null }]);

    const { removed: second, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(second).toEqual(['1/key-1']);
    expect((await ledger())[0].withdrawReason).toBe('excluded');
    expect(removed).toEqual(['1/key-1']);
  });

  it('retries a failed withdrawal of a copy whose item is gone', async () => {
    await copied(1);
    await holder.db.exec(`DELETE FROM "Image" WHERE id = 1`);
    const failing = {
      remove: async () => {
        throw new Error('b2 down');
      },
    };
    await sweepScanLabelCopies({ store: failing });
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('deletes once when two sweeps run at the same time', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const { removed, store } = removing();
    await Promise.all([sweepScanLabelCopies({ store }), sweepScanLabelCopies({ store })]);
    expect(removed).toEqual(['1/key-1']);
  });

  it('revives a withdrawn row whose item was copied again under the same key', async () => {
    await copied(1);
    await holder.db.exec(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'excluded'`
    );
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('ledgers and withdraws a copy recorded only on its item', async () => {
    await copied(1);
    await holder.db.exec(`DELETE FROM "ScanLabelCopyObject"`);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('finishes a delete whose sweep died after claiming it, once the claim is an hour old', async () => {
    // A sweep claimed the row, then died before remove() finished; the item no longer holds the key.
    await copied(1);
    await holder.db.exec(`UPDATE "ScanLabelItem" SET "copyKey" = NULL, "copyState" = 'failed'`);
    await holder.db.exec(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now() - interval '2 hours', "withdrawReason" = 'excluded'`
    );
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
    const { rows } = await holder.db.query<{ removedAt: Date | null }>(
      `SELECT "removedAt" FROM "ScanLabelCopyObject"`
    );
    expect(rows[0].removedAt).not.toBeNull();
  });

  it('re-takes a claim on a row a late upload re-armed after it was stamped removed', async () => {
    // A late upload re-armed this row after an earlier sweep stamped it removed: live, but stamped.
    await copied(1);
    await holder.db.exec(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = NULL, "removedAt" = now() - interval '3 hours'`
    );
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    // The next sweep claims it and dies inside remove(); capture the row as that death leaves it.
    let atDeath: { removedAt: Date | null; withdrawReason: string | null } | undefined;
    const dying = {
      remove: async () => {
        atDeath = (
          await holder.db.query<{ removedAt: Date | null; withdrawReason: string | null }>(
            `SELECT "removedAt", "withdrawReason" FROM "ScanLabelCopyObject"`
          )
        ).rows[0];
      },
    };
    await sweepScanLabelCopies({ store: dying });
    await holder.db.query(
      `UPDATE "ScanLabelCopyObject"
       SET "withdrawnAt" = now() - interval '2 hours', "removedAt" = $1, "withdrawReason" = $2`,
      [atDeath!.removedAt, atDeath!.withdrawReason]
    );
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('does not stamp removed a row a late upload re-armed during the delete', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const rearming = {
      remove: async () => {
        await holder.db.exec(
          `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = NULL, "withdrawReason" = NULL, "removedAt" = NULL`
        );
      },
    };
    await sweepScanLabelCopies({ store: rearming });
    const { rows } = await holder.db.query<{ removedAt: Date | null }>(
      `SELECT "removedAt" FROM "ScanLabelCopyObject"`
    );
    expect(rows[0].removedAt).toBeNull();
  });

  it('leaves a fresh claim to the sweep that holds it', async () => {
    await copied(1);
    await holder.db.exec(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now() - interval '10 minutes', "withdrawReason" = 'excluded'`
    );
    await holder.db.exec(`UPDATE "ScanLabelItem" SET "copyKey" = NULL`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual([]);
  });

  it('never deletes a finished withdrawal again, however old', async () => {
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam'`);
    const { removed, store } = removing();
    await sweepScanLabelCopies({ store });
    await holder.db.exec(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now() - interval '2 hours'`
    );
    await sweepScanLabelCopies({ store });
    expect(removed).toEqual(['1/key-1']);
  });

  it('runs safely with nothing copied', async () => {
    const { removed, store } = removing();
    expect(await sweepScanLabelCopies({ store })).toMatchObject({ withdrawn: 0, failed: 0 });
    expect(removed).toEqual([]);
  });

  it('does nothing, with one warning, without the delete key', async () => {
    setEnv({ SCAN_LABEL_P3_B2_DELETE_ACCESS_KEY: undefined });
    expect(scanLabelSweepStoreFromEnv()).toBeNull();
    await copied(1);
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`);
    vi.mocked(loggingMock.logToAxiom).mockClear();
    expect(await sweepScanLabelCopies()).toEqual({ configured: false });
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect((await ledger())[0].withdrawReason).toBeNull();
  });
});

describe('createScanLabelSweepStore', () => {
  const fakeClient = (versions: { Key: string; VersionId: string }[][]) => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    let page = 0;
    return {
      sent,
      client: {
        send: vi.fn(
          async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
            sent.push({ name: cmd.constructor.name, input: cmd.input });
            if (cmd instanceof ListObjectVersionsCommand) {
              const current = versions[page] ?? [];
              page++;
              return {
                Versions: current,
                IsTruncated: page < versions.length,
                NextKeyMarker: 'k',
                NextVersionIdMarker: 'v',
              };
            }
            return {};
          }
        ),
      },
    };
  };

  it('deletes every version of exactly the key, by version id, and nothing sharing its prefix', async () => {
    const { client, sent } = fakeClient([
      [
        { Key: '1/key-1', VersionId: 'a' },
        { Key: '1/key-10', VersionId: 'b' },
      ],
      [{ Key: '1/key-1', VersionId: 'c' }],
    ]);
    await createScanLabelSweepStore({ client: client as never, bucket: 'b' }).remove('1/key-1');
    const deletes = sent.filter((s) => s.name === DeleteObjectCommand.name).map((s) => s.input);
    expect(deletes).toEqual([
      { Bucket: 'b', Key: '1/key-1', VersionId: 'a' },
      { Bucket: 'b', Key: '1/key-1', VersionId: 'c' },
    ]);
  });

  it('treats an already-deleted object as removed', async () => {
    const { client, sent } = fakeClient([[]]);
    await createScanLabelSweepStore({ client: client as never, bucket: 'b' }).remove('1/key-1');
    expect(sent.map((s) => s.name)).toEqual([ListObjectVersionsCommand.name]);
  });
});
