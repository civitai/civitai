import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { logToAxiom } from '~/server/logging/client';
import {
  MAX_ATTEMPTS,
  STALE_BUILD_HOURS,
  claimNextExport,
  legalRefusalLines,
  recordFailure,
  recoverStaleExports,
  runPersonalDataExports,
  type ExportDeps,
} from '../personal-data-export.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** The queue's state changes, each statement run against Postgres with the real migration. */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261225120000_personal_data_export/migration.sql'
);
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
});
afterAll(() => db?.close());

const run = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
  // A tagged-template call passes the strings array; `$queryRaw(Prisma.sql…)` passes a Sql object.
  const q = Array.isArray(strings)
    ? Prisma.sql(strings as TemplateStringsArray, ...values)
    : (strings as Prisma.Sql);
  return db.query(q.text, q.values as unknown[]);
};

/** The export ids of every alert raised: `alert: true` is what the Axiom monitor matches. */
const alerted = () =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([e]) => e.details as { alert?: boolean; exportId?: number } | undefined)
    .filter((d) => d?.alert === true)
    .map((d) => d?.exportId);

beforeEach(async () => {
  vi.mocked(logToAxiom).mockClear();
  await db.exec(`DELETE FROM "PersonalDataExport"`);
  vi.mocked(dbMock.dbWrite.$queryRaw)
    .mockReset()
    .mockImplementation(
      (async (s: TemplateStringsArray | Prisma.Sql, ...v: unknown[]) =>
        (await run(s, ...v)).rows) as never
    );
  vi.mocked(dbMock.dbWrite.$executeRaw)
    .mockReset()
    .mockImplementation(
      (async (s: TemplateStringsArray | Prisma.Sql, ...v: unknown[]) =>
        (await run(s, ...v)).affectedRows ?? 0) as never
    );
});

const insert = (id: number, userId: number, status: string, attempts = 0, startedAt?: Date) =>
  db.query(
    `INSERT INTO "PersonalDataExport" (id, "userId", "requestedById", status, attempts, "startedAt")
     VALUES ($1, $2, 9, $3, $4, $5)`,
    [id, userId, status, attempts, startedAt ?? null]
  );
const rowOf = async (id: number) =>
  (
    await db.query<{ status: string; attempts: number; error: string | null }>(
      `SELECT status, attempts, error FROM "PersonalDataExport" WHERE id = $1`,
      [id]
    )
  ).rows[0];
const longAgo = () => new Date(Date.now() - (STALE_BUILD_HOURS + 1) * 60 * 60 * 1000);

