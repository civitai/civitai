import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArchiveModule from '../archive';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The release claim is one UPDATE that must refuse in the same statement when a hold lands between
 * the check and the claim. It runs here against Postgres, not as a string.
 */

const m = vi.hoisted(() => ({
  readySend: vi.fn(),
  refusedSend: vi.fn(),
  heldSend: vi.fn(),
  del: vi.fn(),
  accountHeld: false,
}));
vi.mock('~/server/services/legal-hold.service', async () => {
  const { Prisma: P } = await import('@prisma/client');
  return {
    getAccountLegalHold: async () => ({ legs: [], markerView: true }),
    // The account-hold clause of the claim, as SQL the claim runs: held or not, per test.
    accountHoldSql: () => (m.accountHeld ? P.sql`true` : P.sql`false`),
  };
});
vi.mock('~/server/email/templates/personalDataExport.email', () => ({
  personalDataExportReadyEmail: { send: m.readySend },
  personalDataExportBuiltEmail: { send: vi.fn() },
  personalDataExportRefusedEmail: { send: m.refusedSend },
  personalDataExportHeldEmail: { send: m.heldSend },
}));
vi.mock('../archive', async (importOriginal) => ({
  ...(await importOriginal<typeof ArchiveModule>()),
  deleteObjects: m.del,
}));

