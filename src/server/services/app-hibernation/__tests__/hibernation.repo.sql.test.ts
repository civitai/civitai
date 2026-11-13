import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHibernationRepo,
  type SqlQuery,
  type SqlRunner,
  fromDb,
  fromOldestDb,
  toAccountState,
  type AccountDbRow,
  hibernationSql,
  toUsage,
  type DbRow,
  type OldestDbRow,
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
beforeAll(async () => {
  // The two columns of the real "User" table the account-state statement reads.
  await db.exec(
    'CREATE TABLE "User" ("id" int PRIMARY KEY, "deletedAt" timestamp(3), "bannedAt" timestamp(3))'
  );
});
beforeEach(async () => {
  await db.exec('TRUNCATE "app_sandbox_hibernations", "User"');
  await db.exec(`INSERT INTO "User" ("id", "deletedAt", "bannedAt") VALUES
    (9101, NULL, NULL), (9202, now(), NULL), (9303, NULL, now())`);
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
    expect(toUsage(await run<UsageDbRow>(hibernationSql.usage(9101, 'none-such')))).toEqual({
      apps: 1,
      bytes: 9_876,
    });
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

  it('oldest is the earliest hibernated app of that user, ties by key, leaving out the named app', async () => {
    const at = (iso: string) => new Date(iso);
    const put = (appKey: string, iso: string, userId = 9101) =>
      run(
        hibernationSql.upsert(
          row({
            userId,
            appKey,
            objectKey: `archives/${userId}/${appKey}/x.zip`,
            hibernatedAt: at(iso),
          })
        )
      );
    await put('newest-app', '2026-11-10T00:00:00.000Z');
    await put('bbb-app', '2026-09-01T00:00:00.000Z');
    await put('aaa-app', '2026-09-01T00:00:00.000Z');
    await put('older-elsewhere', '2020-01-01T00:00:00.000Z', 9202);
    const oldest = async (exclude: string) =>
      (await run<OldestDbRow>(hibernationSql.oldest(9101, exclude))).map(fromOldestDb);

    expect(await oldest('none-such')).toEqual([
      { app: 'aaa-app', hibernatedAt: at('2026-09-01T00:00:00.000Z') },
    ]);
    expect(await oldest('aaa-app')).toEqual([
      { app: 'bbb-app', hibernatedAt: at('2026-09-01T00:00:00.000Z') },
    ]);
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

  it('lock(user) holds a transaction-scoped advisory lock keyed by that user, released at commit', async () => {
    const held = await db.transaction(async (tx) => {
      const sql = hibernationSql.lock(9101);
      await tx.query(sql.text, sql.values as unknown[]);
      const other = hibernationSql.lock(9202);
      await tx.query(other.text, other.values as unknown[]);
      return (await tx.query<{ classid: number; objid: number; granted: boolean }>(ADVISORY)).rows;
    });
    // Two different users: two different locks, both under the hibernation namespace.
    expect(held).toEqual([
      { classid: LOCK_NS, objid: 9101, granted: true },
      { classid: LOCK_NS, objid: 9202, granted: true },
    ]);
    expect((await db.query(ADVISORY)).rows).toEqual([]);
  });

  // Each row sets exactly some of the four secrets columns. Every partial combination must fail:
  // a bare comparison against a NULL column is NULL, and a CHECK that is NULL passes.
  it.each([
    ['object key only', { secretsObjectKey: 'archives/9101/t/a.secrets' }],
    [
      'all but the sha',
      {
        secretsObjectKey: 'archives/9101/t/a.secrets',
        secretsBytes: 5,
        secretsWrappedKey: 'v2.k1.x',
      },
    ],
    [
      'all but the bytes',
      {
        secretsObjectKey: 'archives/9101/t/a.secrets',
        secretsSha256: 'c'.repeat(64),
        secretsWrappedKey: 'v2.k1.x',
      },
    ],
    [
      'all but the wrapped key',
      {
        secretsObjectKey: 'archives/9101/t/a.secrets',
        secretsSha256: 'c'.repeat(64),
        secretsBytes: 5,
      },
    ],
    [
      'all but the object key',
      { secretsSha256: 'c'.repeat(64), secretsBytes: 5, secretsWrappedKey: 'v2.k1.x' },
    ],
  ])('refuses half-set secrets: %s', async (_label, over) => {
    await expect(run(hibernationSql.upsert(row(over)))).rejects.toThrow(/secrets_check/);
  });

  it('account state comes from the User row: active, deleted, banned or missing', async () => {
    const state = async (id: number, forShare: boolean) =>
      toAccountState(await run<AccountDbRow>(hibernationSql.accountState(id, forShare)));
    expect(await state(9101, false)).toBe('active');
    expect(await state(9202, false)).toBe('deleted');
    expect(await state(9303, true)).toBe('banned');
    expect(await state(9999, false)).toBe('missing');
  });

  it('referencedKeys names the archive and secrets keys a row records, and nothing else', async () => {
    await run(
      hibernationSql.upsert(
        row({
          secretsObjectKey: 'archives/9101/tip-calculator/s.kept.secrets',
          secretsSha256: 'c'.repeat(64),
          secretsBytes: 5,
          secretsWrappedKey: 'v2.k1.x',
        })
      )
    );
    const keys = [
      row().objectKey,
      'archives/9101/tip-calculator/s.kept.secrets',
      'archives/9101/x/unref.zip',
    ];
    const got = (await run<{ key: string }>(hibernationSql.referencedKeys(keys))).map((r) => r.key);
    expect(got.sort()).toEqual(
      [row().objectKey, 'archives/9101/tip-calculator/s.kept.secrets'].sort()
    );
  });

  it('deletedAccountsWithRows lists only deleted users that still have rows', async () => {
    await run(hibernationSql.upsert(row()));
    await run(
      hibernationSql.upsert(row({ userId: 9202, objectKey: 'archives/9202/tip-calculator/x.zip' }))
    );
    await run(
      hibernationSql.upsert(row({ userId: 9303, objectKey: 'archives/9303/tip-calculator/x.zip' }))
    );
    const ids = (await run<{ userId: number }>(hibernationSql.deletedAccountsWithRows(10))).map(
      (r) => r.userId
    );
    expect(ids).toEqual([9202]);
  });
});

// ---------------------------------------------------------------------------------------------
// The REAL `commit` transaction (`createHibernationRepo(...).commit`) on the same database.
//
// 🔴 What this can and cannot show. PGlite is ONE session, so two transactions never truly run
// at once (it queues them) and an advisory lock is re-entrant within a session: a second
// lock(9101) cannot be seen to BLOCK here. So the lock is shown by its effect inside the
// transaction (`pg_locks`, read in the same transaction while commit reads), and "limits hold
// across two commits" is shown for the serial order the lock guarantees, not by a race.
// ---------------------------------------------------------------------------------------------

const LOCK_NS = 0x48424e54;
/** A constant statement as a `Prisma.Sql` (no parameters). */
const rawSql = (text: string) => ({ text, values: [] } as unknown as Prisma.Sql);
const ADVISORY = `SELECT classid::int AS classid, objid::int AS objid, granted
  FROM pg_locks WHERE locktype = 'advisory' ORDER BY objid`;

/** PGlite as a SqlRunner; `onRead` sees every in-transaction statement, inside the transaction. */
function pgliteRunner(onRead?: (text: string, tx: SqlQuery) => Promise<void>): SqlRunner {
  return {
    query: async <R>(sql: Prisma.Sql) =>
      (await db.query<R>(sql.text, sql.values as unknown[])).rows,
    transaction: (fn) =>
      db.transaction(async (t) => {
        const tx: SqlQuery = async <R>(sql: Prisma.Sql) => {
          const rows = (await t.query<R>(sql.text, sql.values as unknown[])).rows;
          await onRead?.(
            sql.text,
            async <X>(q: Prisma.Sql) => (await t.query<X>(q.text, q.values as unknown[])).rows
          );
          return rows;
        };
        return fn(tx);
      }),
  };
}

describe('hibernationRepo.commit (the real transaction)', () => {
  it('reads the account in the transaction: a deleted account is decided as deleted and gets no row', async () => {
    const repo = createHibernationRepo(pgliteRunner());
    const seen: string[] = [];
    const commit = (userId: number) =>
      repo.commit(userId, 'tip-calculator', (_existing, _usage, account) => {
        seen.push(account);
        return account === 'active'
          ? {
              write: row({ userId, objectKey: `archives/${userId}/tip-calculator/a.kept.zip` }),
              result: 'written',
            }
          : { result: `refused ${account}` };
      });

    expect(await commit(9202)).toBe('refused deleted');
    expect(await commit(9303)).toBe('refused banned');
    expect(await commit(9101)).toBe('written');
    expect(seen).toEqual(['deleted', 'banned', 'active']);
    expect((await run<{ user_id: number }>(hibernationSql.removeAll(9202))).length).toBe(0);
    expect(await get(9101, 'tip-calculator')).not.toBeNull();
  });

  it('while it reads the row, the usage and the account, it holds the user’s advisory lock', async () => {
    const lockedDuringReads: { objid: number }[][] = [];
    const repo = createHibernationRepo(
      pgliteRunner(async (text, tx) => {
        if (/FROM "User"/.test(text) || /count\(\*\)/.test(text))
          lockedDuringReads.push(await tx<{ objid: number }>(rawSql(ADVISORY)));
      })
    );
    await repo.commit(9101, 'tip-calculator', () => ({ result: null }));
    expect(lockedDuringReads).toHaveLength(2);
    for (const held of lockedDuringReads)
      expect(held).toEqual([{ classid: LOCK_NS, objid: 9101, granted: true }]);
  });

  it('two commits for one user, run back to back as the lock orders them, share one limit', async () => {
    const repo = createHibernationRepo(pgliteRunner());
    // A plan of ONE sleeping app: whichever commit runs second must see the first's row.
    const commitApp = (appKey: string) =>
      repo.commit(9101, appKey, (existing, usage) =>
        !existing && usage.apps >= 1
          ? { result: 'limit' }
          : {
              write: row({ appKey, objectKey: `archives/9101/${appKey}/a.kept.zip` }),
              result: 'written',
            }
      );
    const results = await Promise.all([commitApp('first-app'), commitApp('second-app')]);
    expect(results.sort()).toEqual(['limit', 'written']);
    expect(toUsage(await run<UsageDbRow>(hibernationSql.usage(9101, 'none-such')))).toEqual({
      apps: 1,
      bytes: 4_321,
    });
  });
});
