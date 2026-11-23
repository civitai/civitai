import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  TEST_DATABASE_URL,
  holdAt,
  openScratch,
  runnerOn,
} from '~/server/services/commentv3/__tests__/two-connection-pg';

// Comment hides and their restore on separate connections of real Postgres: a lock is invisible
// to a single-connection database. The ToS set and clear race is in moderation.sql.behavior.

const { restoreScamCase, runScamCleanup } = await import('~/server/services/scam-cleanup.service');
const { setCommentFlags, prismaRunner } = await import('~/server/services/commentv3/write.service');

describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(TEST_DATABASE_URL, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('comment hides on two connections', () => {
  let db: Awaited<ReturnType<typeof openScratch>>;
  beforeAll(async () => {
    db = await openScratch('comment_hide_races');
  }, 60_000);
  afterAll(() => db?.close());
  beforeEach(() => db.reset());

  it('control: the lock probe sees a held row lock', async () => {
    await db.q(`INSERT INTO "CommentV3" (id, "userId") VALUES (1, 10)`);
    const held = holdAt(/^SELECT 1 AS hold/);
    const holder = dbMock.dbWrite.$transaction(async (tx: never) => {
      await prismaRunner(tx).query(`SELECT id FROM "CommentV3" WHERE id = 1 FOR UPDATE`);
      await prismaRunner(tx).query('SELECT 1 AS hold');
    });
    await held.reachedAt;
    const waiter = dbMock.dbWrite.$transaction((tx: never) =>
      prismaRunner(tx).query(`SELECT id FROM "CommentV3" WHERE id = 1 FOR UPDATE`)
    );
    try {
      expect(await db.lockWaitOrFinish(waiter)).toBe('waiting');
    } finally {
      held.release();
      await Promise.allSettled([holder, waiter]);
    }
  });

  it('an overturn leaves hidden a comment a moderator hid again on another connection', async () => {
    await db.q(`INSERT INTO "CommentV3" (id, "userId") VALUES (4, 10), (5, 10)`);
    const record = await runScamCleanup('comments', 10);
    expect([...(record?.ids ?? [])].sort()).toEqual([4, 5]);
    const other = await db.pool.connect();
    try {
      const mod = prismaRunner(runnerOn(other) as never);
      expect(await setCommentFlags(mod, [5], { hidden: false })).toHaveLength(1);
      expect(await setCommentFlags(mod, [5], { hidden: true })).toHaveLength(1);
    } finally {
      other.release();
    }
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: 10,
      type: 'scam',
      triggers: [{ cleanup: record }],
    } as never);
    expect(await restoreScamCase(1)).toEqual({ restored: 1 });
    expect(await db.q(`SELECT id, hidden FROM "CommentV3" ORDER BY id`)).toEqual([
      { id: 4, hidden: false },
      { id: 5, hidden: true },
    ]);
  });

  it('a moderator hide waits for an overturn in progress, and stands after it', async () => {
    await db.q(`INSERT INTO "CommentV3" (id, "userId") VALUES (6, 10)`);
    const record = await runScamCleanup('comments', 10);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: 10,
      type: 'scam',
      triggers: [{ cleanup: record }],
    } as never);
    // Hold the restore at its show, after it has chosen its rows.
    const held = holdAt(/^UPDATE "CommentV3" SET hidden/);
    const restore = restoreScamCase(1);
    await held.reachedAt;
    const hide = dbMock.dbWrite.$transaction((tx: never) =>
      setCommentFlags(prismaRunner(tx), [6], { hidden: true })
    );
    let outcome = 'unknown';
    try {
      outcome = await db.lockWaitOrFinish(hide);
    } finally {
      held.release();
      await Promise.allSettled([restore, hide]);
    }
    expect({
      hideWaited: outcome === 'waiting',
      ...(await db.one<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = 6`)),
    }).toEqual({ hideWaited: true, hidden: true });
  });
});
