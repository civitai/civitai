import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fromDb,
  hibernationSql,
  toUsage,
  type DbRow,
  type HibernationRow,
  type UsageDbRow,
} from '~/server/services/app-hibernation/hibernation.repo';

/**
 * The repo's statements against the REAL hand-applied migration, on an in-process Postgres:
 * the migration applies (twice: it is idempotent), the upsert replaces the user's row for an app,
 * usage leaves the named app out, and the CHECKs refuse what the service must never write.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20271112130000_app_sandbox_hibernations/migration.sql'
);

let db: PGlite;
const run = async <T>(sql: Prisma.Sql) =>
  (await db.query<T>(sql.text, sql.values as unknown[])).rows;

beforeAll(async () => {
  db = new PGlite();
  const ddl = readFileSync(MIGRATION, 'utf8');
  await db.exec(ddl);
  await db.exec(ddl);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec('TRUNCATE "app_sandbox_hibernations"');
});

const row = (over: Partial<HibernationRow> = {}): HibernationRow => ({
  userId: 9101,
  appKey: 'tip-calculator',
  attemptId: '55555555-5555-4555-8555-555555555555',
  objectKey: 'archives/9101/tip-calculator/55555555-5555-4555-8555-555555555555.zip',
  sha256: 'a'.repeat(64),
  bytes: 4_321,
  excluded: ['node_modules', 'dist'],
  secretsObjectKey: null,
  secretsSha256: null,
  secretsBytes: null,
  secretsWrappedKey: null,
  reason: 'cap',
  appCreatedAt: new Date('2026-10-01T00:00:00.000Z'),
  lastActivityAt: new Date('2026-11-01T00:00:00.000Z'),
  hibernatedAt: new Date('2026-11-12T00:00:00.000Z'),
  ...over,
});

const get = async (userId: number, appKey: string) =>
  (await run<DbRow>(hibernationSql.get(userId, appKey))).map(fromDb)[0] ?? null;

describe('app_sandbox_hibernations SQL', () => {
  it('inserts, then the upsert REPLACES the user’s row for that app (one row)', async () => {
    await run(hibernationSql.upsert(row()));
    const second = row({
      attemptId: '66666666-6666-4666-8666-666666666666',
      objectKey: 'archives/9101/tip-calculator/66666666-6666-4666-8666-666666666666.zip',
      sha256: 'b'.repeat(64),
      bytes: 9_876,
      secretsObjectKey: 'archives/9101/tip-calculator/66666666-6666-4666-8666-666666666666.secrets',
      secretsSha256: 'c'.repeat(64),
      secretsBytes: 77,
      secretsWrappedKey: 'v1.d3JhcHBlZA==',
    });
    await run(hibernationSql.upsert(second));

    expect(await get(9101, 'tip-calculator')).toEqual(second);
    expect(await run(hibernationSql.list(9101))).toHaveLength(1);
  });

  it('usage counts the user’s other apps and their bytes, leaving the named app out', async () => {
    await run(hibernationSql.upsert(row()));
    await run(
      hibernationSql.upsert(
        row({
          appKey: 'habit-tracker',
          objectKey: 'archives/9101/habit-tracker/x.zip',
          bytes: 1_000,
        })
      )
    );
    await run(
      hibernationSql.upsert(
        row({ userId: 9202, objectKey: 'archives/9202/tip-calculator/x.zip', bytes: 50 })
      )
    );
    expect(toUsage(await run<UsageDbRow>(hibernationSql.usage(9101, 'tip-calculator')))).toEqual({
      apps: 1,
      bytes: 1_000,
    });
    expect(toUsage(await run<UsageDbRow>(hibernationSql.usage(9101, 'none-such')))).toEqual({
      apps: 2,
      bytes: 5_321,
    });
  });

  it('removeAll deletes only that user’s rows and returns them', async () => {
    await run(hibernationSql.upsert(row()));
    await run(
      hibernationSql.upsert(row({ userId: 9202, objectKey: 'archives/9202/tip-calculator/x.zip' }))
    );
    const removed = (await run<DbRow>(hibernationSql.removeAll(9101))).map(fromDb);
    expect(removed.map((r) => r.objectKey)).toEqual([row().objectKey]);
    expect(await get(9202, 'tip-calculator')).not.toBeNull();
  });

  it('the CHECKs refuse a non-slug key, a non-hex sha and half-set secrets', async () => {
    await expect(run(hibernationSql.upsert(row({ appKey: 'Not A Slug' })))).rejects.toThrow(
      /app_key_check/
    );
    await expect(run(hibernationSql.upsert(row({ sha256: 'z'.repeat(64) })))).rejects.toThrow(
      /sha256_check/
    );
    await expect(
      run(
        hibernationSql.upsert(row({ secretsObjectKey: 'archives/9101/tip-calculator/x.secrets' }))
      )
    ).rejects.toThrow(/secrets_check/);
  });

  it('the per-user lock statement runs', async () => {
    await expect(run(hibernationSql.lock(9101))).resolves.toBeDefined();
  });
});