import { logToAxiom } from '~/server/logging/client';
import {
  LEGAL_NOTICE_ALERT_AFTER,
  exportHoldReasons,
  releaseExport,
  retryLegalNotices,
} from '../personal-data-export.service';

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261225120000_personal_data_export/migration.sql'
);
const OWNER = 42;
const builtAt = new Date('2026-11-06T00:00:00Z');
const now = new Date('2026-11-07T00:00:00Z');
const bucket = {
  client: new S3Client({
    region: 'r',
    endpoint: 'https://s3.example.com',
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
  }),
  Bucket: 'b',
};
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Both migrations, in the order they are applied.
  for (const f of [
    MIGRATION,
    MIGRATION.replace(
      '20261225120000_personal_data_export',
      '20261228120000_personal_data_export_request'
    ),
  ])
    await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "blockedFor" text, "needsReview" text,
      minor boolean DEFAULT false, ingestion text DEFAULT 'Scanned');
    CREATE TABLE "CsamReport" (id int, "userId" int, images jsonb);
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text, status text);
    CREATE TABLE "UserReport" ("reportId" int, "userId" int);
  `);
});
afterAll(() => db?.close());

beforeEach(async () => {
  m.readySend.mockReset().mockResolvedValue(undefined);
  m.refusedSend.mockReset().mockResolvedValue(undefined);
  m.heldSend.mockReset().mockResolvedValue(undefined);
  m.del.mockReset().mockResolvedValue(undefined);
  m.accountHeld = false;
  await db.exec(
    `DELETE FROM "Image"; DELETE FROM "Report"; DELETE FROM "UserReport"; DELETE FROM "PersonalDataExport";`
  );
  await db.query(
    `INSERT INTO "PersonalDataExport" (id, "userId", "requestedById", status, "archiveKey", "builtAt")
     VALUES (5, $1, 9, 'built', 'exports/5/k.zip', $2)`,
    [OWNER, builtAt]
  );
  vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockResolvedValue({
    id: 5,
    userId: OWNER,
    status: 'built',
    archiveKey: 'exports/5/k.zip',
    builtAt,
  } as never);
  vi.mocked(dbMock.dbWrite.user.findUnique).mockResolvedValue({
    email: 'owner@example.com',
    username: 'owner',
    deletedAt: null,
  } as never);
  // The check before the claim saw nothing: what the claim itself finds decides.
  vi.mocked(dbMock.dbWrite.$queryRaw)
    .mockReset()
    .mockResolvedValue([{ present: false, review: false }] as never);
  // Every raw write runs, for real, against Postgres.
  vi.mocked(dbMock.dbWrite.$executeRaw)
    .mockReset()
    .mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      return (await db.query(q.text, q.values as unknown[])).affectedRows ?? 0;
    }) as never);
});

const status = async () =>
  (
    (await db.query<{ status: string }>(`SELECT status FROM "PersonalDataExport" WHERE id = 5`))
      .rows[0] ?? { status: '' }
  ).status;

const caseAbout = async (userId: number, id: number, reason: string, state: string) => {
  await db.query(`INSERT INTO "Report" (id, reason, status) VALUES ($1, $2, $3)`, [
    id,
    reason,
    state,
  ]);
  await db.query(`INSERT INTO "UserReport" ("reportId", "userId") VALUES ($1, $2)`, [id, userId]);
};

describe('hold check, run', () => {
  // The check reads Postgres for real here, so the SQL itself decides.
  beforeEach(() => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (q: Prisma.Sql) => {
      return (await db.query(q.text, q.values as unknown[])).rows;
    }) as never);
  });

  it.each([
    ['CSAM', 'Actioned'],
    ['CSAM', 'Unactioned'],
    ['Automated', 'Actioned'],
    ['Automated', 'Unactioned'],
  ])(
    'puts the account under a hold for a decided case of a held kind (#%#)',
    async (reason, state) => {
      await caseAbout(OWNER, 1, reason, state);
      expect((await exportHoldReasons(OWNER)).legs).toEqual(['review']);
    }
  );

  it('puts no hold for an undecided case, another kind, or another account', async () => {
    await caseAbout(OWNER, 1, 'CSAM', 'Pending');
    await caseAbout(OWNER, 2, 'Automated', 'Processing');
    await caseAbout(OWNER, 3, 'Spam', 'Actioned');
    await caseAbout(OWNER + 1, 4, 'CSAM', 'Actioned');
    expect((await exportHoldReasons(OWNER)).legs).toEqual([]);
  });
});

describe('release claim, run', () => {
  it('claims nothing, and sends nothing, when the account is under a hold', async () => {
    await db.exec(`INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (1, ${OWNER}, 'CSAM')`);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(m.readySend).not.toHaveBeenCalled();
    expect(await status()).toBe('built');
  });

  it('claims and sends for an account under no hold (control)', async () => {
    await db.exec(`INSERT INTO "Image" (id, "userId") VALUES (1, ${OWNER})`);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toMatchObject({
      ok: true,
    });
    expect(m.readySend).toHaveBeenCalledTimes(1);
    expect(await status()).toBe('released');
  });

  it('claims nothing, and sends nothing, when an account hold lands before the claim', async () => {
    await db.exec(`INSERT INTO "Image" (id, "userId") VALUES (1, ${OWNER})`);
    m.accountHeld = true;
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(m.readySend).not.toHaveBeenCalled();
    expect(await status()).toBe('built');
  });

  it('claims nothing, and sends nothing, when a decided case puts the account under a hold', async () => {
    await caseAbout(OWNER, 1, 'CSAM', 'Actioned');
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(m.readySend).not.toHaveBeenCalled();
    expect(await status()).toBe('built');
  });

  it('claims past a case that puts no hold on the account (control)', async () => {
    await caseAbout(OWNER, 1, 'CSAM', 'Pending');
    await caseAbout(OWNER, 2, 'Spam', 'Actioned');
    await caseAbout(OWNER + 1, 3, 'CSAM', 'Actioned');
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toMatchObject({
      ok: true,
    });
    expect(await status()).toBe('released');
  });

  /**
   * 🔴 Ruled by the Moderation Lead: a hold found at RELEASE is refused exactly like one found at
   * build time. The built archive and notes objects are deleted, Legal gets ONE notice, the row stays
   * (held, both keys NULL), and nothing else the account owns is touched.
   */
  describe('a hold that appears after the build', () => {
    const sources = async () =>
      JSON.stringify(
        await Promise.all(
          ['Image', 'Report', 'UserReport'].map(
            async (t) => (await db.query(`SELECT * FROM "${t}" ORDER BY 1`)).rows
          )
        )
      );

    beforeEach(async () => {
      await db.exec(
        `UPDATE "PersonalDataExport" SET "modNotesKey" = 'exports/5/n-internal-notes.csv',
           "ticketId" = 555, "requestedAt" = '2026-09-14' WHERE id = 5;
         INSERT INTO "Image" (id, "userId") VALUES (1, ${OWNER}), (2, ${OWNER});`
      );
      await caseAbout(OWNER, 1, 'CSAM', 'Actioned');
      // The hold check, the Legal retry and both row reads run against Postgres.
      vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
        first: Prisma.Sql | TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const q = Array.isArray(first)
          ? Prisma.sql(first as TemplateStringsArray, ...values)
          : (first as Prisma.Sql);
        return (await db.query(q.text, q.values as unknown[])).rows;
      }) as never);
      vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockImplementation((async () => {
        const { rows } = await db.query(`SELECT * FROM "PersonalDataExport" WHERE id = 5`);
        return rows[0] ?? null;
      }) as never);
    });

    it('refuses: one Legal notice, both objects deleted, the row kept with its keys cleared', async () => {
      const before = await sources();
      expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
        ok: false,
        reason: 'held',
      });
      expect(m.readySend).not.toHaveBeenCalled();
      expect(m.refusedSend.mock.calls).toEqual([
        [
          {
            to: 'compliance@civitai.com',
            subject: 'DATA-EXPORT-REFUSED user=42 ticket=555 requested=2026-09-14',
            lines: ['user=42', 'ticket=555', 'requested=2026-09-14'],
          },
        ],
      ]);
      expect(m.heldSend.mock.calls).toEqual([[{ to: 'owner@example.com', exportId: 5 }]]);
      expect(m.del.mock.calls).toEqual([
        [bucket, ['exports/5/k.zip', 'exports/5/n-internal-notes.csv']],
      ]);
      const { rows } = await db.query(
        `SELECT status, "archiveKey", "modNotesKey", "holdReasons" FROM "PersonalDataExport" WHERE id = 5`
      );
      expect(rows).toEqual([
        { status: 'held', archiveKey: null, modNotesKey: null, holdReasons: ['review'] },
      ]);
      // Only the export's own objects go: every source row is exactly as it was.
      expect(await sources()).toBe(before);
    });

    /**
     * 🔴 Ruled by the Moderation Lead: a refusal's Legal notice is never lost. If the send fails, the
     * copy is still deleted and the row still kept, the requester gets the same notice, and later
     * ticks resend until one lands, then never again.
     */
    it('retries a failed Legal notice on later ticks until it lands, then sends no more', async () => {
      m.refusedSend.mockRejectedValueOnce(new Error('smtp down'));
      expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
        ok: false,
        reason: 'held',
      });
      // Nothing waited on the email.
      expect(m.del).toHaveBeenCalledTimes(1);
      const held = async () =>
        (
          await db.query<{ status: string; archiveKey: string | null; error: string | null }>(
            `SELECT status, "archiveKey", error FROM "PersonalDataExport" WHERE id = 5`
          )
        ).rows[0];
      expect(await held()).toEqual({
        status: 'held',
        archiveKey: null,
        error: 'legal notice failed (1)',
      });
      // The requester's notice is the same either way, and goes once.
      expect(m.heldSend.mock.calls).toEqual([[{ to: 'owner@example.com', exportId: 5 }]]);

      expect(await retryLegalNotices()).toEqual({ owed: 1, sent: 1 });
      expect(m.refusedSend).toHaveBeenCalledTimes(2);
      expect(m.refusedSend.mock.calls[1][0]).toMatchObject({
        subject: 'DATA-EXPORT-REFUSED user=42 ticket=555 requested=2026-09-14',
      });
      expect((await held()).error).toBeNull();

      expect(await retryLegalNotices()).toEqual({ owed: 0, sent: 0 });
      expect(m.refusedSend).toHaveBeenCalledTimes(2);
      expect(m.heldSend).toHaveBeenCalledTimes(1);
    });

    it(`raises an alert naming the export once ${LEGAL_NOTICE_ALERT_AFTER} sends have failed`, async () => {
      m.refusedSend.mockRejectedValue(new Error('smtp down'));
      await releaseExport({ exportId: 5, actorId: 9, bucket, now });
      const alerts = () =>
        vi
          .mocked(logToAxiom)
          .mock.calls.filter(([e]) => (e.details as { alert?: boolean } | undefined)?.alert);
      vi.mocked(logToAxiom).mockClear();
      for (let tick = 2; tick < LEGAL_NOTICE_ALERT_AFTER; tick++) await retryLegalNotices();
      expect(alerts()).toEqual([]);
      await retryLegalNotices();
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0][0]).toMatchObject({
        type: 'error',
        details: { exportId: 5, failures: LEGAL_NOTICE_ALERT_AFTER },
      });
      // Still owed: it keeps being retried, not dropped.
      expect(await retryLegalNotices()).toEqual({ owed: 1, sent: 0 });
    });

    /** Ruled by the Moderation Lead: moderators read the row, and a mail error can carry addresses. */
    it("keeps a failed send's error off the row, and puts it in the log", async () => {
      const raw = '550 rejected: intake-owner@corp.example via relay-7.provider.example';
      m.refusedSend.mockRejectedValue(new Error(raw));
      await releaseExport({ exportId: 5, actorId: 9, bucket, now });
      await retryLegalNotices();
      const { rows } = await db.query<{ error: string }>(
        `SELECT error FROM "PersonalDataExport" WHERE id = 5`
      );
      expect(rows[0].error).toBe('legal notice failed (2)');
      const logged = vi
        .mocked(logToAxiom)
        .mock.calls.filter(
          ([e]) => (e.details as { exportId?: number } | undefined)?.exportId === 5
        )
        .map(([e]) => (e.details as { error?: string }).error);
      expect(logged).toContain(raw);
    });

    it('marks the notice owed on the row before sending it, so a crash cannot lose it', async () => {
      let atSend: string | null | undefined;
      m.refusedSend.mockImplementation(async () => {
        atSend = (
          await db.query<{ error: string | null }>(
            `SELECT error FROM "PersonalDataExport" WHERE id = 5`
          )
        ).rows[0].error;
      });
      await releaseExport({ exportId: 5, actorId: 9, bucket, now });
      expect(atSend).toBe('legal notice pending');
    });

    it('resends a notice a crash left pending before it was sent', async () => {
      await db.exec(
        `UPDATE "PersonalDataExport" SET status = 'held', "archiveKey" = NULL,
           error = 'legal notice pending' WHERE id = 5`
      );
      expect(await retryLegalNotices()).toEqual({ owed: 1, sent: 1 });
      expect(m.refusedSend).toHaveBeenCalledTimes(1);
    });

    it('sends Legal no second notice on another press, or when two presses race', async () => {
      await Promise.all([
        releaseExport({ exportId: 5, actorId: 9, bucket, now }),
        releaseExport({ exportId: 5, actorId: 9, bucket, now }),
      ]);
      await releaseExport({ exportId: 5, actorId: 9, bucket, now });
      expect(m.refusedSend).toHaveBeenCalledTimes(1);
      expect(m.del).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the release email fails', () => {
    const row = async () =>
      (
        await db.query<{
          status: string;
          releasedAt: Date | null;
          releasedById: number | null;
          error: string | null;
        }>(
          `SELECT status, "releasedAt", "releasedById", error FROM "PersonalDataExport" WHERE id = 5`
        )
      ).rows[0];

    it('puts the export back to built, with the mail error in the log and not on the row', async () => {
      const raw = '550 mailbox owner@example.com unavailable at mx.provider.example';
      m.readySend.mockRejectedValue(new Error(raw));
      await expect(releaseExport({ exportId: 5, actorId: 9, bucket, now })).rejects.toThrow(raw);
      expect(await row()).toEqual({
        status: 'built',
        releasedAt: null,
        releasedById: null,
        error: 'release email failed',
      });
      expect(
        vi.mocked(logToAxiom).mock.calls.map(([e]) => (e.details as { error?: string })?.error)
      ).toContain(raw);
    });

    it('leaves the row alone when something else moved it while the email was sending', async () => {
      m.readySend.mockImplementation(async () => {
        await db.exec(
          `UPDATE "PersonalDataExport" SET status = 'held', "releasedAt" = NULL, "releasedById" = NULL
           WHERE id = 5`
        );
        throw new Error('smtp');
      });
      await expect(releaseExport({ exportId: 5, actorId: 9, bucket, now })).rejects.toThrow('smtp');
      expect(await row()).toEqual({
        status: 'held',
        releasedAt: null,
        releasedById: null,
        error: null,
      });
    });
  });

  it('clears the error a failed earlier release left on the row', async () => {
    await db.exec(
      `UPDATE "PersonalDataExport" SET error = 'release email failed: smtp' WHERE id = 5`
    );
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toMatchObject({
      ok: true,
    });
    const { rows } = await db.query<{ error: string | null }>(
      `SELECT error FROM "PersonalDataExport" WHERE id = 5`
    );
    expect(rows[0].error).toBeNull();
  });
});