describe('export queue lifecycle, run', () => {
  it('claims the oldest queued export as building with one more attempt, then nothing', async () => {
    await insert(2, 20, 'queued');
    await insert(1, 10, 'queued');
    const first = await claimNextExport();
    expect(first).toMatchObject({ id: 1, status: 'building', attempts: 1 });
    expect(await claimNextExport()).toMatchObject({ id: 2 });
    expect(await claimNextExport()).toBeNull();
  });

  it("carries the stored request date and ticket into Legal's notice, not the queue date", async () => {
    await db.query(
      `INSERT INTO "PersonalDataExport" (id, "userId", "requestedById", status, "ticketId", "requestedAt")
       VALUES (1, 10, 9, 'queued', 555, '2026-09-14'), (2, 20, 9, 'queued', NULL, NULL)`
    );
    const ticketed = (await claimNextExport())!;
    expect(ticketed).toMatchObject({ ticketId: 555, requestedAt: '2026-09-14' });
    expect(legalRefusalLines(ticketed).lines).toEqual([
      'user=10',
      'ticket=555',
      'requested=2026-09-14',
    ]);
    expect(legalRefusalLines((await claimNextExport())!).lines).toEqual([
      'user=20',
      'ticket=none',
      'requested=unknown',
    ]);
  });

  it('requeues a stale build below the attempt limit, and fails it at the limit', async () => {
    await insert(1, 10, 'building', 1, longAgo());
    await insert(2, 20, 'building', MAX_ATTEMPTS, longAgo());
    await insert(3, 30, 'building', 1, new Date()); // fresh: left alone
    expect(await recoverStaleExports()).toBe(2);
    expect(await rowOf(1)).toMatchObject({ status: 'queued', error: 'build abandoned' });
    expect(await rowOf(2)).toMatchObject({ status: 'failed' });
    expect(await rowOf(3)).toMatchObject({ status: 'building' });
    // Only the one that reached failed raises the alert.
    expect(alerted()).toEqual([2]);
  });

  /**
   * A request that ends failed is on a response deadline. Every path to `failed` raises an
   * error-level alert naming the export, the same shape as the Legal notice's, so one monitor sees both.
   */
  it('fails an export after its last attempt with the error on the row, and alerts once', async () => {
    await insert(1, 10, 'queued');
    const tick = () =>
      runPersonalDataExports({
        resolveDeps: async () => ({} as ExportDeps),
        build: async () => {
          throw new Error('pg read failed mid-stream');
        },
      });
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await tick();
      expect(await rowOf(1)).toMatchObject({ status: 'queued', attempts: attempt });
    }
    expect(alerted()).toEqual([]);
    await tick();
    expect(await rowOf(1)).toEqual({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      error: 'build failed',
    });
    expect(alerted()).toEqual([1]);
    // The read's own error is in the alert, never on the row moderators read.
    expect(JSON.stringify(vi.mocked(logToAxiom).mock.calls)).toContain('pg read failed mid-stream');
    // Nothing is left to claim, and no later tick alerts again.
    await tick();
    expect(alerted()).toEqual([1]);
  });

  /** Ruled by the Moderation Lead: moderators read the row, so it carries fixed text only. */
  it("keeps a build error's text off the row, and puts it in the log", async () => {
    const marker = 'ERR-MARKER-7 owner@corp.example';
    await insert(1, 10, 'queued');
    await runPersonalDataExports({
      resolveDeps: async () => ({} as ExportDeps),
      build: async () => {
        throw new Error(marker);
      },
    });
    expect(await rowOf(1)).toEqual({ status: 'queued', attempts: 1, error: 'build failed' });
    expect(JSON.stringify(vi.mocked(logToAxiom).mock.calls)).toContain(marker);
  });

  it('raises no alert when the attempt that reached the limit no longer owns the row', async () => {
    await insert(1, 10, 'building', MAX_ATTEMPTS + 1);
    expect(await recordFailure({ id: 1, attempts: MAX_ATTEMPTS }, 'build failed')).toBe('failed');
    expect(await rowOf(1)).toMatchObject({ status: 'building' });
    expect(alerted()).toEqual([]);
  });

  it('leaves a row alone once a later attempt owns it', async () => {
    await insert(1, 10, 'building', 1, longAgo());
    await recoverStaleExports(); // attempt 1 abandoned: back to queued
    const second = await claimNextExport(); // attempt 2 takes it
    expect(second).toMatchObject({ id: 1, attempts: 2, status: 'building' });
    // Attempt 1 finally finishes and records its failure: it must not touch attempt 2's row.
    expect(await recordFailure({ id: 1, attempts: 1 }, 'build failed')).toBe('queued');
    expect(await rowOf(1)).toMatchObject({ status: 'building', attempts: 2 });
  });

  /**
   * Deliberate: a resolveDeps() that throws (the Mongo client refusing its URL, say) is logged by
   * name and code only, never by message: a driver parse error can quote the connection string,
   * which carries credentials. Do not "improve" this to errorMessage(e).
   */
  it('logs a deps failure and skips the tick instead of throwing, without echoing the message', async () => {
    await insert(1, 10, 'queued');
    const secret = 'mongodb+srv://reader:hunter2@cluster0.example.net/prod';
    const result = await runPersonalDataExports({
      resolveDeps: async () => {
        throw Object.assign(new Error(`bad url ${secret}`), { name: 'MongoParseError', code: 42 });
      },
    });
    expect(result).toEqual({ built: 0, skipped: 'deps-failed' });
    const logged = JSON.stringify(vi.mocked(logToAxiom).mock.calls);
    expect(logged).toContain('deps failed, 1 export(s) waiting: MongoParseError');
    expect(logged).not.toContain('hunter2');
    expect(await rowOf(1)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('never leaves a row building when the build itself throws', async () => {
    await insert(1, 10, 'queued');
    const deps = {} as ExportDeps;
    await runPersonalDataExports({
      resolveDeps: async () => deps,
      build: async () => {
        throw new Error('unexpected');
      },
    });
    expect(await rowOf(1)).toMatchObject({ status: 'queued', attempts: 1, error: 'build failed' });
  });
});
